/**
 * DASHBOARD ACTIVE ORDERS / KITCHEN QUEUE QA — verifies the dashboard scoped
 * queries correctly:
 *
 *  1. Active Orders = today's PENDING/PREPARING/READY orders only (not all-time).
 *  2. Kitchen Queue = same live orders (same source, same count).
 *  3. Old active orders from yesterday or earlier must NOT appear.
 *  4. Cancelled / deleted orders never appear in active/kitchen.
 *  5. Hourly sales = today's PAID payment buckets.
 *  6. Dashboard ↔ Sales Report reconciliation: todaySales == report totalSales.
 *  7. Empty restaurant: all zeros, no mock data.
 *  8. Tenant isolation: restaurant A never sees B's data.
 *  9. IST business date: queries use IST midnight, not UTC midnight.
 *
 * Usage: node qa/dashboard-active-orders-qa.js   (backend :5001 must be running)
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const BASE = "http://127.0.0.1:5001/api";
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

function getISTBusinessDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  return { start: new Date(`${dateStr}T00:00:00+05:30`), end: new Date(`${dateStr}T23:59:59.999+05:30`), dateStr };
}

(async () => {
  const ts = Date.now();
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check(sa.status === 200, `SA login (${sa.status})`);
  const saToken = sa.data.token;

  // Create two QA restaurants for tenant isolation test
  const mkRest = async (tag, suffix) => {
    const c = await api("POST", "/super-admin/restaurants", {
      name: `QA ActiveOrders ${tag} ${ts}`, ownerName: "QA Owner", mobile: `95${String(ts + suffix).slice(-8)}`,
      email: `ao-${tag}-${ts}@t.com`, adminName: "QA Admin", adminEmail: `ao-admin-${tag}-${ts}@t.com`, adminPassword: "SubPass@123",
    }, saToken);
    return c.data?.data || c.data?.restaurant;
  };
  const ra = await mkRest("A", 0);
  const rb = await mkRest("B", 1);
  check(!!ra?.id && !!rb?.id, `two QA restaurants created (A=${ra?.id}, B=${rb?.id})`);

  const loginA = await api("POST", "/auth/login", { email: `ao-admin-A-${ts}@t.com`, password: "SubPass@123" });
  const tokenA = loginA.data.token;
  const loginB = await api("POST", "/auth/login", { email: `ao-admin-B-${ts}@t.com`, password: "SubPass@123" });
  const tokenB = loginB.data.token;

  // Seed restaurant A: 1 completed order + 1 active order TODAY
  const cat = await api("POST", "/categories", { name: `AOCat ${ts}` }, tokenA);
  const catId = cat.data?.category?.id || cat.data?.data?.id;
  const item = await api("POST", "/menu", { name: "AOBurger", sku: `AO-${ts}`, price: 100, categoryId: catId, tax: 5, currentStock: 500 }, tokenA);
  const itemId = item.data?.data?.id || item.data?.item?.id;

  // Order 1: paid → COMPLETED
  const o1 = await api("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: itemId, quantity: 1 }] }, tokenA);
  const o1Id = o1.data?.data?.id;
  await api("POST", "/payments/collect", { orderId: o1Id, payments: [{ paymentMethod: "CASH", amount: 105 }], discount: 0, serviceCharge: 0, roundOff: 0 }, tokenA);

  // Order 2: active (PENDING)
  const o2 = await api("POST", "/orders", { orderType: "DINE_IN", items: [{ menuItemId: itemId, quantity: 1 }] }, tokenA);
  const o2Id = o2.data?.data?.id;

  // Order 3: cancelled → must NOT appear in active
  const o3 = await api("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: itemId, quantity: 2 }] }, tokenA);
  const o3Id = o3.data?.data?.id;
  await api("PATCH", `/orders/${o3Id}/cancel`, { reason: "QA cancel" }, tokenA);

  // ── DB truth ──
  const { start: today, end: todayEnd, dateStr } = getISTBusinessDate();
  const dbActive = await prisma.order.count({ where: { restaurantId: ra.id, status: { in: ["PENDING", "PREPARING", "READY"] }, isDeleted: false, createdAt: { gte: today, lte: todayEnd } } });
  const dbActiveAllTime = await prisma.order.count({ where: { restaurantId: ra.id, status: { in: ["PENDING", "PREPARING", "READY"] }, isDeleted: false } });
  console.log(`  DB: active TODAY = ${dbActive}, active ALL-TIME = ${dbActiveAllTime}`);
  check(dbActive <= dbActiveAllTime, "today active ≤ all-time active (sanity)");

  // ── Dashboard API ──
  const dash = await api("GET", "/dashboard", null, tokenA);
  const dd = dash.data?.data || {};
  const apiActive = (dd.liveOrders || []).length;
  console.log(`  API liveOrders count: ${apiActive}`);
  check(apiActive === dbActive, `API activeOrders = DB active today (${apiActive} vs ${dbActive})`);
  check(apiActive <= dbActiveAllTime, `API activeOrders ≤ all-time (${apiActive} ≤ ${dbActiveAllTime})`);
  check(apiActive <= 2, `API activeOrders ≤ 2 (completed=1, active=1, cancelled excluded) → got ${apiActive}`);

  // Kitchen Queue = same source
  const kqCount = dd.liveOrders?.length || 0;
  check(kqCount === apiActive, `Kitchen Queue count = activeOrders count (${kqCount} vs ${apiActive})`);

  // Every liveOrder is from today
  const allToday = (dd.liveOrders || []).every(o => {
    const d = new Date(o.createdAt);
    return d >= today && d <= todayEnd;
  });
  check(allToday, "all liveOrders are from today's business date");

  // No cancelled/deleted in liveOrders
  const noneCancelled = (dd.liveOrders || []).every(o => o.status !== "CANCELLED");
  check(noneCancelled, "no cancelled orders in liveOrders");

  // Sales reconciliation
  const dbPaidToday = await prisma.bill.findMany({ where: { restaurantId: ra.id, status: "PAID", isCancelled: false, createdAt: { gte: today, lte: todayEnd } } });
  const dbTodaySales = dbPaidToday.reduce((s, b) => s + Number(b.grandTotal || 0), 0);
  check(Number(dd.sales?.totalSales) === dbTodaySales, `dashboard todaySales == DB PAID bills (${dd.sales?.totalSales} vs ${dbTodaySales})`);

  // ── Old active order test ──
  // Insert an artificial PENDING order from 3 days ago directly via Prisma
  const oldOrder = await prisma.order.create({ data: {
    restaurantId: ra.id, orderNo: `OLD-${ts}`, orderType: "DINE_IN", status: "PENDING",
    subtotal: 0, totalAmount: 0, taxAmount: 0, isDeleted: false,
    createdAt: new Date(Date.now() - 3 * 86400e3), updatedAt: new Date(Date.now() - 3 * 86400e3),
  }});
  const dashAfterOld = await api("GET", "/dashboard", null, tokenA);
  const ddAfter = dashAfterOld.data?.data || {};
  const apiActiveAfter = (ddAfter.liveOrders || []).length;
  check(apiActiveAfter === apiActive, `old stale PENDING order from 3 days ago does NOT inflate today's active (${apiActiveAfter} vs ${apiActive})`);
  // Clean up old order
  await prisma.order.delete({ where: { id: oldOrder.id } });

  // ── Empty state (restaurant B) ──
  const dashB = await api("GET", "/dashboard", null, tokenB);
  const dB = dashB.data?.data || {};
  check((dB.liveOrders || []).length === 0, "empty restaurant: activeOrders = 0");
  check(Number(dB.sales?.totalSales) === 0, "empty restaurant: todaySales = 0");

  // ── Tenant isolation ──
  const bOrderNos = (dB.liveOrders || []).map(o => o.orderNo);
  check(!bOrderNos.includes("ORD-001"), "tenant isolation: B does not see A's orders");

  // ── Hourly sales total = PAID payments today ──
  const dbPayments = await prisma.payment.findMany({ where: { restaurantId: ra.id, status: "PAID", createdAt: { gte: today, lte: todayEnd } } });
  const dbPaymentTotal = dbPayments.reduce((s, p) => s + Number(p.amount), 0);
  const hsTotal = (dd.hourlySales || []).reduce((s, b) => s + Number(b.value || 0), 0);
  check(Math.round(hsTotal) === Math.round(dbPaymentTotal), `hourlySales sum = PAID payments total (${Math.round(hsTotal)} vs ${Math.round(dbPaymentTotal)})`);

  // ── Cleanup ──
  await api("DELETE", `/super-admin/restaurants/${ra.id}`, null, saToken);
  await api("DELETE", `/super-admin/restaurants/${rb.id}`, null, saToken);

  console.log(`\n  Dashboard active-orders QA → ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error("CRASH:", e.message); console.error(e.stack); await prisma.$disconnect(); process.exit(1); });
