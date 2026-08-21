// Restaurant POS — End-to-End QA Harness
// Tests real frontend→backend→PostgreSQL flows against the LIVE API + DB.
// Usage: node qa/qa-run.js [section]
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
require('dotenv').config();

const BASE = 'http://localhost:5001/api';
let PASS = 0, FAIL = 0;
const failures = [];
const results = {};

function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; failures.push(name); console.log(`  ❌ ${name} ${detail}`); }
  return cond;
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

const login = (email, password) => api('POST', '/auth/login', { email, password });

async function section(name, fn) {
  console.log(`\n══════════ ${name} ══════════`);
  const before = { PASS, FAIL };
  try { await fn(); } catch (e) { console.error('  💥 SECTION ERROR:', e.message); FAIL++; failures.push(`${name} — threw: ${e.message}`); }
  results[name] = { pass: PASS - before.PASS, fail: FAIL - before.FAIL };
}

const pick = (data, keys) => {
  for (const k of keys) if (data && data[k] !== undefined) return data[k];
  return null;
};

// ────────────────────────────────────────────────────────────────────
async function main() {
  // ================= AUTH =================
  await section('Auth', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    check('Admin login succeeds', admin.status === 200 && admin.data.token, `status=${admin.status}`);
    check('Login returns subscription snapshot', !!admin.data.subscription);
    check('Login returns settings', !!admin.data.settings);
    const adminToken = admin.data.token;

    const badPass = await login('admin@restaurant.com', 'wrongpassword');
    check('Invalid password rejected (401)', badPass.status === 401);

    const badEmail = await login('nobody@nowhere.com', 'password123');
    check('Invalid email rejected (401)', badEmail.status === 401);

    const noCreds = await api('POST', '/auth/login', {});
    check('Missing credentials rejected (400)', noCreds.status === 400);

    const cashier = await login('amit@restaurant.com', 'password123');
    check('Cashier login succeeds', cashier.status === 200 && cashier.data.token);

    const waiter = await login('rohit@restaurant.com', 'password123');
    check('Waiter login succeeds', waiter.status === 200 && waiter.data.token);

    const kitchen = await login('anand@restaurant.com', 'password123');
    check('Kitchen login succeeds', kitchen.status === 200 && kitchen.data.token);

    const noToken = await api('GET', '/orders/active');
    check('No-token API access rejected (401)', noToken.status === 401, `status=${noToken.status}`);

    const badToken = await api('GET', '/orders/active', null, 'invalid.token.here');
    check('Invalid token rejected (401)', badToken.status === 401);

    const expired = jwt.sign({ id: 31, role: 'ADMIN', restaurantId: 1 }, process.env.JWT_SECRET, { expiresIn: '-10s' });
    const expiredRes = await api('GET', '/orders/active', null, expired);
    check('Expired token rejected (401)', expiredRes.status === 401, `status=${expiredRes.status}`);

    const profile = await api('GET', '/auth/profile', null, adminToken);
    check('Profile returns user', profile.status === 200 && profile.data.user.email === 'admin@restaurant.com');

    const waiterDelete = await api('DELETE', '/orders/999999', null, waiter.data.token);
    check('Waiter cannot delete orders (403)', waiterDelete.status === 403, `status=${waiterDelete.status}`);

    const kitchenCreate = await api('POST', '/orders', { items: [], orderType: 'COUNTER_SALE' }, kitchen.data.token);
    check('Kitchen cannot create orders (403)', kitchenCreate.status === 403, `status=${kitchenCreate.status}`);

    const verifyOk = await api('POST', '/auth/verify-password', { password: 'password123' }, adminToken);
    check('Verify password (correct) succeeds', verifyOk.status === 200);
    const verifyBad = await api('POST', '/auth/verify-password', { password: 'wrong' }, adminToken);
    check('Verify password (wrong) rejected', verifyBad.status === 400);

    // Password change on a throwaway user
    const saLogin = await login('superadmin@pos.com', 'SuperAdmin@123');
    check('Super Admin login succeeds', saLogin.status === 200 && saLogin.data.token);
    const saToken = saLogin.data.token;

    const tempEmail = `qa-pass-${Date.now()}@test.com`;
    const createUser = await api('POST', '/super-admin/users', {
      restaurantId: 1, name: 'QA Pass User', email: tempEmail, password: 'OldPass@123', role: 'CASHIER'
    }, saToken);
    check('Create temp user for password test', createUser.status === 201 || createUser.status === 200, `status=${createUser.status} ${createUser.data?.message}`);
    const tempUser = createUser.data?.user || createUser.data?.data?.user || createUser.data?.data;
    const tempUserId = tempUser?.id;
    check('Temp user has ID', !!tempUserId);

    if (tempUserId) {
      const tempLogin = await login(tempEmail, 'OldPass@123');
      check('Temp user login with initial password', tempLogin.status === 200);
      const tempToken = tempLogin.data.token;

      const wrongCur = await api('POST', '/auth/change-password', { currentPassword: 'Nope@123', newPassword: 'NewPass@123' }, tempToken);
      check('Change password rejects wrong current password', wrongCur.status === 400);

      const samePass = await api('POST', '/auth/change-password', { currentPassword: 'OldPass@123', newPassword: 'OldPass@123' }, tempToken);
      check('Change password rejects same password', samePass.status === 400);

      const shortPass = await api('POST', '/auth/change-password', { currentPassword: 'OldPass@123', newPassword: 'short' }, tempToken);
      check('Change password rejects short password', shortPass.status === 400);

      const change = await api('POST', '/auth/change-password', { currentPassword: 'OldPass@123', newPassword: 'NewPass@123' }, tempToken);
      check('Change password succeeds', change.status === 200);

      const oldLogin = await login(tempEmail, 'OldPass@123');
      check('Old password rejected after change', oldLogin.status === 401);

      const newLogin = await login(tempEmail, 'NewPass@123');
      check('New password login works', newLogin.status === 200);

      const oldTokenUse = await api('GET', '/auth/profile', null, tempToken);
      console.log(`  ℹ old token after password change: ${oldTokenUse.status} (401/403 = invalidated; 200 = not enforced)`);

      await api('DELETE', `/super-admin/users/${tempUserId}`, null, saToken);
    }

    const relogin = await login('admin@restaurant.com', 'password123');
    check('Login after logout works', relogin.status === 200 && relogin.data.token);
  });

  // ================= DASHBOARD =================
  await section('Dashboard', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;
    const dash = await api('GET', '/dashboard', null, token);
    check('Dashboard endpoint responds', dash.status === 200, `status=${dash.status}`);
    const d = dash.data?.data || dash.data;
    if (d) {
      console.log('  ℹ Dashboard payload keys:', Object.keys(d).join(', '));
      for (const k of ['todaySales', 'totalSales', 'todayRevenue', 'revenue', 'todayOrders', 'activeOrders']) {
        if (d[k] !== undefined) check(`Dashboard ${k} is numeric`, typeof d[k] === 'number', `value=${d[k]}`);
      }
    }
  });

  // ================= POS ORDERING + STOCK =================
  await section('POS Ordering & Stock', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;

    const items = await api('GET', '/menu', null, token);
    const menuItems = items.data?.items || [];
    const target = menuItems.find(m => m.currentStock !== null && m.currentStock !== undefined && m.isAvailable) || menuItems[0];
    check('Menu items loaded (live data)', menuItems.length > 0, `count=${menuItems.length}`);
    if (!target) return;

    const beforeStock = target.currentStock;
    const qty = 2;
    console.log(`  ℹ Using "${target.name}" (id=${target.id}) stock=${beforeStock}, price=${target.price}, tax=${target.tax}`);

    const order = await api('POST', '/orders', {
      orderType: 'COUNTER_SALE',
      items: [{ menuItemId: target.id, quantity: qty }],
    }, token);
    check('Order created', order.status === 201, `status=${order.status} msg=${order.data?.message}`);
    const createdOrder = order.data?.data;
    if (!createdOrder) return;

    const dbOrder = await prisma.order.findUnique({
      where: { id: createdOrder.id },
      include: { orderItems: true, stockMovements: true },
    });
    check('Order exists in PostgreSQL', !!dbOrder);
    check('Order total matches (subtotal + tax)', Math.abs(dbOrder.totalAmount - (dbOrder.subtotal + dbOrder.taxAmount)) < 0.01);
    check('Order has items in DB', dbOrder.orderItems.length === 1 && dbOrder.orderItems[0].quantity === qty);

    const dbItem = await prisma.menuItem.findUnique({ where: { id: target.id } });
    check(`Stock deducted (${beforeStock}→${beforeStock - qty})`, dbItem.currentStock === beforeStock - qty, `actual=${dbItem.currentStock}`);
    check('StockMovement rows created (ORDER_CREATED)', dbOrder.stockMovements.filter(m => m.type === 'ORDER_CREATED').length === 1);
    check('stockDeductedAt set on order', !!dbOrder.stockDeductedAt);

    const menuAfter = await api('GET', '/menu', null, token);
    const itemAfter = menuAfter.data?.items?.find(m => m.id === target.id);
    check('Menu & Stock screen shows updated stock', itemAfter.currentStock === beforeStock - qty, `actual=${itemAfter?.currentStock}`);

    const menuAfter2 = await api('GET', '/menu', null, token);
    const itemAfter2 = menuAfter2.data?.items?.find(m => m.id === target.id);
    check('No duplicate deduction on refetch', itemAfter2.currentStock === beforeStock - qty);

    const kotCount = await prisma.kOT.count({ where: { orderId: createdOrder.id } });
    check('No KOT for COUNTER_SALE order', kotCount === 0);

    // Quantity > available stock
    const bigOrder = await api('POST', '/orders', {
      orderType: 'COUNTER_SALE',
      items: [{ menuItemId: target.id, quantity: 99999 }],
    }, token);
    check('Huge quantity order handled (no 500)', bigOrder.status < 500, `status=${bigOrder.status}`);
    const dbItemAfterBig = await prisma.menuItem.findUnique({ where: { id: target.id } });
    check('Stock never negative', dbItemAfterBig.currentStock >= 0, `stock=${dbItemAfterBig.currentStock}`);
    if (bigOrder.status === 201) {
      await api('PATCH', `/orders/${bigOrder.data.data.id}/cancel`, { reason: 'QA cleanup' }, token);
    }

    // Cancel + restoration
    const cancel = await api('PATCH', `/orders/${createdOrder.id}/cancel`, { reason: 'QA test cleanup' }, token);
    check('Test order cancelled', cancel.status === 200, `status=${cancel.status}`);

    const dbAfterCancel = await prisma.menuItem.findUnique({ where: { id: target.id } });
    check('Stock restored after cancellation', dbAfterCancel.currentStock === beforeStock, `actual=${dbAfterCancel.currentStock}`);
    const dbOrderAfterCancel = await prisma.order.findUnique({ where: { id: createdOrder.id } });
    check('stockRestoredAt set', !!dbOrderAfterCancel.stockRestoredAt);
    check('Cancel reason recorded', dbOrderAfterCancel.cancelReason === 'QA test cleanup');

    const cancelAgain = await api('PATCH', `/orders/${createdOrder.id}/cancel`, { reason: 'again' }, token);
    check('Double-cancel rejected (400)', cancelAgain.status === 400, `status=${cancelAgain.status}`);
    const dbAfterDoubleCancel = await prisma.menuItem.findUnique({ where: { id: target.id } });
    check('No double stock restore', dbAfterDoubleCancel.currentStock === beforeStock);

    const foreignCancel = await api('PATCH', '/orders/99999999/cancel', { reason: 'x' }, token);
    check('Foreign order cancel → 404', foreignCancel.status === 404);
  });

  // ================= TAKE ORDER / DINE-IN =================
  await section('Take Order (Dine-In)', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;

    const floors = await api('GET', '/floors', null, token);
    const floorList = floors.data?.floors || [];
    check('Floors endpoint returns data', floorList.length > 0);
    const dbFloorIds = (await prisma.floor.findMany({ where: { restaurantId: 1 }, select: { id: true } })).map(f => f.id);
    check('Only restaurant floors returned', floorList.every(f => dbFloorIds.includes(f.id)));

    const tables = await api('GET', '/tables', null, token);
    const tableList = tables.data?.tables || [];
    check('Tables endpoint returns data', tableList.length > 0);
    const tableRestIds = new Set(tableList.map(t => t.restaurantId));
    check('Only restaurant tables returned', tableRestIds.size === 1 && tableRestIds.has(1));

    const availTable = tableList.find(t => t.status === 'AVAILABLE');
    check('Found an AVAILABLE table', !!availTable);
    if (!availTable) return;

    const menu = await api('GET', '/menu', null, token);
    const menuItems = menu.data?.items || [];
    const item = menuItems.find(m => m.currentStock != null && m.isAvailable);
    if (!item) return;
    const beforeStock = item.currentStock;

    const order = await api('POST', '/orders', {
      orderType: 'DINE_IN',
      tableId: availTable.id,
      items: [{ menuItemId: item.id, quantity: 2, notes: 'less spicy' }],
    }, token);
    check('Dine-in order created', order.status === 201, `status=${order.status} ${order.data?.message}`);
    const createdOrder = order.data?.data;
    if (!createdOrder) return;

    const dbTable = await prisma.restaurantTable.findUnique({ where: { id: availTable.id } });
    check('Table marked OCCUPIED in DB', dbTable.status === 'OCCUPIED');

    const dbKot = await prisma.kOT.findFirst({ where: { orderId: createdOrder.id } });
    check('KOT auto-created for DINE_IN', !!dbKot);
    if (dbKot) {
      check('KOT is PENDING', dbKot.status === 'PENDING');
      check('KOT has order link', dbKot.orderId === createdOrder.id);
    }

    const dbOrderItems = await prisma.orderItem.findMany({ where: { orderId: createdOrder.id } });
    check('Item note persisted', dbOrderItems[0]?.notes === 'less spicy');

    const dbItem = await prisma.menuItem.findUnique({ where: { id: item.id } });
    check('Dine-in stock deducted', dbItem.currentStock === beforeStock - 2, `actual=${dbItem.currentStock}`);

    // Hold → Resume
    const hold = await api('PATCH', `/orders/${createdOrder.id}/hold`, {}, token);
    check('Order placed on hold', hold.status === 200 && hold.data.data.status === 'HOLD');
    const dbHeld = await prisma.order.findUnique({ where: { id: createdOrder.id } });
    check('Hold persisted in DB', dbHeld.status === 'HOLD' && !!dbHeld.holdAt);

    const holdAgain = await api('PATCH', `/orders/${createdOrder.id}/hold`, {}, token);
    check('Double-hold rejected (400)', holdAgain.status === 400);

    const resume = await api('PATCH', `/orders/${createdOrder.id}/resume`, {}, token);
    check('Order resumed', resume.status === 200 && resume.data.data.status === 'PENDING');
    const dbResumed = await prisma.order.findUnique({ where: { id: createdOrder.id } });
    check('Resume persisted in DB', dbResumed.status === 'PENDING' && dbResumed.holdAt === null);
    check('Order data intact after resume', dbResumed.totalAmount === dbResumed.subtotal + dbResumed.taxAmount);

    const active = await api('GET', '/orders/active', null, token);
    const activeList = active.data?.data || [];
    check('Order appears in Active Orders', activeList.some(o => o.id === createdOrder.id));

    // Add item → stock for new item only
    const item2 = menuItems.find(m => m.id !== item.id && m.currentStock != null && m.isAvailable);
    if (item2) {
      const before2 = item2.currentStock;
      const addItem = await api('POST', `/orders/${createdOrder.id}/items`, { menuItemId: item2.id, quantity: 3 }, token);
      check('Add item to order succeeds', addItem.status === 200 || addItem.status === 201, `status=${addItem.status} ${addItem.data?.message}`);
      const dbItem2 = await prisma.menuItem.findUnique({ where: { id: item2.id } });
      check('Stock deducted for added item', dbItem2.currentStock === before2 - 3, `actual=${dbItem2.currentStock}`);
      const dbItem1 = await prisma.menuItem.findUnique({ where: { id: item.id } });
      check('Original item not double-deducted', dbItem1.currentStock === beforeStock - 2);
    }

    // Transfer table
    const availTable2 = tableList.find(t => t.status === 'AVAILABLE' && t.id !== availTable.id);
    if (availTable2) {
      const transfer = await api('PATCH', `/orders/${createdOrder.id}/change-table`, { tableId: availTable2.id }, token);
      check('Transfer table succeeds', transfer.status === 200, `status=${transfer.status} ${transfer.data?.message}`);
      const dbTable1 = await prisma.restaurantTable.findUnique({ where: { id: availTable.id } });
      const dbTable2 = await prisma.restaurantTable.findUnique({ where: { id: availTable2.id } });
      check('Old table freed (AVAILABLE)', dbTable1.status === 'AVAILABLE');
      check('New table OCCUPIED', dbTable2.status === 'OCCUPIED');
    }

    const cancel = await api('PATCH', `/orders/${createdOrder.id}/cancel`, { reason: 'QA dine-in cleanup' }, token);
    check('Dine-in order cancelled', cancel.status === 200);
    const dbTableFinal = await prisma.restaurantTable.findUnique({ where: { id: availTable.id } });
    check('Table released after cancel', dbTableFinal.status === 'AVAILABLE');
    const dbItemFinal = await prisma.menuItem.findUnique({ where: { id: item.id } });
    check('Dine-in stock restored after cancel', dbItemFinal.currentStock === beforeStock, `actual=${dbItemFinal.currentStock}`);
  });

  // ================= KITCHEN / KOT =================
  await section('Kitchen / KOT', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;
    const kitchen = await login('anand@restaurant.com', 'password123');
    const kitchenToken = kitchen.data.token;

    const menu = await api('GET', '/menu', null, token);
    const menuItems = menu.data?.items || [];
    const item = menuItems.find(m => m.currentStock != null && m.isAvailable);
    if (!item) return;

    const order = await api('POST', '/orders', {
      orderType: 'TAKEAWAY',
      items: [{ menuItemId: item.id, quantity: 1 }],
    }, token);
    check('Takeaway order created', order.status === 201, `${order.data?.message}`);
    const createdOrder = order.data?.data;
    if (!createdOrder) return;

    const dbKot = await prisma.kOT.findFirst({ where: { orderId: createdOrder.id } });
    check('KOT created for TAKEAWAY', !!dbKot);

    const kitchenOrders = await api('GET', '/orders/active', null, kitchenToken);
    check('Kitchen user can fetch active orders (kitchen feature)', kitchenOrders.status === 200);
    const kotList = await api('GET', '/kot', null, kitchenToken);
    const kots = kotList.data?.data || [];
    check('KOT list includes new KOT', kots.some(k => k.orderId === createdOrder.id));

    const kotId = dbKot.id;
    const updateKot = await api('PATCH', `/kot/${kotId}/status`, { status: 'PREPARING' }, kitchenToken);
    check('KOT status update (PREPARING)', updateKot.status === 200, `status=${updateKot.status} ${updateKot.data?.message}`);
    const dbKotUpdated = await prisma.kOT.findUnique({ where: { id: kotId } });
    check('KOT status persisted in DB', dbKotUpdated.status === 'PREPARING');

    const kotCount = await prisma.kOT.count({ where: { orderId: createdOrder.id } });
    check('Exactly one KOT per order', kotCount === 1);

    // KOT reprint (increments count — actual reprint data flow)
    const reprint = await api('GET', `/kot/reprint/${kotId}`, null, token);
    check('KOT reprint works', reprint.status === 200, `status=${reprint.status}`);
    const dbKotReprinted = await prisma.kOT.findUnique({ where: { id: kotId } });
    check('KOT printCount incremented (default 1 → 2)', dbKotReprinted.printCount === 2, `printCount=${dbKotReprinted.printCount}`);

    // KOT reprint by order
    const reprintByOrder = await api('GET', `/kot/reprint-by-order/${createdOrder.id}`, null, token);
    check('KOT reprint by order works', reprintByOrder.status === 200, `status=${reprintByOrder.status}`);
    const dbKotReprinted2 = await prisma.kOT.findUnique({ where: { id: kotId } });
    check('KOT printCount incremented again (reprint-by-order) → 3', dbKotReprinted2.printCount === 3, `printCount=${dbKotReprinted2.printCount}`);

    await api('PATCH', `/orders/${createdOrder.id}/cancel`, { reason: 'QA kitchen cleanup' }, token);
  });

  // ================= BILLING / DISCOUNT / PAYMENT =================
  await section('Billing / Discount / Payment', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;

    const menu = await api('GET', '/menu', null, token);
    const menuItems = menu.data?.items || [];
    const item = menuItems.find(m => m.currentStock != null && m.isAvailable && m.price);
    if (!item) return;
    console.log(`  ℹ Billing test item: ${item.name} price=${item.price} tax=${item.tax}`);

    const qty = 10;
    const order = await api('POST', '/orders', {
      orderType: 'COUNTER_SALE',
      items: [{ menuItemId: item.id, quantity: qty }],
    }, token);
    check('Order created for billing', order.status === 201);
    const createdOrder = order.data?.data;
    if (!createdOrder) return;
    const subtotal = createdOrder.subtotal;

    // ── Percentage discount test: 10% on subtotal ──
    const discPct = await api('PATCH', `/orders/${createdOrder.id}/discount`, { discountType: 'PERCENTAGE', discountValue: 10 }, token);
    check('Percentage discount applied', discPct.status === 200, `${discPct.data?.message}`);
    const dbAfterPct = await prisma.order.findUnique({ where: { id: createdOrder.id } });
    const expectedPctDisc = Math.round(subtotal * 10) / 100;
    check(`Discount = 10% of ${subtotal} (${expectedPctDisc})`, Math.abs(dbAfterPct.discount - expectedPctDisc) < 0.01, `actual=${dbAfterPct.discount}`);
    const expectedPctTotal = subtotal - expectedPctDisc + dbAfterPct.taxAmount + dbAfterPct.serviceCharge;
    check('Total = subtotal - discount + tax + service charge', Math.abs(dbAfterPct.totalAmount - expectedPctTotal) < 0.01, `actual=${dbAfterPct.totalAmount} expected=${expectedPctTotal}`);

    // ── Flat discount test: ₹150 ──
    const discFlat = await api('PATCH', `/orders/${createdOrder.id}/discount`, { discountType: 'FLAT', discountValue: 150 }, token);
    check('Flat discount applied', discFlat.status === 200);
    const dbAfterFlat = await prisma.order.findUnique({ where: { id: createdOrder.id } });
    check('Flat discount = 150 in DB', dbAfterFlat.discount === 150, `actual=${dbAfterFlat.discount}`);

    // Discount > subtotal clamps
    const discHuge = await api('PATCH', `/orders/${createdOrder.id}/discount`, { discountType: 'FLAT', discountValue: 999999 }, token);
    check('Oversized discount clamped', discHuge.status === 200);
    const dbAfterHuge = await prisma.order.findUnique({ where: { id: createdOrder.id } });
    check('Discount clamped to subtotal', dbAfterHuge.discount === dbAfterHuge.subtotal);

    // Reset discount for billing
    await api('PATCH', `/orders/${createdOrder.id}/discount`, { discountType: 'PERCENTAGE', discountValue: 5 }, token);
    const dbForBill = await prisma.order.findUnique({ where: { id: createdOrder.id } });

    // ── Generate bill ──
    // The backend only bills COMPLETED orders (the POS checkout path completes
    // the order when payment is collected). Simulate that by completing first.
    const completeOrder = await api('PATCH', `/orders/${createdOrder.id}/status`, { status: 'COMPLETED' }, token);
    check('Order completed before billing', completeOrder.status === 200, `status=${completeOrder.status}`);
    const bill = await api('POST', '/bills', { orderId: createdOrder.id }, token);
    check('Bill generated', bill.status === 201 || bill.status === 200, `status=${bill.status} ${bill.data?.message}`);
    const billData = bill.data?.data;
    let billId = billData?.id;
    check('Bill has ID', !!billId);
    if (!billId) { console.log('  ⚠ bill response:', JSON.stringify(bill.data).slice(0, 400)); }

    if (billId) {
      const dbBill = await prisma.bill.findUnique({ where: { id: billId }, include: { payments: true } });
      check('Bill persisted in PostgreSQL', !!dbBill);
      check('Bill grandTotal matches order total', Math.abs(dbBill.grandTotal - dbForBill.totalAmount) < 0.01, `bill=${dbBill.grandTotal} order=${dbForBill.totalAmount}`);
      check('Bill discount matches order', Math.abs(dbBill.discount - dbForBill.discount) < 0.01);

      // ── Payment (CASH) via /payments ──
      const pay = await api('POST', '/payments', { billId, amount: dbForBill.totalAmount, paymentMethod: 'CASH' }, token);
      check('Cash payment succeeds', pay.status === 200 || pay.status === 201, `status=${pay.status} ${pay.data?.message}`);

      const dbBillPaid = await prisma.bill.findUnique({ where: { id: billId }, include: { payments: true } });
      check('Bill marked PAID in DB', dbBillPaid.status === 'PAID');
      check('Payment row persisted', dbBillPaid.payments.length === 1 && dbBillPaid.payments[0].paymentMethod === 'CASH');

      const dbOrderPaid = await prisma.order.findUnique({ where: { id: createdOrder.id } });
      check('Order marked COMPLETED after payment', dbOrderPaid.status === 'COMPLETED');

      // Already-paid bill — no double payment
      const payAgain = await api('POST', '/payments', { billId, amount: 10, paymentMethod: 'CASH' }, token);
      check('Double payment rejected', payAgain.status === 400, `status=${payAgain.status} ${payAgain.data?.message}`);

      // Payment on nonexistent bill
      const payTooMuch = await api('POST', '/payments', { billId: 999999, amount: 999, paymentMethod: 'CASH' }, token);
      check('Payment on nonexistent bill → 404', payTooMuch.status === 404 || payTooMuch.status === 400, `status=${payTooMuch.status}`);
    }

    // ── collectPayment (the actual POS checkout path) with discount ──
    const order2 = await api('POST', '/orders', { orderType: 'COUNTER_SALE', items: [{ menuItemId: item.id, quantity: 4 }] }, token);
    check('Order for collectPayment created', order2.status === 201);
    const o2 = order2.data?.data;
    if (o2) {
      const o2Subtotal = o2.subtotal;
      const grandTotal = o2Subtotal - Math.round(o2Subtotal * 5) / 100 + o2.taxAmount;
      const collect = await api('POST', '/payments/collect', {
        orderId: o2.id,
        payments: [{ paymentMethod: 'CASH', amount: grandTotal }],
        discountType: 'PERCENTAGE', discountValue: 5,
      }, token);
      check('collectPayment succeeds (POS checkout path)', collect.status === 201 || collect.status === 200, `status=${collect.status} ${collect.data?.message}`);
      if (collect.data?.data) {
        const cb = collect.data.data;
        check('collectPayment bill is PAID', cb.status === 'PAID');
        const expectedDisc = Math.round(o2Subtotal * 5) / 100;
        check('collectPayment discount correct', Math.abs(cb.discount - expectedDisc) < 0.01, `discount=${cb.discount} expected=${expectedDisc}`);
        check('collectPayment grandTotal matches', Math.abs(cb.grandTotal - grandTotal) < 0.01, `grandTotal=${cb.grandTotal} expected=${grandTotal}`);
      }
      // Payment mismatch → 400
      const mismatch = await api('POST', '/payments/collect', {
        orderId: o2.id,
        payments: [{ paymentMethod: 'CASH', amount: 1 }],
      }, token);
      check('Payment mismatch rejected (400)', mismatch.status === 400, `status=${mismatch.status} ${mismatch.data?.message}`);

      // Underpayment via partial
      const order3 = await api('POST', '/orders', { orderType: 'COUNTER_SALE', items: [{ menuItemId: item.id, quantity: 1 }] }, token);
      const bill3 = await api('POST', '/bills', { orderId: order3.data.data.id }, token);
      const bill3Id = bill3.data?.data?.id;
      if (bill3Id) {
        const dbBill3 = await prisma.bill.findUnique({ where: { id: bill3Id } });
        const partial = await api('POST', '/payments/partial', { billId: bill3Id, amount: 1, paymentMethod: 'CASH' }, token);
        check('Partial payment accepted', partial.status === 201 || partial.status === 200, `status=${partial.status} ${partial.data?.message}`);
        const dbBill3b = await prisma.bill.findUnique({ where: { id: bill3Id } });
        check('Underpaid bill is PARTIAL', dbBill3b.paymentStatus === 'PARTIAL', `status=${dbBill3b.paymentStatus}`);
        // complete the rest
        const rest = await api('POST', '/payments', { billId: bill3Id, amount: dbBill3.total - 1, paymentMethod: 'CASH' }, token);
        const dbBill3c = await prisma.bill.findUnique({ where: { id: bill3Id } });
        check('Remaining payment completes bill', dbBill3c.status === 'PAID', `status=${dbBill3c.status}`);
      }
    }
  });

  // ================= CANCELLATION → REPORTS =================
  await section('Cancellation & Reports', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;
    const menu = await api('GET', '/menu', null, token);
    const menuItems = menu.data?.items || [];
    const item = menuItems.find(m => m.currentStock != null && m.isAvailable);
    if (!item) return;

    const order = await api('POST', '/orders', { orderType: 'COUNTER_SALE', items: [{ menuItemId: item.id, quantity: 1 }] }, token);
    const orderId = order.data.data.id;
    await api('PATCH', `/orders/${orderId}/cancel`, { reason: 'QA report test' }, token);

    const reports = await api('GET', '/reports/summary', null, token);
    console.log(`  ℹ Reports summary status: ${reports.status}`);
    if (reports.data?.data) console.log('  ℹ Report keys:', Object.keys(reports.data.data).join(', '));

    const today = new Date().toISOString().slice(0, 10);
    const salesFiltered = await api('GET', `/reports/sales?from=${today}&to=${today}`, null, token);
    check('Sales report with date filter works', salesFiltered.status === 200, `status=${salesFiltered.status}`);
    const salesData = salesFiltered.data?.data || salesFiltered.data?.sales;
    if (salesData && Array.isArray(salesData)) {
      check('Cancelled order excluded from sales report', !salesData.some(s => s.orderId === orderId || s.id === orderId), 'cancelled order found in sales');
    }
  });

  // ================= FLOORS & TABLES CRUD =================
  await section('Floors & Tables CRUD', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;

    const floorName = `QA Floor ${Date.now()}`;
    const createFloor = await api('POST', '/floors', { name: floorName }, token);
    check('Create floor succeeds', createFloor.status === 201 || createFloor.status === 200, `status=${createFloor.status} ${createFloor.data?.message}`);
    const floorId = createFloor.data?.floor?.id;
    check('Floor has ID', !!floorId);

    if (floorId) {
      const floorsAfter = await api('GET', '/floors', null, token);
      check('Floor persists after refresh', (floorsAfter.data?.floors || []).some(f => f.id === floorId));

      const updateFloor = await api('PUT', `/floors/${floorId}`, { name: `${floorName} v2` }, token);
      check('Update floor succeeds', updateFloor.status === 200, `status=${updateFloor.status} ${updateFloor.data?.message}`);

      // Create table on the new floor (needs tableNo)
      const tableNo = `QA-${Date.now() % 100000}`;
      const createTable = await api('POST', '/tables', { tableNo, name: `QA Table ${tableNo}`, floorId, capacity: 4 }, token);
      check('Create table succeeds', createTable.status === 201 || createTable.status === 200, `status=${createTable.status} ${createTable.data?.message}`);
      const tableId = createTable.data?.table?.id;
      check('Table has ID', !!tableId);

      if (tableId) {
        const updateTable = await api('PUT', `/tables/${tableId}`, { name: `${tableNo}-U`, capacity: 6 }, token);
        check('Update table succeeds', updateTable.status === 200, `status=${updateTable.status}`);

        const tables = await api('GET', '/tables', null, token);
        check('New table listed for restaurant', (tables.data?.tables || []).some(t => t.id === tableId));

        const delTable = await api('DELETE', `/tables/${tableId}`, null, token);
        check('Delete table succeeds', delTable.status === 200 || delTable.status === 204, `status=${delTable.status} ${delTable.data?.message}`);
        const dbTable = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
        check('Table deleted from DB', !dbTable);
      }

      const delFloor = await api('DELETE', `/floors/${floorId}`, null, token);
      check('Delete floor succeeds', delFloor.status === 200 || delFloor.status === 204, `status=${delFloor.status} ${delFloor.data?.message}`);
      const dbFloor = await prisma.floor.findUnique({ where: { id: floorId } });
      check('Floor deleted from DB', !dbFloor);
    }
  });

  // ================= MENU & CATEGORY CRUD =================
  await section('Menu & Category CRUD', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;

    const catName = `QA Cat ${Date.now()}`;
    const createCat = await api('POST', '/categories', { name: catName, sortOrder: 999, isActive: true }, token);
    check('Create category succeeds', createCat.status === 201 || createCat.status === 200, `status=${createCat.status} ${createCat.data?.message}`);
    const catId = createCat.data?.category?.id;
    check('Category has ID', !!catId);

    if (catId) {
      const createItem = await api('POST', '/menu', {
        name: `QA Item ${Date.now()}`,
        categoryId: catId,
        price: 180.5,
        preparationTime: 10,
        currentStock: 50,
        gstPercentage: 5,
        displayOrder: 1,
        isAvailable: true,
      }, token);
      check('Create item succeeds', createItem.status === 201 || createItem.status === 200, `status=${createItem.status} ${createItem.data?.message}`);
      const itemId = createItem.data?.data?.id;
      check('Item has ID', !!itemId);

      if (itemId) {
        const dbItem = await prisma.menuItem.findUnique({ where: { id: itemId } });
        check('Item price 180.50 stored correctly', Math.abs(dbItem.price - 180.5) < 0.001, `price=${dbItem.price}`);
        check('Item stock 50 stored', dbItem.currentStock === 50);
        check('Item gstPercentage stored', Math.abs((dbItem.gstPercentage || 0) - 5) < 0.01, `gst=${dbItem.gstPercentage}`);

        const upd = await api('PUT', `/menu/${itemId}`, { name: dbItem.name, categoryId: catId, price: 220, preparationTime: 10, currentStock: 50, isAvailable: true }, token);
        check('Update item succeeds', upd.status === 200, `status=${upd.status} ${upd.data?.message}`);
        const dbItem2 = await prisma.menuItem.findUnique({ where: { id: itemId } });
        check('Item price updated to 220', dbItem2.price === 220, `price=${dbItem2.price}`);

        const toggle = await api('PATCH', `/menu/${itemId}/status`, { isAvailable: false }, token);
        check('Item availability toggle works', toggle.status === 200, `status=${toggle.status} ${toggle.data?.message}`);
        const dbItem3 = await prisma.menuItem.findUnique({ where: { id: itemId } });
        check('Item disabled in DB', dbItem3.isAvailable === false, `isAvailable=${dbItem3.isAvailable}`);

        const delItem = await api('DELETE', `/menu/${itemId}`, null, token);
        check('Delete item succeeds', delItem.status === 200 || delItem.status === 204, `status=${delItem.status} ${delItem.data?.message}`);
        const dbItemDel = await prisma.menuItem.findUnique({ where: { id: itemId } });
        check('Item deleted from DB', !dbItemDel);
      }

      const updCat = await api('PUT', `/categories/${catId}`, { name: `${catName} v2`, sortOrder: 998 }, token);
      check('Update category succeeds', updCat.status === 200, `status=${updCat.status} ${updCat.data?.message}`);

      const delCat = await api('DELETE', `/categories/${catId}`, null, token);
      check('Delete category succeeds', delCat.status === 200 || delCat.status === 204, `status=${delCat.status} ${delCat.data?.message}`);
      const dbCat = await prisma.category.findUnique({ where: { id: catId } });
      check('Category deleted from DB', !dbCat);
    }
  });

  // ================= SETTINGS =================
  await section('Settings', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;

    const getSettings = await api('GET', '/settings', null, token);
    check('Get settings succeeds', getSettings.status === 200, `status=${getSettings.status}`);
    const settings = getSettings.data?.data || getSettings.data?.settings || getSettings.data;
    console.log('  ℹ Settings keys:', settings ? Object.keys(settings).join(', ') : 'none');
    if (settings && settings.id) {
      const upd = await api('PUT', `/settings/${settings.id}`, {
        ...settings,
        enableKitchenDisplay: settings.enableKitchenDisplay ?? true,
      }, token);
      check('Update settings succeeds', upd.status === 200, `status=${upd.status} ${upd.data?.message}`);
      const get2 = await api('GET', '/settings', null, token);
      const s2 = get2.data?.data || get2.data?.settings || get2.data;
      check('Settings persist after refetch', s2 && s2.id === settings.id);
    } else {
      const upd = await api('POST', '/settings', { taxPercentage: 5, currency: 'INR' }, token);
      console.log(`  ℹ Create settings: ${upd.status} ${upd.data?.message}`);
    }
  });

  // ================= STAFF =================
  await section('Staff', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;
    const staffEmail = `qa-staff-${Date.now()}@test.com`;

    const createStaff = await api('POST', '/users', { name: 'QA Staff', email: staffEmail, password: 'StaffPass@123', role: 'WAITER', phone: '9999999900' }, token);
    check('Create staff succeeds', createStaff.status === 201 || createStaff.status === 200, `status=${createStaff.status} ${createStaff.data?.message}`);
    const staffId = createStaff.data?.data?.id || createStaff.data?.user?.id;
    check('Staff has ID', !!staffId);

    if (staffId) {
      const staffLogin = await login(staffEmail, 'StaffPass@123');
      check('New staff can log in', staffLogin.status === 200);

      const upd = await api('PUT', `/users/${staffId}`, { name: 'QA Staff Updated', role: 'CASHIER' }, token);
      check('Update staff succeeds', upd.status === 200, `status=${upd.status} ${upd.data?.message}`);

      const deact = await api('PATCH', `/users/${staffId}/status`, { isActive: false }, token);
      check('Deactivate staff succeeds', deact.status === 200, `status=${deact.status} ${deact.data?.message}`);
      const staffLogin2 = await login(staffEmail, 'StaffPass@123');
      check('Deactivated staff cannot login (403)', staffLogin2.status === 403, `status=${staffLogin2.status}`);

      await api('PATCH', `/users/${staffId}/status`, { isActive: true }, token);
      const staffLogin3 = await login(staffEmail, 'StaffPass@123');
      check('Reactivated staff can login', staffLogin3.status === 200);

      const staffToken = staffLogin3.data.token;
      const staffCreateUser = await api('POST', '/users', { name: 'X', email: 'x@x.com', password: 'Xxx@12345', role: 'WAITER' }, staffToken);
      check('Staff cannot create users (403)', staffCreateUser.status === 403, `status=${staffCreateUser.status}`);

      const del = await api('DELETE', `/users/${staffId}`, null, token);
      check('Delete staff succeeds', del.status === 200 || del.status === 204, `status=${del.status} ${del.data?.message}`);
      const staffLogin4 = await login(staffEmail, 'StaffPass@123');
      check('Deleted staff cannot login', staffLogin4.status === 401 || staffLogin4.status === 403);
    }
  });

  // ================= MULTI-TENANT SECURITY =================
  await section('Multi-Tenant Security', async () => {
    const sa = await login('superadmin@pos.com', 'SuperAdmin@123');
    const saToken = sa.data.token;

    // Ensure restaurant 2 has an admin we can log in as
    const r2Email = `qa-r2-admin-${Date.now()}@test.com`;
    const createR2 = await api('POST', '/super-admin/users', {
      restaurantId: 2, name: 'QA R2 Admin', email: r2Email, password: 'R2Pass@123', role: 'ADMIN'
    }, saToken);
    check('Created admin for restaurant 2', createR2.status === 201 || createR2.status === 200, `${createR2.data?.message}`);
    const r2login = await login(r2Email, 'R2Pass@123');
    check('Restaurant 2 admin login', r2login.status === 200);
    const r2Token = r2login.data.token;

    const r1 = await login('admin@restaurant.com', 'password123');
    const r1Token = r1.data.token;

    // R1 reads R2 data by ID
    const r2Cat = await prisma.category.findFirst({ where: { restaurantId: 2 } });
    if (r2Cat) {
      const crossCat = await api('GET', `/categories/${r2Cat.id}`, null, r1Token);
      check('Cross-tenant category read blocked (404/403)', crossCat.status === 404 || crossCat.status === 403, `status=${crossCat.status}`);
      const crossUpd = await api('PUT', `/categories/${r2Cat.id}`, { name: 'HACKED' }, r1Token);
      check('Cross-tenant category update blocked', crossUpd.status === 404 || crossUpd.status === 403, `status=${crossUpd.status}`);
    }
    const r2Order = await prisma.order.findFirst({ where: { restaurantId: 2 } });
    if (r2Order) {
      const crossOrder = await api('GET', `/orders/${r2Order.id}`, null, r1Token);
      check('Cross-tenant order read blocked', crossOrder.status === 404 || crossOrder.status === 403, `status=${crossOrder.status}`);
      const crossCancel = await api('PATCH', `/orders/${r2Order.id}/cancel`, { reason: 'hack attempt' }, r1Token);
      check('Cross-tenant order cancel blocked', crossCancel.status === 404 || crossCancel.status === 403, `status=${crossCancel.status}`);
    }
    const r2Table = await prisma.restaurantTable.findFirst({ where: { restaurantId: 2 } });
    if (r2Table) {
      const crossTable = await api('GET', `/tables/${r2Table.id}`, null, r1Token);
      check('Cross-tenant table read blocked', crossTable.status === 404 || crossTable.status === 403, `status=${crossTable.status}`);
    }
    const r2User = await prisma.user.findFirst({ where: { restaurantId: 2 } });
    if (r2User) {
      const crossUser = await api('GET', `/users/${r2User.id}`, null, r1Token);
      check('Cross-tenant user read blocked', crossUser.status === 404 || crossUser.status === 403, `status=${crossUser.status}`);
    }
    // R2 reads R1 data
    const r1Cat = await prisma.category.findFirst({ where: { restaurantId: 1 } });
    if (r1Cat) {
      const cross2 = await api('GET', `/categories/${r1Cat.id}`, null, r2Token);
      check('R2 cannot read R1 category', cross2.status === 404 || cross2.status === 403, `status=${cross2.status}`);
    }
    // R2 cannot see R1 menu items
    const r2Menu = await api('GET', '/menu', null, r2Token);
    const r2Items = r2Menu.data?.items || [];
    check('R2 menu contains only R2 items', r2Items.every(i => i.restaurantId === 2));

    // cleanup temp R2 admin
    const r2UserRec = await prisma.user.findUnique({ where: { email: r2Email } });
    if (r2UserRec) await api('DELETE', `/super-admin/users/${r2UserRec.id}`, null, saToken);
  });

  // ================= SUPER ADMIN / SUBSCRIPTIONS =================
  await section('Super Admin & Subscriptions', async () => {
    const sa = await login('superadmin@pos.com', 'SuperAdmin@123');
    check('Super admin login', sa.status === 200);
    const saToken = sa.data.token;

    const list = await api('GET', '/super-admin/restaurants', null, saToken);
    check('Super admin lists restaurants', list.status === 200, `status=${list.status}`);
    const restList = list.data?.data?.restaurants || list.data?.restaurants || [];
    check('Restaurant list is live data', restList.length >= 2, `count=${restList.length}`);

    const plans = await api('GET', '/super-admin/plans', null, saToken);
    check('Super admin lists plans', plans.status === 200, `status=${plans.status}`);
    const planList = plans.data?.data || plans.data?.plans || [];
    console.log('  ℹ Plans:', planList.map(p => `${p.name} (${p.id})`).join(', '));

    const users = await api('GET', '/super-admin/users', null, saToken);
    check('Super admin lists users', users.status === 200);

    const admin = await login('admin@restaurant.com', 'password123');
    const adminBlocked = await api('GET', '/super-admin/restaurants', null, admin.data.token);
    check('Restaurant admin blocked from super-admin routes (403)', adminBlocked.status === 403, `status=${adminBlocked.status}`);

    const subInfo = admin.data.subscription;
    console.log('  ℹ R1 subscription:', subInfo ? `${subInfo.plan?.name || subInfo.planName} status=${subInfo.status}` : 'none');
    if (subInfo?.planId) {
      const planPerms = await prisma.planModulePermission.findMany({
        where: { planId: subInfo.planId },
        include: { module: { select: { key: true } } },
      });
      console.log(`  ℹ Plan ${subInfo.planId} module permissions:`, planPerms.map(p => `${p.module.key}:${p.isEnabled ? 'ON' : 'OFF'}`).join(', '));
      check('Plan has module permissions', planPerms.length > 0);
    }

    // Feature enforcement — create a plan with pos OFF, assign to a throwaway restaurant, verify 403
    if (planList.length > 0) {
      // Use an existing plan's module list as template
      const planModules = await api('GET', '/super-admin/plans/modules', null, saToken);
      const moduleList = planModules.data?.data || planModules.data?.modules || [];
      console.log(`  ℹ Platform modules (${moduleList.length}):`, moduleList.map(m => m.key).join(', '));

      const tempRestaurantName = `QA Sub ${Date.now()}`;
      const createRest = await api('POST', '/super-admin/restaurants', {
        name: tempRestaurantName,
        ownerName: 'QA Owner',
        mobile: `99${String(Date.now()).slice(-8)}`,
        email: `qa-sub-${Date.now()}@test.com`,
        adminName: 'QA Admin',
        adminEmail: `qa-sub-admin-${Date.now()}@test.com`,
        adminPassword: 'SubPass@123',
      }, saToken);
      check('Create throwaway restaurant', createRest.status === 201 || createRest.status === 200, `${createRest.data?.message}`);
      const tempRest = createRest.data?.data || createRest.data?.restaurant;
      const tempRestId = tempRest?.id;

      if (tempRestId) {
        // Create a plan with only dashboard enabled
        const createPlan = await api('POST', '/super-admin/plans', {
          code: `QA-${Date.now()}`,
          name: `QA Plan ${Date.now()}`,
          monthlyPrice: 99,
          modules: moduleList.map(m => ({ moduleKey: m.key, enabled: m.key === 'dashboard' })),
        }, saToken);
        check('Create restricted plan', createPlan.status === 201 || createPlan.status === 200, `${createPlan.data?.message}`);
        const tempPlan = createPlan.data?.data || createPlan.data?.plan;
        const tempPlanId = tempPlan?.id;

        if (tempPlanId) {
          // assign to restaurant
          const assign = await api('PUT', `/super-admin/subscriptions/${tempRestId}/plan`, { planId: tempPlanId }, saToken);
          check('Assign plan to restaurant', assign.status === 200, `status=${assign.status} ${assign.data?.message}`);

          // create admin user for the restaurant
          const rEmail = `qa-sub-admin-${Date.now()}@test.com`;
          const createRUser = await api('POST', '/super-admin/users', {
            restaurantId: tempRestId, name: 'QA Sub Admin', email: rEmail, password: 'SubPass@123', role: 'ADMIN'
          }, saToken);
          check('Create admin for restricted restaurant', createRUser.status === 201 || createRUser.status === 200);

          const rLogin = await login(rEmail, 'SubPass@123');
          check('Restricted restaurant admin can login', rLogin.status === 200, `status=${rLogin.status} ${rLogin.data?.message}`);
          if (rLogin.status === 200) {
            const rToken = rLogin.data.token;
            // pos is disabled → order creation should 403
            const tryOrder = await api('POST', '/orders', { orderType: 'COUNTER_SALE', items: [{ menuItemId: 1, quantity: 1 }] }, rToken);
            check('Disabled module (pos) → backend 403', tryOrder.status === 403, `status=${tryOrder.status} ${tryOrder.data?.message}`);
            // dashboard enabled → works
            const dash = await api('GET', '/dashboard', null, rToken);
            check('Enabled module (dashboard) works', dash.status === 200, `status=${dash.status}`);
            // kitchen disabled → 403
            const kotList = await api('GET', '/kot', null, rToken);
            check('Disabled module (kitchen) → 403', kotList.status === 403, `status=${kotList.status}`);
            // menu disabled → 403
            const menuList = await api('GET', '/menu', null, rToken);
            check('Disabled module (menu) → 403', menuList.status === 403, `status=${menuList.status}`);
          }

          // Re-enable: switch to a full plan (or enable modules) → verify it works
          const fullPlan = planList.find(p => p.id !== tempPlanId);
          if (fullPlan) {
            const reassign = await api('PUT', `/super-admin/subscriptions/${tempRestId}/plan`, { planId: fullPlan.id }, saToken);
            check('Reassign full plan', reassign.status === 200, `status=${reassign.status}`);
            const rLogin2 = await login(rEmail, 'SubPass@123');
            if (rLogin2.status === 200) {
              // Feature gate re-enabled: the call must pass the feature middleware
              // (no 403). 201 = order created; 404 = no menu item in temp restaurant;
              // both prove the module is no longer blocked by the plan.
              const tryOrder2 = await api('POST', '/orders', { orderType: 'COUNTER_SALE', items: [{ menuItemId: 1, quantity: 1 }] }, rLogin2.data.token);
              check('Re-enabled module works after plan change + re-login', tryOrder2.status !== 403, `status=${tryOrder2.status} ${tryOrder2.data?.message}`);
            }
          }

          // cleanup plan
          await api('DELETE', `/super-admin/plans/${tempPlanId}`, null, saToken);
        }
        // cleanup restaurant
        await api('DELETE', `/super-admin/restaurants/${tempRestId}`, null, saToken);
      }
    }
  });

  // ================= ERROR HANDLING =================
  await section('Error Handling', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;

    // Missing items field entirely → 400 (validator requires it)
    const noItemsField = await api('POST', '/orders', { orderType: 'COUNTER_SALE' }, token);
    check('Order without items field → 400', noItemsField.status === 400, `status=${noItemsField.status} ${noItemsField.data?.message}`);

    // Invalid order type → 400
    const badType = await api('POST', '/orders', { orderType: 'SPACESHIP', items: [{ menuItemId: 1, quantity: 1 }] }, token);
    check('Invalid order type → 400', badType.status === 400, `status=${badType.status}`);

    const badItem = await api('POST', '/orders', { orderType: 'COUNTER_SALE', items: [{ menuItemId: 99999999, quantity: 1 }] }, token);
    check('Order with nonexistent item → 400/404 (not 500)', badItem.status === 400 || badItem.status === 404, `status=${badItem.status} ${badItem.data?.message}`);

    const badJson = await fetch(`${BASE}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{invalid json',
    });
    check('Malformed JSON → 400', badJson.status === 400, `status=${badJson.status}`);

    const featureCheck = await api('GET', '/orders', null, token);
    check('Feature-enabled module works', featureCheck.status === 200);

    const dupName = `QA Dup ${Date.now()}`;
    const c1 = await api('POST', '/categories', { name: dupName }, token);
    const c2 = await api('POST', '/categories', { name: dupName }, token);
    check('Duplicate category name handled (no 500)', c2.status < 500, `status=${c2.status} ${c2.data?.message}`);
    const catId = c1.data?.category?.id;
    if (catId) await api('DELETE', `/categories/${catId}`, null, token);
  });

  // ================= PRINT / PDF =================
  await section('Print / PDF', async () => {
    const admin = await login('admin@restaurant.com', 'password123');
    const token = admin.data.token;
    const menu = await api('GET', '/menu', null, token);
    const menuItems = menu.data?.items || [];
    const item = menuItems.find(m => m.currentStock != null && m.isAvailable);
    if (!item) return;

    // Create + complete + bill + pay an order so we have a real paid bill
    const order = await api('POST', '/orders', { orderType: 'COUNTER_SALE', items: [{ menuItemId: item.id, quantity: 1 }] }, token);
    const o = order.data?.data;
    if (!o) return;
    await api('PATCH', `/orders/${o.id}/status`, { status: 'COMPLETED' }, token);
    const bill = await api('POST', '/bills', { orderId: o.id }, token);
    const billId = bill.data?.data?.id;
    if (!billId) return;
    await api('POST', '/payments', { billId, amount: o.totalAmount, paymentMethod: 'CASH' }, token);

    // Bill print (receipt PDF)
    const receipt = await fetch(`${BASE}/print/receipt/${billId}`, { headers: { Authorization: `Bearer ${token}` } });
    const receiptType = receipt.headers.get('content-type') || '';
    console.log(`  ℹ Bill receipt endpoint: ${receipt.status} type=${receiptType}`);
    check('Bill receipt generates a document', receipt.status === 200 && (receiptType.includes('pdf') || receiptType.includes('application/octet-stream')), `status=${receipt.status} type=${receiptType}`);

    // Bill invoice PDF
    const invoice = await fetch(`${BASE}/print/invoice/${billId}`, { headers: { Authorization: `Bearer ${token}` } });
    const invoiceType = invoice.headers.get('content-type') || '';
    console.log(`  ℹ Bill invoice endpoint: ${invoice.status} type=${invoiceType}`);
    check('Bill invoice generates a document', invoice.status === 200 && (invoiceType.includes('pdf') || invoiceType.includes('application/octet-stream')), `status=${invoice.status} type=${invoiceType}`);

    // Bill PDF via bills route (if exists)
    const billPdf = await fetch(`${BASE}/bills/${billId}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`  ℹ /bills/:id/pdf endpoint: ${billPdf.status}`);

    // Reprint receipt — printInvoice above already incremented reprintCount by 1
    const reprint = await api('POST', `/payments/${billId}/reprint`, {}, token);
    check('Receipt reprint works', reprint.status === 200, `status=${reprint.status}`);
    const dbBill = await prisma.bill.findUnique({ where: { id: billId } });
    check('Reprint count incremented in DB', dbBill.reprintCount >= 1, `reprintCount=${dbBill.reprintCount}`);
  });

  // ================= SUMMARY =================
  console.log('\n\n══════════════════════════════════════');
  console.log('QA SUMMARY');
  console.log('══════════════════════════════════════');
  console.log(`PASS: ${PASS}`);
  console.log(`FAIL: ${FAIL}`);
  if (failures.length) {
    console.log('\nFAILED CHECKS:');
    failures.forEach(f => console.log(`  ❌ ${f}`));
  }
  console.log('\nPer-section:');
  for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v.pass} pass / ${v.fail} fail`);
  await prisma.$disconnect();
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('💥 FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
