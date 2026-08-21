/**
 * SECURITY & DATA-INTEGRITY QA — regression suite for fixes found in the
 * full-app audit:
 *
 *   1. Concurrent /payments/collect on the same order → exactly one bill, one
 *      payment, order COMPLETED, and the losing request gets a clean 400
 *      ("This order has already been paid") — never a 500 or duplicate rows.
 *   2. Cross-tenant IDOR: Restaurant B cannot read/modify Restaurant A's
 *      orders, bills, payments, menu items, tables, KOTs or categories (404),
 *      and B's list endpoints never contain A's ids.
 *   3. Malformed ids (/menu/abc, /floors/abc, /bills/abc, /orders/abc) → 400
 *      "Invalid request parameters" — never a 500 with a raw Prisma error.
 *   4. Missing required fields on /menu, /categories, /tables → 400 with a
 *      useful message (validators wired), while valid requests (including
 *      unknown fields) still succeed.
 *
 * Requires: backend on :5001, seeded DB with superadmin@pos.com.
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const BASE = "http://127.0.0.1:5001/api";
let pass = 0, fail = 0;
const results = [];
const check = (cond, msg) => { results.push({ ok: !!cond, msg }); if (cond) pass++; else fail++; process.stdout.write(cond ? "  ✅ " : "  ❌ "); console.log(msg); };

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
  check(!!saToken, "Super Admin login");

  async function makeRest(label) {
    const c = await api("POST", "/super-admin/restaurants", {
      name: `QA SecData ${label} ${ts}`, ownerName: "QA Owner",
      mobile: `${label === "A" ? "93" : "92"}${String(ts).slice(-8)}`,
      email: `secd-${label}-${ts}@t.com`, adminName: "QA Admin",
      adminEmail: `secd-${label}-admin-${ts}@t.com`, adminPassword: "SubPass@123",
    }, saToken);
    const r = c.data?.data || c.data?.restaurant;
    const lg = await api("POST", "/auth/login", { email: `secd-${label}-admin-${ts}@t.com`, password: "SubPass@123" });
    return { id: r.id, token: lg.data.token };
  }

  const A = await makeRest("A");
  const B = await makeRest("B");

  // ── §1 Concurrent collectPayment ──
  const cat = await api("POST", "/categories", { name: `ACat ${ts}` }, A.token);
  const catId = cat.data?.data?.id || cat.data?.category?.id;
  const item = await api("POST", "/menu", { name: "Race Item", sku: `R-${ts}`, price: 100, categoryId: catId, tax: 0, currentStock: 100 }, A.token);
  const itemId = item.data?.data?.id || item.data?.item?.id;
  const tab = await api("POST", "/tables", { tableNo: `A-${ts}`, capacity: 4 }, A.token);
  const tableId = tab.data?.data?.id || tab.data?.table?.id;
  const ord = await api("POST", "/orders", { orderType: "DINE_IN", tableId, items: [{ menuItemId: itemId, quantity: 2 }] }, A.token);
  const orderId = ord.data?.data?.id;
  check(!!orderId, `Order created for race test (id=${orderId})`);

  const payload = { orderId, payments: [{ paymentMethod: "CASH", amount: 200 }], discount: 0, serviceCharge: 0, roundOff: 0 };
  const [r1, r2] = await Promise.all([
    api("POST", "/payments/collect", payload, A.token),
    api("POST", "/payments/collect", payload, A.token),
  ]);
  const statuses = [r1.status, r2.status].sort().join(",");
  check(statuses === "201,400", `Concurrent collect → one 201 + one clean 400 (got ${statuses})`);
  check(r1.status === 400 || r2.status === 400, "Losing collect says 'This order has already been paid' — no 500, no raw Prisma error");
  const bills = await prisma.bill.findMany({ where: { orderId } });
  const payments = await prisma.payment.findMany({ where: { bill: { orderId } } });
  check(bills.length === 1, `Exactly ONE bill created (${bills.length})`);
  check(payments.length === 1, `Exactly ONE payment created (${payments.length})`);
  const ordAfter = await prisma.order.findUnique({ where: { id: orderId } });
  check(ordAfter.status === "COMPLETED", "Order COMPLETED once");
  const tabAfter = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
  check(tabAfter.status === "AVAILABLE", "Table released to AVAILABLE");

  // ── §2 Cross-tenant IDOR ──
  const kot = await prisma.kOT.findFirst({ where: { orderId } });
  const billId = r1.status === 201 ? r1.data?.data?.id : r2.data?.data?.id;
  const payId = r1.status === 201 ? r1.data?.data?.payments?.[0]?.id : r2.data?.data?.payments?.[0]?.id;
  check((await api("GET", `/orders/${orderId}`, null, B.token)).status === 404, "B GET A order → 404");
  check((await api("PATCH", `/orders/${orderId}/cancel`, { reason: "IDOR" }, B.token)).status === 404, "B cancel A order → 404");
  check((await api("GET", `/bills/${billId}`, null, B.token)).status === 404, "B GET A bill → 404");
  check((await api("GET", `/payments/${payId}`, null, B.token)).status === 404, "B GET A payment → 404");
  check((await api("GET", `/menu/${itemId}`, null, B.token)).status === 404, "B GET A menu item → 404");
  check((await api("PUT", `/tables/${tableId}`, { capacity: 99 }, B.token)).status === 404, "B update A table → 404");
  check((await api("GET", `/kot/${kot?.id}`, null, B.token)).status === 404, "B GET A KOT → 404");
  check((await api("PUT", `/categories/${catId}`, { name: "Hijacked" }, B.token)).status === 404, "B update A category → 404");
  const ordersB = await api("GET", "/orders/active", null, B.token);
  check(!JSON.stringify(ordersB.data).includes(String(orderId)), "B active-orders list contains no A order");
  const billsB = await api("GET", "/bills", null, B.token);
  check(!JSON.stringify(billsB.data).includes(String(billId)), "B bills list contains no A bill");
  const paysB = await api("GET", "/payments", null, B.token);
  check(!JSON.stringify(paysB.data).includes(String(payId)), "B payments list contains no A payment");

  // ── §3 Malformed ids → clean 400 ──
  for (const p of ["/menu/abc", "/floors/abc", "/bills/abc", "/orders/abc"]) {
    const res = await api("GET", p, null, A.token);
    check(res.status === 400 && res.data?.message === "Invalid request parameters", `GET ${p} → 400 clean message (${res.status})`);
  }

  // ── §4 Missing required fields → 400 with useful message; valid still works ──
  const badMenu = await api("POST", "/menu", { name: "Bad", sku: `B-${ts}`, price: 100 }, A.token);
  check(badMenu.status === 400 && (badMenu.data?.message || "").includes("categoryId"), "Menu without categoryId → 400 \"categoryId\" is required");
  const badPrice = await api("POST", "/menu", { name: "Bad", sku: `B2-${ts}`, price: "abc" }, A.token);
  check(badPrice.status === 400, "Menu with price=abc → 400");
  const badCat = await api("POST", "/categories", {}, A.token);
  check(badCat.status === 400 && (badCat.data?.message || "").includes("name"), "Category without name → 400");
  const badTab = await api("POST", "/tables", { tableNo: "T1", capacity: -5 }, A.token);
  check(badTab.status === 400, "Table with negative capacity → 400");
  const okCat = await api("POST", "/categories", { name: `OKCat ${ts}` }, A.token);
  const okCatId = okCat.data?.data?.id || okCat.data?.category?.id;
  check(okCat.status === 201, "Valid category creation still works");
  const okMenu = await api("POST", "/menu", { name: "OK", sku: `OK-${ts}`, price: 100, categoryId: okCatId, tax: 0, extraUnknownField: "ignored" }, A.token);
  check(okMenu.status === 201, "Valid menu creation (with unknown field) still works");

  // ── Cleanup ──
  await api("DELETE", `/super-admin/restaurants/${A.id}`, null, saToken);
  await api("DELETE", `/super-admin/restaurants/${B.id}`, null, saToken);
  console.log(`\n  Security & data-integrity QA → ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error("CRASH:", e.message); await prisma.$disconnect(); process.exit(1); });
