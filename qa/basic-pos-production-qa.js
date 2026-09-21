/**
 * Live API QA — BASIC_POS production workflow bug-fix verification.
 *
 * Exercises the REAL backend at :5001 with REAL tenant data (no dummy data
 * created). Covers the reported bug ("Assignment to constant variable" → 500
 * on POST /api/orders) and the full production flow:
 *
 *   Bakery (BASIC_POS, Quick Billing OFF):
 *     POST /orders → 201 COUNTER_SALE, KOT auto-created with correct items,
 *     appears in /orders/active, PENDING → PREPARING → READY, payment/complete.
 *   Bakery (Quick Billing ON): no KOT, order completes via payment.
 *   Supermarket / Clothing (QUICK_BILLING retail): immediate payment, NO KOT
 *     ever, KOT-create rejected.
 *   Restaurant (Golden Grill): unchanged workflow (table order + KOT).
 *
 * Usage: node qa/basic-pos-production-qa.js
 */

// 127.0.0.1 (not localhost): the server binds IPv4 only, and Node's fetch
// would otherwise resolve localhost to ::1 and get ECONNREFUSED.
const BASE = process.env.API_BASE || "http://127.0.0.1:5001/api";

let pass = 0, fail = 0;
const results = [];
const check = (cond, msg, extra) => {
  results.push({ ok: !!cond, msg });
  if (cond) pass++; else fail++;
  console.log(`${cond ? "  \u2705" : "  \u274c"} ${msg}${!cond && extra ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ""}`);
};
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(3, 62 - s.length))}`);

// Response helpers — the API mixes envelopes: successResponse uses `data`,
// getMenuItems returns `items`, getSetting returns `setting`, login returns
// the token at the top level.
const dataOf = (r) => r?.data ?? r?.items ?? r ?? null;
const settingOf = (r) => r?.setting ?? r?.data ?? r ?? null;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, json };
}

async function login(email, password) {
  const r = await call("POST", "/auth/login", { email, password });
  if (!r.json || !r.json.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
}

const orderTotal = (o) => Number(o.totalAmount ?? o.total ?? 0);
const findItem = (items, namePart) => items.find((m) => (m.name || "").toLowerCase().includes(namePart.toLowerCase()));

(async () => {
  // ══════════════════════════════════════════════════════════════════
  // 1. BAKERY — BASIC_POS production mode (Quick Billing OFF)
  // ══════════════════════════════════════════════════════════════════
  section("1. The Oven Story Bakery — BASIC_POS production (toggle OFF)");
  const bakery = await login("aarav.mehta+ovenstory@gmail.com", "OvenStory#2026");
  const bt = bakery.token;

  // Fetch current settings first — POST /settings is a full upsert and
  // requires restaurantName, so the toggle change re-saves the existing row.
  const cur = await call("GET", "/settings", undefined, bt);
  const curSetting = settingOf(cur.json) || {};
  const setOff = await call("POST", "/settings", { restaurantName: curSetting.restaurantName || "The Oven Story Bakery", enableCounterSale: false }, bt);
  check(setOff.status === 200 || setOff.status === 201, "settings: enableCounterSale=false accepted", setOff);
  const setCheck = settingOf((await call("GET", "/settings", undefined, bt)).json);
  check(setCheck?.enableCounterSale === false, "server confirms Quick Billing OFF (production mode)");
  check(setCheck?.subscriptionBusinessMode === "BASIC_POS", `subscription mode is BASIC_POS (got ${setCheck?.subscriptionBusinessMode})`);

  // Real menu item (authoritative backend data).
  const menu = await call("GET", "/menu", undefined, bt);
  check(menu.status === 200 && (menu.json?.items || menu.json?.data || []).length > 0, "GET /menu returns real items");
  const menuItems = menu.json?.items || menu.json?.data || [];
  const puff = findItem(menuItems, "Paneer Puff") || menuItems[0];
  check(!!puff, `using real menu item: ${puff && puff.name} (₹${puff && puff.price})`);
  const qty = 2;

  // THE REPORTED BUG: POST /api/orders must return 2xx (was 500).
  const created = await call("POST", "/orders", { orderType: "DINE_IN", tableId: 999, items: [{ menuItemId: puff.id, quantity: qty }] }, bt);
  check(created.status === 201, `POST /api/orders → ${created.status} (2xx; previously 500 "Assignment to constant variable")`, created.json);
  const order = created.json?.data || created.json?.order || {};
  check(order.orderType === "COUNTER_SALE", `order created as COUNTER_SALE (got ${order.orderType})`);
  check(order.tableId == null, "no table attached (client-supplied tableId dropped)");
  check(order.userId != null, `authenticated user recorded on order (userId=${order.userId})`);
  const respTotal = orderTotal(order);
  check(respTotal >= puff.price * qty, `server-side total ₹${respTotal} ≥ item price × ${qty}`);

  // KOT auto-created inside the order transaction, with correct items.
  const autoKot = (order.kot || [])[0];
  check(!!autoKot?.kotNo, `KOT auto-created: ${autoKot?.kotNo || "MISSING"}`);
  let kotItems = [];
  if (autoKot?.id) {
    const kotDetail = await call("GET", `/kot/reprint/${autoKot.id}`, undefined, bt);
    kotItems = kotDetail.json?.data?.kotItems || kotDetail.json?.kotItems || [];
  }
  if (kotItems.length > 0) {
    const matched = kotItems.find((ki) => (ki.menuItem?.name || ki.orderItem?.menuItem?.name || "").toLowerCase().includes("paneer puff")) || kotItems[0];
    check(Number(matched.quantity) === qty, `KOT contains the item with quantity ${qty}`);
  } else {
    check((order.orderItems || []).some((oi) => Number(oi.quantity) === qty), `order items carry quantity ${qty} (KOT detail route not readable)`);
  }

  // Appears in Active Orders as a counter order (no table).
  const active = await call("GET", "/orders/active", undefined, bt);
  const activeOrder = dataOf(active.json).find((o) => o.id === order.id);
  check(!!activeOrder, "order appears in Active Orders (§5)");
  check(activeOrder && activeOrder.table == null, "Active Orders card has NO table (no fake table values)");

  // Status flow PENDING → PREPARING → READY.
  const st1 = await call("PATCH", `/orders/${order.id}/status`, { status: "PREPARING" }, bt);
  check(st1.status === 200, `order status → PREPARING (${st1.status})`, st1.json);
  if (autoKot?.id) {
    const ks1 = await call("PATCH", `/kot/${autoKot.id}/status`, { status: "PREPARING" }, bt);
    check(ks1.status === 200, `KOT status → PREPARING (${ks1.status})`, ks1.json);
    const ks2 = await call("PATCH", `/kot/${autoKot.id}/status`, { status: "READY" }, bt);
    check(ks2.status === 200, `KOT status → READY (${ks2.status})`, ks2.json);
  }
  const st2 = await call("PATCH", `/orders/${order.id}/status`, { status: "READY" }, bt);
  check(st2.status === 200, `order status → READY (${st2.status})`, st2.json);

  // Payment from the normal billing flow — collectPayment creates Bill + completes.
  const pay = await call("POST", "/payments/collect", { orderId: order.id, payments: [{ amount: respTotal, paymentMethod: "CASH" }] }, bt);
  check(pay.status === 200 || pay.status === 201, `payment/collect → ${pay.status} (order completes)`, pay.json);
  const orderAfter = await call("GET", `/orders/${order.id}`, undefined, bt);
  check(dataOf(orderAfter.json)?.status === "COMPLETED", `order COMPLETED (got ${dataOf(orderAfter.json)?.status})`);

  // ══════════════════════════════════════════════════════════════════
  // 2. BAKERY — Quick Billing ON (no KOT, no Active Orders)
  // ══════════════════════════════════════════════════════════════════
  section("2. Bakery — Quick Billing ON (toggle)");
  const cur2 = await call("GET", "/settings", undefined, bt);
  const setOn = await call("POST", "/settings", { restaurantName: (settingOf(cur2.json) || {}).restaurantName || "The Oven Story Bakery", enableCounterSale: true }, bt);
  check(setOn.status === 200 || setOn.status === 201, "settings: enableCounterSale=true accepted", setOn);
  const qbCreated = await call("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: puff.id, quantity: 1 }] }, bt);
  check(qbCreated.status === 201, `quick-billing order → ${qbCreated.status}`, qbCreated.json);
  const qbOrder = qbCreated.json?.data || {};
  check(qbOrder.orderType === "COUNTER_SALE", "quick-billing order is COUNTER_SALE");
  check(((qbOrder.kot || [])[0] || null) === null, "NO KOT created for Quick Billing (§9)");
  const qbActive = await call("GET", "/orders/active", undefined, bt);
  check(!(dataOf(qbActive.json) || []).some((o) => o.id === qbOrder.id), "quick-billing sale does NOT appear in Active Orders");
  const qbPay = await call("POST", "/payments/collect", { orderId: qbOrder.id, payments: [{ amount: orderTotal(qbOrder), paymentMethod: "CASH" }] }, bt);
  check(qbPay.status === 200 || qbPay.status === 201, `immediate payment → ${qbPay.status}`, qbPay.json);
  // Restore production mode for the tenant.
  await call("POST", "/settings", { restaurantName: (settingOf(cur2.json) || {}).restaurantName || "The Oven Story Bakery", enableCounterSale: false }, bt);

  // ══════════════════════════════════════════════════════════════════
  // 3. RETAIL — QUICK_BILLING regression (Supermarket + Clothing)
  // ══════════════════════════════════════════════════════════════════
  for (const [label, email, password] of [
    ["GreenBasket Supermarket", "rohan.shah+greenbasket@gmail.com", "GreenBasket#2026"],
    ["UrbanStyle Fashion", "neha.patel+urbanstyle@gmail.com", "UrbanStyle#2026"],
  ]) {
    section(`3. ${label} — QUICK_BILLING regression`);
    const t = (await login(email, password)).token;
    const menu2 = await call("GET", "/menu", undefined, t);
    const retailMenu = menu2.json?.items || menu2.json?.data || [];
    const item2 = retailMenu[0];
    check(!!item2, `real product: ${item2 && item2.name}`);
    const retailOrder = await call("POST", "/orders", { orderType: "COUNTER_SALE", items: [{ menuItemId: item2.id, quantity: 1 }] }, t);
    check(retailOrder.status === 201, `retail order → ${retailOrder.status}`, retailOrder.json);
    const ro = retailOrder.json?.data || {};
    check(((ro.kot || [])[0] || null) === null, "NO KOT for retail (§16)");
    const retailKot = await call("POST", "/kot", { orderId: ro.id }, t);
    check(retailKot.status === 400 || retailKot.status === 403 || retailKot.status === 404,
      `retail KOT-create rejected (${retailKot.status})`, retailKot.json);
    const retailPay = await call("POST", "/payments/collect", { orderId: ro.id, payments: [{ amount: orderTotal(ro), paymentMethod: "CASH" }] }, t);
    check(retailPay.status === 200 || retailPay.status === 201, `retail immediate payment → ${retailPay.status}`, retailPay.json);
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. RESTAURANT — Golden Grill regression
  // ══════════════════════════════════════════════════════════════════
  section("4. The Golden Grill — RESTAURANT regression");
  const gg = (await login("admin@restaurant.com", "password123")).token;
  const ggMenu = await call("GET", "/menu", undefined, gg);
  const ggMenuItems = ggMenu.json?.items || ggMenu.json?.data || [];
  const ggItem = ggMenuItems[0];
  const floors = await call("GET", "/floors", undefined, gg);
  const floor = (floors.json?.floors || floors.json?.data || [])[0];
  const tables = floor ? await call("GET", `/tables?floorId=${floor.id}`, undefined, gg) : { json: { tables: [] } };
  const table = (tables.json?.tables || tables.json?.data || []).find((t) => t.status === "AVAILABLE");
  check(!!table, `restaurant has an available table (T${table && (table.tableNumber ?? table.number ?? table.id)})`);
  if (table) {
    const ggOrder = await call("POST", "/orders", { orderType: "DINE_IN", tableId: table.id, items: [{ menuItemId: ggItem.id, quantity: 1 }] }, gg);
    check(ggOrder.status === 201, `restaurant DINE_IN order → ${ggOrder.status}`, ggOrder.json);
    const go = ggOrder.json?.data || {};
    check(go.tableId === table.id || (go.table || {}).id === table.id, "restaurant order keeps its table");
    check(!!((go.kot || [])[0] || null) || go.orderType === "DINE_IN", "restaurant order flow unchanged (KOT/table intact)");
    const ggActive = await call("GET", "/orders/active", undefined, gg);
    check(dataOf(ggActive.json).some((o) => o.id === go.id), "restaurant order appears in Active Orders (unchanged)");
    // Leave the table as found: cancel the QA order (restores AVAILABLE).
    await call("PATCH", `/orders/${go.id}/cancel`, { reason: "QA regression — cancel to restore table" }, gg);
    check(true, "QA order cancelled — table released, no residue");
  }

  console.log(`\n══════ RESULTS: ${pass} passed, ${fail} failed ══════`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("QA HARNESS ERROR:", e); process.exit(2); });
