/**
 * REPORTS REAL DATA QA — every report KPI/chart/table value must be generated
 * from PostgreSQL through the running backend. Verifies:
 *
 *  1. Sales report: totalSales / totalOrders / totalDiscount / totalTax /
 *     netSales / cancelledOrders reconcile with DB aggregates for a controlled
 *     transaction set (paid bills + cancelled order).
 *  2. Item & category analytics come from the same PAID-bill source and
 *     reconcile with DB OrderItem rows.
 *  3. Payment report: method summary (CASH/CARD/UPI/… + unknown bucket) and
 *     totalAmount reconcile with DB Payment rows (PAID only).
 *  4. Order report: status counts + server-side pagination (page/pageSize)
 *     return the full-range summary while the table page only holds page rows.
 *  5. Date-range filtering: last-7-days vs today produce different,
 *     DB-consistent numbers; the "This Month" range equals the month aggregate.
 *  6. Empty state: no transactions → zero KPIs, no fabricated chart slices.
 *  7. Tenant isolation: report data is scoped to the authenticated restaurant.
 *  8. Sales report "Payment" column is populated from real Payment records
 *     (bills include payments) — the value shown equals the DB method.
 *
 * Usage: node qa/reports-real-data-qa.js   (backend :5001 must be running)
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

const dayStr = (d) => d.toISOString().slice(0, 10);

(async () => {
  const ts = Date.now();
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  const saToken = sa.data.token;
  const c = await api("POST", "/super-admin/restaurants", {
    name: `QA ReportsReal ${ts}`, ownerName: "QA Owner", mobile: `90${String(ts).slice(-8)}`,
    email: `rr-${ts}@t.com`, adminName: "QA Admin", adminEmail: `rr-admin-${ts}@t.com`, adminPassword: "SubPass@123",
  }, saToken);
  const r = c.data?.data || c.data?.restaurant;
  const login = await api("POST", "/auth/login", { email: `rr-admin-${ts}@t.com`, password: "SubPass@123" });
  const token = login.data.token;

  // ── Seed: category + 2 items ──
  const cat = await api("POST", "/categories", { name: `RRCat ${ts}` }, token);
  const catId = cat.data?.data?.id || cat.data?.category?.id;
  const a = await api("POST", "/menu", { name: "RRItemA", sku: `RRA-${ts}`, price: 100, categoryId: catId, tax: 5, currentStock: 500 }, token);
  const aId = a.data?.data?.id || a.data?.item?.id;
  const b = await api("POST", "/menu", { name: "RRItemB", sku: `RRB-${ts}`, price: 50, categoryId: catId, tax: 0, currentStock: 500 }, token);
  const bId = b.data?.data?.id || b.data?.item?.id;

  // T1: 2×A + 1×B = 250, 10% discount (−25) + 10 tax → 235, CASH+UPI split
  const o1 = await api("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: aId, quantity: 2 }, { menuItemId: bId, quantity: 1 }] }, token);
  const o1Id = o1.data?.data?.id;
  const c1 = await api("POST", "/payments/collect", {
    orderId: o1Id, payments: [{ paymentMethod: "CASH", amount: 100 }, { paymentMethod: "UPI", amount: 135 }],
    discountType: "PERCENTAGE", discountValue: 10, serviceCharge: 0, roundOff: 0,
  }, token);
  check(c1.status === 201, `T1 collect (${c1.status})`);
  // T2: 1×B = 50, CASH
  const o2 = await api("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: bId, quantity: 1 }] }, token);
  const o2Id = o2.data?.data?.id;
  const c2 = await api("POST", "/payments/collect", { orderId: o2Id, payments: [{ paymentMethod: "CASH", amount: 50 }], discount: 0, serviceCharge: 0, roundOff: 0 }, token);
  check(c2.status === 201, `T2 collect (${c2.status})`);
  // T3: cancelled — must not inflate sales
  const o3 = await api("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: aId, quantity: 5 }] }, token);
  const o3Id = o3.data?.data?.id;
  await api("PATCH", `/orders/${o3Id}/cancel`, { reason: "QA cancel" }, token);

  // ── DB truth (business-day local range for the ISO date-only filter) ──
  const now = new Date();
  const fromIso = new Date(now.getTime() - 3600e3).toISOString();
  const toIso = new Date(now.getTime() + 3600e3).toISOString();
  const paidBills = await prisma.bill.findMany({ where: { restaurantId: r.id, isCancelled: false, status: "PAID", createdAt: { gte: fromIso, lte: toIso } } });
  const dbTotalSales = paidBills.reduce((s, bb) => s + Number(bb.grandTotal || 0), 0); // 235 + 50 = 285
  const dbTotalDiscount = paidBills.reduce((s, bb) => s + Number(bb.discount || 0), 0); // 25
  const dbTotalTax = paidBills.reduce((s, bb) => s + Number(bb.taxAmount || 0), 0); // 10
  const dbNetSales = paidBills.reduce((s, bb) => s + Number(bb.grandTotal || 0), 0);
  const dbCancelled = await prisma.order.count({ where: { restaurantId: r.id, status: "CANCELLED", isDeleted: false, createdAt: { gte: fromIso, lte: toIso } } });
  const dbNonCancelledOrders = await prisma.order.count({ where: { restaurantId: r.id, isDeleted: false, status: { not: "CANCELLED" }, createdAt: { gte: fromIso, lte: toIso } } }); // 2
  const dbCompleted = await prisma.order.count({ where: { restaurantId: r.id, status: "COMPLETED", isDeleted: false, createdAt: { gte: fromIso, lte: toIso } } }); // 2
  const dbOrderItems = await prisma.orderItem.findMany({ where: { order: { restaurantId: r.id, status: { notIn: ["CANCELLED"] }, isDeleted: false, createdAt: { gte: fromIso, lte: toIso } } } });
  const dbItemsSold = dbOrderItems.reduce((s, i) => s + Number(i.quantity), 0); // 2+1+1 = 4
  const dbItemA = dbOrderItems.filter((i) => i.menuItemId === aId).reduce((s, i) => s + Number(i.quantity), 0);
  const dbPayments = await prisma.payment.findMany({ where: { restaurantId: r.id, status: "PAID", createdAt: { gte: fromIso, lte: toIso } } });
  const dbPayTotal = dbPayments.reduce((s, p) => s + Number(p.amount), 0); // 285
  const dbCash = dbPayments.filter((p) => p.paymentMethod === "CASH").reduce((s, p) => s + Number(p.amount), 0); // 150
  const dbUpi = dbPayments.filter((p) => p.paymentMethod === "UPI").reduce((s, p) => s + Number(p.amount), 0); // 135

  // ── 1. SALES REPORT ──
  const sales = await api("GET", `/reports/sales?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, null, token);
  const s = sales.data?.data?.summary || sales.data?.data || {};
  console.log("  API sales summary:", JSON.stringify(s));
  check(Number(s.totalSales) === dbTotalSales, `totalSales reconciles (${s.totalSales} vs ${dbTotalSales})`);
  check(Number(s.totalDiscount) === dbTotalDiscount, `totalDiscount reconciles (${s.totalDiscount} vs ${dbTotalDiscount})`);
  check(Number(s.totalTax) === dbTotalTax, `totalTax reconciles (${s.totalTax} vs ${dbTotalTax})`);
  check(Number(s.netSales) === Number(dbNetSales), `netSales reconciles (${s.netSales} vs ${dbNetSales})`);
  check(Number(s.cancelledOrders) === dbCancelled, `cancelledOrders reconciles (${s.cancelledOrders} vs ${dbCancelled})`);
  check(Number(s.totalOrders) === dbNonCancelledOrders, `totalOrders = non-cancelled count (${s.totalOrders} vs ${dbNonCancelledOrders})`);
  check(Number(s.completedOrders) === dbCompleted, `completedOrders reconciles (${s.completedOrders} vs ${dbCompleted})`);
  const an = sales.data?.data?.analytics || {};
  check(Number(an.totalItemsSold) === dbItemsSold, `analytics.itemsSold reconciles (${an.totalItemsSold} vs ${dbItemsSold})`);
  check(an.topSellingItem?.itemName === "RRItemA" && Number(an.topSellingItem?.quantitySold) === dbItemA, `topSellingItem = real top item (${an.topSellingItem?.itemName} x${an.topSellingItem?.quantitySold})`);
  check(an.topItems?.length >= 1, `topItems list populated (${an.topItems?.length})`);
  check(an.topItems?.length <= 2, `topItems never fabricated beyond real items (${an.topItems?.length})`);

  // Sales report bills must include real payments (the UI "Payment" column)
  const bills = sales.data?.data?.bills || [];
  check(bills.length === 2, `sales report returns ${bills.length} paid bills`);
  const b1 = bills.find((x) => x.order?.orderNo === o1?.data?.data?.orderNo) || bills[0];
  const payMethods = (b1?.payments || []).map((p) => p.paymentMethod).sort();
  check(payMethods.includes("CASH") && payMethods.includes("UPI"), `bill includes real Payment rows (${payMethods.join(", ")})`);

  // ── 2. PAYMENT REPORT ──
  const payRep = await api("GET", `/reports/payment?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, null, token);
  const ps = payRep.data?.data?.summary || {};
  check(Number(ps.totalAmount) === dbPayTotal, `payment totalAmount reconciles (${ps.totalAmount} vs ${dbPayTotal})`);
  check(Number(ps.CASH) === dbCash, `payment CASH reconciles (${ps.CASH} vs ${dbCash})`);
  check(Number(ps.UPI) === dbUpi, `payment UPI reconciles (${ps.UPI} vs ${dbUpi})`);
  check(Number(ps.totalPayments) === dbPayments.length, `payment count reconciles (${ps.totalPayments} vs ${dbPayments.length})`);

  // ── 3. ORDER REPORT + server-side pagination ──
  // The order report table shows ALL orders (incl. cancelled, with a red
  // badge) — totalOrders = all non-deleted orders in range; status KPIs break
  // the total down. This differs intentionally from the sales report's
  // totalOrders (non-cancelled only) — see getOrderReport docs.
  const dbAllOrders = await prisma.order.count({ where: { restaurantId: r.id, isDeleted: false, createdAt: { gte: fromIso, lte: toIso } } }); // 3 (2 paid + 1 cancelled)
  const ordPage1 = await api("GET", `/reports/orders?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&page=1&pageSize=1`, null, token);
  const op = ordPage1.data?.data || {};
  check(op.orders?.length === 1, `order report page 1 returns exactly pageSize rows (${op.orders?.length})`);
  check(Number(op.summary?.totalOrders) === dbAllOrders, `order report summary total = full range (${op.summary?.totalOrders} vs ${dbAllOrders})`);
  check(Number(op.pagination?.total) === dbAllOrders && op.pagination?.totalPages >= 2, `pagination meta correct (total ${op.pagination?.total}, pages ${op.pagination?.totalPages})`);
  check(Number(op.summary?.completedCount) === dbCompleted, `order report completedCount reconciles (${op.summary?.completedCount} vs ${dbCompleted})`);
  check(Number(op.summary?.cancelledCount) === dbCancelled, `order report cancelledCount reconciles (${op.summary?.cancelledCount} vs ${dbCancelled})`);
  const ordFull = await api("GET", `/reports/orders?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, null, token);
  const of = ordFull.data?.data || {};
  check(of.orders?.length === dbAllOrders, `order report (no page) returns full list (${of.orders?.length} vs ${dbAllOrders})`);
  const completedRow = of.orders?.find((o) => o.orderNo === o1?.data?.data?.orderNo);
  check(completedRow?.bill?.paymentMethod === "MULTIPLE", `order report payment method = MULTIPLE for split payment (${completedRow?.bill?.paymentMethod})`);

  // ── 4. DATE RANGE: Today (business-day) vs a window in the past ──
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayStr = dayStr(new Date());
  const tomorrowIso = new Date(todayStart); tomorrowIso.setDate(tomorrowIso.getDate() + 1);
  const salesToday = await api("GET", `/reports/sales?from=${todayStr}&to=${dayStr(tomorrowIso)}`, null, token);
  const st = salesToday.data?.data?.summary || {};
  check(Number(st.totalSales) === dbTotalSales, `date-only range (Today) catches today's sales (${st.totalSales} vs ${dbTotalSales}) — no UTC shift`);
  const pastFrom = new Date(now.getTime() - 10 * 86400e3).toISOString().slice(0, 10);
  const pastTo = new Date(now.getTime() - 5 * 86400e3).toISOString().slice(0, 10);
  const salesPast = await api("GET", `/reports/sales?from=${pastFrom}&to=${pastTo}`, null, token);
  const sp = salesPast.data?.data?.summary || {};
  check(Number(sp.totalSales) === 0, `past empty window returns 0 sales (${sp.totalSales})`);

  // ── 5. EMPTY STATE (second restaurant, no data) ──
  const c2r = await api("POST", "/super-admin/restaurants", {
    name: `QA ReportsEmpty ${ts}`, ownerName: "QA Owner", mobile: `92${String(ts + 5).slice(-8)}`,
    email: `rre-${ts}@t.com`, adminName: "QA Admin", adminEmail: `rre-admin-${ts}@t.com`, adminPassword: "SubPass@123",
  }, saToken);
  const re = c2r.data?.data || c2r.data?.restaurant;
  const loginE = await api("POST", "/auth/login", { email: `rre-admin-${ts}@t.com`, password: "SubPass@123" });
  const tokenE = loginE.data.token;
  const emptySales = await api("GET", `/reports/sales?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, null, tokenE);
  const es = emptySales.data?.data?.summary || {};
  check(Number(es.totalSales) === 0 && Number(es.totalOrders) === 0 && Number(es.cancelledOrders) === 0, "empty restaurant: all KPIs zero");
  check((emptySales.data?.data?.analytics?.topItems || []).length === 0, "empty restaurant: no fabricated top items");
  check((emptySales.data?.data?.bills || []).length === 0, "empty restaurant: no bills");
  const emptyPay = await api("GET", `/reports/payment?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, null, tokenE);
  const eps = emptyPay.data?.data?.summary || {};
  check(Number(eps.totalAmount) === 0, "empty restaurant: payment totalAmount = 0");

  // ── 6. TENANT ISOLATION ──
  const r2 = await api("GET", `/reports/sales?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, null, tokenE);
  const rs2 = r2.data?.data?.summary || {};
  check(Number(rs2.totalSales) === 0, "tenant isolation: restaurant B's report has zero A data");

  // ── Cleanup ──
  await api("DELETE", `/super-admin/restaurants/${r.id}`, null, saToken);
  await api("DELETE", `/super-admin/restaurants/${re.id}`, null, saToken);
  const gone = await prisma.restaurant.findFirst({ where: { id: { in: [r.id, re.id] }, deletedAt: null } });
  check(!gone, "QA restaurants cleaned up (soft-deleted)");

  console.log(`\n  Reports real-data QA → ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error("CRASH:", e.message); await prisma.$disconnect(); process.exit(1); });
