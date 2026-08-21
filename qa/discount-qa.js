// Restaurant POS — Bill Discount Feature E2E (live API + PostgreSQL)
// Usage: node qa/discount-qa.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BASE = 'http://localhost:5001/api';

let PASS = 0, FAIL = 0;
const failures = [];

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
const round2 = (n) => Math.round(n * 100) / 100;

const findData = (resp, keys) => {
  for (const k of keys) if (resp.data && resp.data[k] !== undefined) return resp.data[k];
  return null;
};

async function section(name, fn) {
  console.log(`\n══════════ ${name} ══════════`);
  const before = { PASS, FAIL };
  try { await fn(); } catch (e) { console.error('  💥 SECTION ERROR:', e.message); FAIL++; failures.push(`${name} — threw: ${e.message}`); }
  console.log(`  → ${PASS - before.PASS} pass / ${FAIL - before.FAIL} fail`);
}

async function main() {
  // ── Login (real seeded admin, restaurant 1) ──
  const admin = await login('admin@restaurant.com', 'password123');
  check('Admin login succeeds', admin.status === 200, `status=${admin.status}`);
  const token = admin.data.token;
  const rid = admin.data.user?.restaurantId || 1;
  const uid = admin.data.user?.id;

  // ── Create two real test items via the menu API (no mocks) ──
  const cat = await prisma.category.findFirst({ where: { restaurantId: rid } });
  const suffix = Date.now();
  const mkItem = async (name, price) => {
    const r = await api('POST', '/menu', {
      name: `${name} ${suffix}`, categoryId: cat.id, price, preparationTime: 5,
      currentStock: 999, gstPercentage: 0, displayOrder: 1, isAvailable: true,
    }, token);
    const id = r.data?.data?.id || r.data?.item?.id;
    return id;
  };
  const item500 = await mkItem('QA Disc ₹500', 500);
  const item359 = await mkItem('QA Disc ₹359', 359);
  check('Created ₹500 test item', !!item500, `id=${item500}`);
  check('Created ₹359 test item', !!item359, `id=${item359}`);

  const mkOrder = async (items, opts = {}) => {
    const r = await api('POST', '/orders', {
      orderType: 'COUNTER_SALE',
      items: items.map(([menuItemId, quantity]) => ({ menuItemId, quantity })),
      ...opts,
    }, token);
    return r.data?.data?.id || r.data?.order?.id;
  };
  const collect = async (orderId, discountType, discountValue, payments, extra = {}) =>
    api('POST', '/payments/collect', {
      orderId,
      payments,
      ...(discountType ? { discountType, discountValue: Number(discountValue) } : {}),
      ...extra,
    }, token);

  const dbBill = async (orderId) => prisma.bill.findFirst({ where: { orderId, isCancelled: false } });
  const dbOrder = async (id) => prisma.order.findUnique({ where: { id } });

  // ── 1. ₹1,000 + 10% → discount ₹100, payable ₹900 ──
  await section('1. Percentage discount (₹1,000 + 10%)', async () => {
    const oid = await mkOrder([[item500, 2]]); // subtotal 1000
    check('Order created', !!oid);
    const r = await collect(oid, 'PERCENTAGE', 10, [{ paymentMethod: 'CASH', amount: 900 }]);
    check('Collect succeeds (payable 900)', r.status === 201 || r.status === 200, `status=${r.status} ${r.data?.message}`);
    const bill = await dbBill(oid);
    check('Bill discount = 100', bill && round2(bill.discount) === 100, `discount=${bill?.discount}`);
    check('Bill discountType = PERCENTAGE', bill?.discountType === 'PERCENTAGE');
    check('Bill discountValue = 10 (entered)', bill?.discountValue === 10, `value=${bill?.discountValue}`);
    check('Bill grandTotal = 900', bill && round2(bill.grandTotal) === 900, `grandTotal=${bill?.grandTotal}`);
    check('Bill discountedBy recorded', bill?.discountedBy === uid, `by=${bill?.discountedBy}`);
    check('Order discount synced = 100', (await dbOrder(oid))?.discount === 100);
    check('Order discountType synced', (await dbOrder(oid))?.discountType === 'PERCENTAGE');
  });

  // ── 2. ₹1,000 + ₹100 flat → payable ₹900 ──
  await section('2. Flat discount (₹1,000 + ₹100)', async () => {
    const oid = await mkOrder([[item500, 2]]);
    const r = await collect(oid, 'FLAT', 100, [{ paymentMethod: 'CASH', amount: 900 }]);
    check('Collect succeeds (payable 900)', r.status === 201 || r.status === 200, `status=${r.status} ${r.data?.message}`);
    const bill = await dbBill(oid);
    check('Bill discount = 100', bill && round2(bill.discount) === 100, `discount=${bill?.discount}`);
    check('Bill discountType = FLAT', bill?.discountType === 'FLAT');
    check('Bill discountValue = 100', bill?.discountValue === 100);
    check('Bill grandTotal = 900', bill && round2(bill.grandTotal) === 900, `grandTotal=${bill?.grandTotal}`);
  });

  // ── 3. ₹359 + 10% → discount ₹35.90, payable ₹323.10 ──
  await section('3. Percentage discount (₹359 + 10%)', async () => {
    const oid = await mkOrder([[item359, 1]]);
    const r = await collect(oid, 'PERCENTAGE', 10, [{ paymentMethod: 'CASH', amount: 323.1 }]);
    check('Collect succeeds (payable 323.10)', r.status === 201 || r.status === 200, `status=${r.status} ${r.data?.message}`);
    const bill = await dbBill(oid);
    check('Bill discount = 35.90', bill && round2(bill.discount) === 35.9, `discount=${bill?.discount}`);
    check('Bill grandTotal = 323.10', bill && round2(bill.grandTotal) === 323.1, `grandTotal=${bill?.grandTotal}`);
  });

  // ── 4. ₹359 + ₹100 flat → payable ₹259 ──
  await section('4. Flat discount (₹359 + ₹100)', async () => {
    const oid = await mkOrder([[item359, 1]]);
    const r = await collect(oid, 'FLAT', 100, [{ paymentMethod: 'CASH', amount: 259 }]);
    check('Collect succeeds (payable 259)', r.status === 201 || r.status === 200, `status=${r.status} ${r.data?.message}`);
    const bill = await dbBill(oid);
    check('Bill discount = 100', bill && round2(bill.discount) === 100, `discount=${bill?.discount}`);
    check('Bill grandTotal = 259', bill && round2(bill.grandTotal) === 259, `grandTotal=${bill?.grandTotal}`);
  });

  // ── 5. 100% discount → full subtotal off, charges still apply ──
  await section('5. 100% discount', async () => {
    const oid = await mkOrder([[item500, 2]]); // subtotal 1000
    const r = await collect(oid, 'PERCENTAGE', 100, [{ paymentMethod: 'CASH', amount: 50 }], { serviceCharge: 50 });
    check('Collect succeeds (payable = service charge 50)', r.status === 201 || r.status === 200, `status=${r.status} ${r.data?.message}`);
    const bill = await dbBill(oid);
    check('Bill discount = 1000 (full subtotal)', bill && round2(bill.discount) === 1000, `discount=${bill?.discount}`);
    check('Bill grandTotal = 50 (charges only)', bill && round2(bill.grandTotal) === 50, `grandTotal=${bill?.grandTotal}`);
    check('Payable never negative', bill && bill.grandTotal >= 0);
  });

  // ── 6. Flat discount > subtotal → clamped to subtotal ──
  await section('6. Discount greater than subtotal (clamped)', async () => {
    const oid = await mkOrder([[item359, 1]]); // subtotal 359
    const r = await collect(oid, 'FLAT', 5000, [{ paymentMethod: 'CASH', amount: 0.01 }]);
    // grandTotal is 0 → no positive payment can match; backend should still persist
    // a clamped bill when the caller pays exactly the (zero) total via 0? Payment
    // items require a positive amount, so we verify the clamp through createBill
    // path instead — see section 8. Here we assert a clean 400, never a 500.
    check('Over-discount collect never 500', r.status < 500, `status=${r.status}`);
    // createBill path with clamped discount
    const oid2 = await mkOrder([[item359, 1]]);
    const done = await api('PATCH', `/orders/${oid2}/status`, { status: 'COMPLETED' }, token);
    check('Order marked COMPLETED', done.status === 200, `status=${done.status} ${done.data?.message}`);
    const cb = await api('POST', '/bills', { orderId: oid2, discountType: 'FLAT', discountValue: 5000 }, token);
    check('createBill with over-discount succeeds', cb.status === 201 || cb.status === 200, `status=${cb.status} ${cb.data?.message}`);
    const bill = await dbBill(oid2);
    check('Bill discount clamped to 359', bill && round2(bill.discount) === 359, `discount=${bill?.discount}`);
    check('Bill grandTotal = 0 (never negative)', bill && bill.grandTotal === 0, `grandTotal=${bill?.grandTotal}`);
    check('Bill grandTotal >= 0', bill && bill.grandTotal >= 0);
  });

  // ── 7. Validation: 101%, negative, letters, Infinity ──
  await section('7. Invalid discount input → 400', async () => {
    const oid = await mkOrder([[item500, 2]]);
    const r1 = await collect(oid, 'PERCENTAGE', 101, [{ paymentMethod: 'CASH', amount: 900 }]);
    check('101% rejected (400)', r1.status === 400, `status=${r1.status} ${r1.data?.message}`);
    const r2 = await collect(oid, 'FLAT', -100, [{ paymentMethod: 'CASH', amount: 900 }]);
    check('Negative rejected (400)', r2.status === 400, `status=${r2.status}`);
    const r3 = await collect(oid, 'PERCENTAGE', 'abc', [{ paymentMethod: 'CASH', amount: 900 }]);
    check('Letters rejected (400)', r3.status === 400, `status=${r3.status}`);
    const r4 = await collect(oid, 'PERCENTAGE', Infinity, [{ paymentMethod: 'CASH', amount: 900 }]);
    check('Infinity rejected (400)', r4.status === 400, `status=${r4.status} ${r4.data?.message}`);
    const r5 = await collect(oid, 'PERCENTAGE', '10', [{ paymentMethod: 'CASH', amount: 900 }]);
    check('String number coerced (10 accepted)', r5.status === 201 || r5.status === 200, `status=${r5.status}`);
    const bill = await dbBill(oid);
    check('Bill discount = 100 after string 10', bill && round2(bill.discount) === 100, `discount=${bill?.discount}`);
    // Wrong (non-discounted) payment total must be rejected — backend is authority
    const oid2 = await mkOrder([[item500, 2]]);
    const r6 = await collect(oid2, 'PERCENTAGE', 10, [{ paymentMethod: 'CASH', amount: 1000 }]);
    check('Payment ≠ discounted total rejected (400)', r6.status === 400, `status=${r6.status} ${r6.data?.message}`);
  });

  // ── 8. Edit / remove discount on an existing bill ──
  await section('8. Edit & remove discount (updateBillDiscount)', async () => {
    const oid = await mkOrder([[item500, 2]]);
    const done = await api('PATCH', `/orders/${oid}/status`, { status: 'COMPLETED' }, token);
    const cb = await api('POST', '/bills', { orderId: oid, discountType: 'PERCENTAGE', discountValue: 10 }, token);
    const billId = cb.data?.data?.id || cb.data?.bill?.id;
    check('Bill created with 10%', !!billId && round2((await dbBill(oid))?.discount) === 100);

    const edit1 = await api('POST', `/bills/${billId}/discount`, { discountType: 'FLAT', discountValue: 50 }, token);
    check('Edit → FLAT ₹50 succeeds', edit1.status === 200, `status=${edit1.status} ${edit1.data?.message}`);
    let bill = await dbBill(oid);
    check('Bill discount = 50 after edit', round2(bill.discount) === 50, `discount=${bill.discount}`);
    check('Bill grandTotal = 950 after edit', round2(bill.grandTotal) === 950, `gt=${bill.grandTotal}`);
    check('Bill discountType = FLAT after edit', bill.discountType === 'FLAT');

    const edit2 = await api('POST', `/bills/${billId}/discount`, { discountType: 'PERCENTAGE', discountValue: 0 }, token);
    check('Remove (0%) succeeds', edit2.status === 200, `status=${edit2.status} ${edit2.data?.message}`);
    bill = await dbBill(oid);
    check('Bill discount = 0 after remove', round2(bill.discount) === 0, `discount=${bill.discount}`);
    check('Bill grandTotal restored = 1000', round2(bill.grandTotal) === 1000, `gt=${bill.grandTotal}`);

    const bad = await api('POST', `/bills/${billId}/discount`, { discountType: 'PERCENTAGE', discountValue: 250 }, token);
    check('Edit to 250% rejected (400)', bad.status === 400, `status=${bad.status} ${bad.data?.message}`);

    // Paid bills are locked against discount edits
    const oid3 = await mkOrder([[item359, 1]]);
    const r = await collect(oid3, 'PERCENTAGE', 10, [{ paymentMethod: 'CASH', amount: 323.1 }]);
    const paidBill = await dbBill(oid3);
    check('Paid bill created', !!paidBill && paidBill.paymentStatus === 'PAID');
    const locked = await api('POST', `/bills/${paidBill.id}/discount`, { discountType: 'FLAT', discountValue: 10 }, token);
    check('Paid bill discount locked (400)', locked.status === 400, `status=${locked.status} ${locked.data?.message}`);
  });

  // ── 9. Card & UPI payments use discounted payable ──
  await section('9. Card / UPI / WALLET payments with discount', async () => {
    const oid = await mkOrder([[item500, 2]]);
    const r = await collect(oid, 'PERCENTAGE', 10, [{ paymentMethod: 'CARD', amount: 900, transactionId: `CARD${suffix}` }]);
    check('Card collect succeeds (900)', r.status === 201 || r.status === 200, `status=${r.status} ${r.data?.message}`);
    const bill = await dbBill(oid);
    check('Card bill paid 900', bill && round2(bill.paidAmount) === 900 && bill.paymentStatus === 'PAID');

    const oid2 = await mkOrder([[item359, 1]]);
    const r2 = await collect(oid2, 'FLAT', 100, [{ paymentMethod: 'UPI', amount: 259, transactionId: `UPI${suffix}` }]);
    check('UPI collect succeeds (259)', r2.status === 201 || r2.status === 200, `status=${r2.status} ${r2.data?.message}`);
    const bill2 = await dbBill(oid2);
    check('UPI bill paid 259', bill2 && round2(bill2.paidAmount) === 259 && bill2.paymentStatus === 'PAID');
  });

  // ── 10. Split payment applies discount BEFORE splitting ──
  await section('10. Split payment with discount', async () => {
    const oid = await mkOrder([[item500, 2]]); // subtotal 1000 → payable 900
    const r = await collect(oid, 'PERCENTAGE', 10, [
      { paymentMethod: 'CASH', amount: 400 },
      { paymentMethod: 'CARD', amount: 500, transactionId: `SPLIT${suffix}` },
    ]);
    check('Split collect succeeds (400+500=900)', r.status === 201 || r.status === 200, `status=${r.status} ${r.data?.message}`);
    const bill = await dbBill(oid);
    check('Split bill discount = 100', round2(bill.discount) === 100);
    check('Split bill paid 900', round2(bill.paidAmount) === 900 && bill.paymentStatus === 'PAID');
    const pms = await prisma.payment.findMany({ where: { billId: bill.id } });
    check('Two payments created', pms.length === 2, `n=${pms.length}`);
    check('Payments sum to 900 (never 1000)', round2(pms.reduce((s, p) => s + p.amount, 0)) === 900);
  });

  // ── 11. Bill persistence after reload ──
  await section('11. Bill persists (re-fetch from API + DB)', async () => {
    const oid = await mkOrder([[item500, 2]]);
    await collect(oid, 'PERCENTAGE', 10, [{ paymentMethod: 'CASH', amount: 900 }]);
    const db = await dbBill(oid);
    const refetch = await api('GET', `/bills/${db.id}`, null, token);
    const got = refetch.data?.data || refetch.data?.bill || refetch.data;
    check('Bill re-fetched', refetch.status === 200 && !!got, `status=${refetch.status}`);
    check('Refetched discount = 100', got && round2(Number(got.discount)) === 100, `d=${got?.discount}`);
    check('Refetched discountType = PERCENTAGE', got?.discountType === 'PERCENTAGE');
    check('Refetched discountValue = 10', got && Number(got.discountValue) === 10);
    check('Refetched grandTotal = 900', got && round2(Number(got.grandTotal)) === 900, `gt=${got?.grandTotal}`);
  });

  // ── 12. Receipt / PDF contains discount ──
  await section('12. Receipt / PDF generation', async () => {
    const oid = await mkOrder([[item500, 2]]);
    await collect(oid, 'PERCENTAGE', 10, [{ paymentMethod: 'CASH', amount: 900 }]);
    const bill = await dbBill(oid);
    const rec = await fetch(`${BASE}/print/receipt/${bill.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const buf = Buffer.from(await rec.arrayBuffer());
    check('Receipt PDF generated (200)', rec.status === 200, `status=${rec.status}`);
    check('Receipt is PDF content-type', (rec.headers.get('content-type') || '').includes('pdf'));
    // PDF text streams are FlateDecode-compressed and glyphs are hex-encoded —
    // inflate each stream and decode the <hex> tokens, then verify the discount
    // line (label + amount) is actually rendered on the receipt.
    const zlib = require('zlib');
    const pdfText = buf.toString('latin1');
    let inflatedAll = '';
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m;
    while ((m = streamRe.exec(pdfText)) !== null) {
      try {
        inflatedAll += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
      } catch (e) { /* skip non-deflate streams */ }
    }
    const decoded = [...inflatedAll.matchAll(/<([0-9a-fA-F]+)>/g)]
      .map((mm) => Buffer.from(mm[1], 'hex').toString('latin1'))
      .join(' ');
    check('Receipt shows Discount (10%): label', decoded.includes('Discount (10%):'), decoded.slice(0, 200));
    check('Receipt shows -₹100.00 discount amount', decoded.includes('₹-100.00') || decoded.includes('-100.00'),
      decoded.slice(0, 200));
    check('Receipt grand total is discounted (900.00)', decoded.includes('900.00') && !decoded.includes('1000.00\nGRAND'),
      decoded.slice(0, 200));
    const inv = await fetch(`${BASE}/print/invoice/${bill.id}`, { headers: { Authorization: `Bearer ${token}` } });
    check('Invoice PDF generated (200)', inv.status === 200, `status=${inv.status}`);
  });

  // ── 13. Reports reconcile with DB (Total Discount / Net Sales) ──
  await section('13. Reports show persisted discount', async () => {
    // Fixed window: from one hour before this run to now (report clamps `to`
    // to end-of-day, mirror that exactly so both sides measure the same bills).
    const from = new Date(Date.now() - 3600 * 1000);
    const to = new Date();
    const end = new Date(to); end.setHours(23, 59, 59, 999);
    const dbSales = await prisma.bill.findMany({
      where: {
        restaurantId: rid, status: 'PAID', isCancelled: false,
        createdAt: { gte: from, lte: end },
      },
      select: { grandTotal: true, discount: true },
    });
    const dbDiscount = round2(dbSales.reduce((s, b) => s + Number(b.discount || 0), 0));
    const dbNet = round2(dbSales.reduce((s, b) => s + Number(b.grandTotal || 0), 0));

    const r = await api('GET', `/reports/sales?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, null, token);
    const summary = findData(r, ['summary', 'data']) || r.data;
    check('Sales report returns 200', r.status === 200, `status=${r.status}`);
    const repDiscount = Number(summary?.totalDiscount ?? summary?.summary?.totalDiscount ?? -1);
    const repNet = Number(summary?.netSales ?? summary?.summary?.netSales ?? summary?.totalSales ?? -1);
    check('Report totalDiscount matches DB', Math.abs(repDiscount - dbDiscount) < 0.05,
      `report=${repDiscount} db=${dbDiscount}`);
    check('Report net sales matches DB grandTotal sum', Math.abs(repNet - dbNet) < 0.05,
      `report=${repNet} db=${dbNet}`);
  });

  // ── 14. Cancelled order cannot be billed with discount ──
  await section('14. Cancelled order blocked', async () => {
    const oid = await mkOrder([[item359, 1]]);
    const canc = await api('PATCH', `/orders/${oid}/cancel`, { reason: 'QA discount test cancel' }, token);
    check('Order cancelled', canc.status === 200, `status=${canc.status}`);
    const r = await collect(oid, 'PERCENTAGE', 10, [{ paymentMethod: 'CASH', amount: 323.1 }]);
    check('Collect on cancelled order rejected (400)', r.status === 400, `status=${r.status} ${r.data?.message}`);
    const bill = await dbBill(oid);
    check('No bill created for cancelled order', !bill);
  });

  // ── 15. Multi-tenant isolation on discount billing ──
  await section('15. Multi-tenant isolation', async () => {
    const sa = await login('superadmin@pos.com', 'SuperAdmin@123');
    check('Super admin login', sa.status === 200);
    const r2Email = `qa-disc-r2-${suffix}@test.com`;
    const cu = await api('POST', '/super-admin/users', {
      restaurantId: 2, name: 'QA Disc R2', email: r2Email, password: 'R2Pass@123', role: 'ADMIN',
    }, sa.data.token);
    const r2login = await login(r2Email, 'R2Pass@123');
    check('R2 admin created & logged in', r2login.status === 200, `${cu.data?.message}`);

    const oid = await mkOrder([[item359, 1]]); // restaurant 1 order
    const cross = await api('POST', '/payments/collect', {
      orderId: oid, payments: [{ paymentMethod: 'CASH', amount: 323.1 }],
      discountType: 'PERCENTAGE', discountValue: 10,
    }, r2login.data.token);
    check('R2 cannot bill R1 order (404)', cross.status === 404, `status=${cross.status} ${cross.data?.message}`);

    // cleanup R2 admin
    const r2rec = await prisma.user.findUnique({ where: { email: r2Email } });
    if (r2rec) await api('DELETE', `/super-admin/users/${r2rec.id}`, null, sa.data.token);
  });

  // ── 16. Zero discount (0% / ₹0) is harmless ──
  await section('16. Zero discount edge cases', async () => {
    const oid = await mkOrder([[item500, 2]]);
    const r0 = await collect(oid, 'PERCENTAGE', 0, [{ paymentMethod: 'CASH', amount: 1000 }]);
    check('0% collect succeeds (payable 1000)', r0.status === 201 || r0.status === 200, `status=${r0.status}`);
    const bill = await dbBill(oid);
    check('0% → discount 0, grandTotal 1000', round2(bill.discount) === 0 && round2(bill.grandTotal) === 1000,
      `d=${bill.discount} gt=${bill.grandTotal}`);

    const oid2 = await mkOrder([[item359, 1]]);
    const r2 = await collect(oid2, 'FLAT', 0, [{ paymentMethod: 'CASH', amount: 359 }]);
    check('₹0 collect succeeds', r2.status === 201 || r2.status === 200, `status=${r2.status}`);
    const bill2 = await dbBill(oid2);
    check('₹0 → discount 0, grandTotal 359', round2(bill2.discount) === 0 && round2(bill2.grandTotal) === 359);
  });

  // ── Summary ──
  console.log(`\n══════════════════════════════════════`);
  console.log(`  Total: ${PASS}  Passed: ${PASS} ✅  Failed: ${FAIL} ❌`);
  if (failures.length) console.log('  Failures:', failures.join(' | '));
  await prisma.$disconnect();
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
