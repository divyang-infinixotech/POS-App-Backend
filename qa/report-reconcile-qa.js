/**
 * REPORTS RECONCILIATION QA — build a controlled set of transactions (orders
 * with discounts/tax, paid + cancelled), then compare every /reports/sales and
 * /reports/payment number directly against PostgreSQL aggregates.
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

(async () => {
  const ts = Date.now();
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  const saToken = sa.data.token;
  const create = await api("POST", "/super-admin/restaurants", {
    name: `QA Reports ${ts}`, ownerName: "QA Owner", mobile: `91${String(ts).slice(-8)}`,
    email: `rep-${ts}@t.com`, adminName: "QA Admin", adminEmail: `rep-admin-${ts}@t.com`, adminPassword: "SubPass@123",
  }, saToken);
  const r = create.data?.data || create.data?.restaurant;
  const login = await api("POST", "/auth/login", { email: `rep-admin-${ts}@t.com`, password: "SubPass@123" });
  const token = login.data.token;

  const cat = await api("POST", "/categories", { name: `RCat ${ts}` }, token);
  const catId = cat.data?.data?.id || cat.data?.category?.id;
  // item A: ₹100 with 5% tax; item B: ₹50 tax 0
  const a = await api("POST", "/menu", { name: "RepA", sku: `RA-${ts}`, price: 100, categoryId: catId, tax: 5, currentStock: 500 }, token);
  const aId = a.data?.data?.id || a.data?.item?.id;
  const b = await api("POST", "/menu", { name: "RepB", sku: `RB-${ts}`, price: 50, categoryId: catId, tax: 0, currentStock: 500 }, token);
  const bId = b.data?.data?.id || b.data?.item?.id;

  // Transaction 1: 2×A + 1×B = 250 subtotal, 10 tax → collect with 10% discount
  const o1 = await api("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: aId, quantity: 2 }, { menuItemId: bId, quantity: 1 }] }, token);
  const o1Id = o1.data?.data?.id;
  // grandTotal = 250 - 25 (10% discount) + 10 (5% tax on 2×100) = 235
  const c1 = await api("POST", "/payments/collect", {
    orderId: o1Id, payments: [{ paymentMethod: "CASH", amount: 100 }, { paymentMethod: "UPI", amount: 135 }],
    discountType: "PERCENTAGE", discountValue: 10, serviceCharge: 0, roundOff: 0,
  }, token);
  check(c1.status === 201, `T1 collect (${c1.status}) ${c1.data?.message || ""}`.slice(0, 90));
  // Transaction 2: 1×B = 50, no discount, CASH
  const o2 = await api("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: bId, quantity: 1 }] }, token);
  const o2Id = o2.data?.data?.id;
  const c2 = await api("POST", "/payments/collect", { orderId: o2Id, payments: [{ paymentMethod: "CASH", amount: 50 }], discount: 0, serviceCharge: 0, roundOff: 0 }, token);
  check(c2.status === 201, `T2 collect (${c2.status})`);
  // Transaction 3: cancelled order (must NOT inflate sales)
  const o3 = await api("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: aId, quantity: 5 }] }, token);
  const o3Id = o3.data?.data?.id;
  await api("PATCH", `/orders/${o3Id}/cancel`, { reason: "QA cancel" }, token);

  // ── DB truth ──
  const from = new Date(Date.now() - 3600e3).toISOString();
  const to = new Date(Date.now() + 3600e3).toISOString();
  const paidBills = await prisma.bill.findMany({ where: { restaurantId: r.id, isCancelled: false, status: "PAID", createdAt: { gte: from, lte: to } } });
  const dbTotalSales = paidBills.reduce((s, b) => s + Number(b.grandTotal || 0), 0);
  const dbTotalDiscount = paidBills.reduce((s, b) => s + Number(b.discount || 0), 0);
  const dbTotalTax = paidBills.reduce((s, b) => s + Number(b.taxAmount || 0), 0);
  const dbPayments = await prisma.payment.findMany({ where: { restaurantId: r.id, status: "PAID", createdAt: { gte: from, lte: to } } });
  const dbPayTotal = dbPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const dbCash = dbPayments.filter((p) => p.paymentMethod === "CASH").reduce((s, p) => s + Number(p.amount), 0);
  const dbUpi = dbPayments.filter((p) => p.paymentMethod === "UPI").reduce((s, p) => s + Number(p.amount), 0);
  const dbCancelled = await prisma.order.count({ where: { restaurantId: r.id, status: "CANCELLED", isDeleted: false, createdAt: { gte: from, lte: to } } });

  // ── API ──
  const sales = await api("GET", `/reports/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, null, token);
  const s = sales.data?.data?.summary || sales.data?.data || {};
  console.log("  API sales summary:", JSON.stringify(s));
  check(Number(s.totalSales) === dbTotalSales, `totalSales reconciles (${s.totalSales} vs ${dbTotalSales})`);
  check(Number(s.totalDiscount) === dbTotalDiscount, `totalDiscount reconciles (${s.totalDiscount} vs ${dbTotalDiscount})`);
  check(Number(s.totalTax) === dbTotalTax, `totalTax reconciles (${s.totalTax} vs ${dbTotalTax})`);
  check(Number(s.cancelledOrders) === dbCancelled, `cancelledOrders reconciles (${s.cancelledOrders} vs ${dbCancelled})`);
  const payRep = await api("GET", `/reports/payment?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, null, token);
  const ps = payRep.data?.data?.summary || {};
  check(Number(ps.totalAmount) === dbPayTotal, `payment totalAmount reconciles (${ps.totalAmount} vs ${dbPayTotal})`);
  check(Number(ps.CASH) === dbCash, `payment CASH reconciles (${ps.CASH} vs ${dbCash})`);
  check(Number(ps.UPI) === dbUpi, `payment UPI reconciles (${ps.UPI} vs ${dbUpi})`);

  await api("DELETE", `/super-admin/restaurants/${r.id}`, null, saToken);
  console.log(`\n  Reports reconciliation QA → ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error("CRASH:", e.message); await prisma.$disconnect(); process.exit(1); });
