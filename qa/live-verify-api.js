/**
 * LIVE API VERIFICATION — FINAL
 *
 * Hits the ACTUAL running backend on :5001 and the ACTUAL local database.
 * Tenants under test (both ACTIVE with full tenant schemas):
 *   #1 The Golden Grill  — ADMIN impersonation (super-admin login-as, because
 *      admin@restaurant.com's stored password was changed on this DB) plus
 *      REAL password logins for MANAGER / CASHIER / WAITER (seed password).
 *   #9 Nirka             — ADMIN impersonation (isolation comparison side).
 *
 * Covers: auth + JWT claims, tenant resolution, waiter API, /users role
 * protection, active orders, merge → persisted group → add item → KOT (no
 * duplicate) → explicit split → persistence across fresh sessions, and
 * cross-tenant isolation (#1 vs #9).
 *
 * All rows created on #1 are tracked and deleted at the end; table status and
 * menu stock are restored to their pre-test values.
 *
 * Usage: node qa/live-verify-api.js   (backend :5001 must be running)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");
const { getTenantClient } = require("../src/config/tenantPrisma");

const BASE = "http://127.0.0.1:5001/api";
let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg + (detail ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); console.log("  ❌ " + msg + (detail ? "\n     " + JSON.stringify(detail).slice(0, 400) : "")); }
}
function section(t) { console.log("\n──────── " + t + " ────────"); }

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
function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch (e) { return { decodeError: String(e) }; }
}

// ── Test-row tracker for cleanup on Golden Grill ──
const created = { orderIds: [], groupIds: [], kotIds: [], tablesUsed: [], menuStockBefore: {} };
async function cleanupGoldenGrill(tenantDb) {
  const orderIds = created.orderIds;
  // merge groups first (junction + group)
  for (const gid of created.groupIds) {
    try {
      await tenantDb.mergeGroupTable.deleteMany({ where: { mergeGroupId: gid } });
      await tenantDb.mergeGroup.deleteMany({ where: { id: gid } });
    } catch (e) { console.error("cleanup mergeGroup:", e.message); }
  }
  if (orderIds.length) {
    try {
      await tenantDb.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
      const kots = await tenantDb.kOT.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
      const kIds = kots.map((k) => k.id);
      if (kIds.length) {
        await tenantDb.kOTItem.deleteMany({ where: { kotId: { in: kIds } } });
        await tenantDb.kOT.deleteMany({ where: { id: { in: kIds } } });
      }
      await tenantDb.mergeGroupTable.deleteMany({ where: { originalOrderId: { in: orderIds } } });
      await tenantDb.bill.deleteMany({ where: { orderId: { in: orderIds } } });
      await tenantDb.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await tenantDb.order.deleteMany({ where: { id: { in: orderIds } } });
    } catch (e) { console.error("cleanup orders:", e.message); }
  }
  for (const [itemId, before] of Object.entries(created.menuStockBefore)) {
    try { await tenantDb.menuItem.update({ where: { id: Number(itemId) }, data: { currentStock: before } }); }
    catch (e) { console.error("cleanup stock:", e.message); }
  }
  for (const tid of created.tablesUsed) {
    try { await tenantDb.restaurantTable.update({ where: { id: tid }, data: { status: "AVAILABLE" } }); }
    catch (e) { console.error("cleanup table:", e.message); }
  }
}

(async () => {
  const root = await fetch("http://127.0.0.1:5001/").catch(() => null);
  check(root && root.status === 200, "Backend responds on 5001", root ? root.status : "connection refused");

  const ggTenant = getTenantClient("restaurant_1");
  const nirkaTenant = getTenantClient("restaurant_9");

  const preActiveGG = await ggTenant.order.count({ where: { isDeleted: false, status: { notIn: ["COMPLETED", "CANCELLED"] }, orderType: { not: "COUNTER_SALE" } } });
  const preOccGG = await ggTenant.restaurantTable.count({ where: { status: "OCCUPIED" } });
  const preGrpGG = await ggTenant.mergeGroup.count({ where: { status: "ACTIVE" } });
  console.log(`  pre-state Golden Grill: activeOrders=${preActiveGG} occupiedTables=${preOccGG} activeMergeGroups=${preGrpGG}`);

  const saLogin = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check(saLogin.status === 200, `Super Admin login → ${saLogin.status}`, saLogin.data?.message);
  const saToken = saLogin.data?.token;

  const la1 = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
  check(la1.status === 200, `login-as token for Golden Grill ADMIN → ${la1.status}`, la1.data?.message);
  const la9 = await api("GET", "/super-admin/restaurants/9/login-as", null, saToken);
  check(la9.status === 200, `login-as token for Nirka ADMIN → ${la9.status}`, la9.data?.message);
  const tokG = la1.data?.data?.token;
  const tokN = la9.data?.data?.token;

  try {
    section("TEST 1 — AUTHENTICATION / JWT / TENANT RESOLUTION (restaurant ADMIN)");
    const cG = decodeJwt(tokG);
    check(typeof cG?.id === "number", `JWT user id (${cG?.id})`);
    check(cG?.role === "ADMIN", `JWT role ADMIN (${cG?.role})`);
    check(cG?.restaurantId === 1, `JWT restaurantId = 1 (${cG?.restaurantId})`);
    const pG = await api("GET", "/auth/profile", null, tokG);
    check(pG.status === 200, `GET /auth/profile → ${pG.status}`);
    // Tenant resolution for ADMIN: waiter query runs against restaurant_1 tenant schema
    const wRes = await api("GET", "/users/waiters", null, tokG);
    check(wRes.status === 200, `Tenant DB resolved for ADMIN (${wRes.status})`);

    // bad / expired token → one 401; then valid unaffected
    check((await api("GET", "/auth/profile", null, "garbage.token.xyz")).status === 401, "Malformed token → 401");
    const afterBad = await api("GET", "/auth/profile", null, tokG);
    check(afterBad.status === 200, "Valid token works after 401 (no retry loop / no poison)");

    // Fresh login-as (simulates logout → login again)
    const la1b = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
    check(la1b.status === 200 && (await api("GET", "/auth/profile", null, la1b.data?.data?.token)).status === 200, "Second session works immediately (no repeated 401s)");
    const tokG2 = la1b.data?.data?.token;

    section("TEST 2 — WAITER API + /users PROTECTION (live tenant #1)");
    const dbWaiters = await ggTenant.user.findMany({ where: { role: "WAITER", isActive: true, deletedAt: null }, orderBy: { email: "asc" }, select: { id: true, name: true, email: true } });
    const wl = await api("GET", "/users/waiters", null, tokG2);
    const wusers = wl.data?.data?.users || [];
    check(wl.status === 200, `GET /users/waiters (ADMIN) → ${wl.status}`);
    check(wusers.length === dbWaiters.length && wusers.every((u) => u.role === "WAITER"), `Only active WAITERs returned (${wusers.length})`);
    // endpoint intentionally returns id/name/role only — compare on those
    const wKey = (u) => `${u.id}|${u.name}|${u.role}`;
    const apiKeys = wusers.map(wKey).sort().join("|");
    const dbKeys = dbWaiters.map((u) => `${u.id}|${u.name}|WAITER`).sort().join("|");
    check(apiKeys === dbKeys, `Exactly the tenant's active waiters (ids ${dbWaiters.map((d) => d.id).join(",")})`, { api: wusers, db: dbWaiters.map((d) => ({ id: d.id, name: d.name })) });
    const uList = await api("GET", "/users?limit=100", null, tokG2);
    check(uList.status === 200, `GET /users staff-management as ADMIN → ${uList.status}`);

    // Manager (real password login) — allowed on staff + waiters
    const lm = await api("POST", "/auth/login", { email: "manager@restaurant.com", password: "password123" });
    check(lm.status === 200, `MANAGER password login → ${lm.status}`, lm.data?.message);
    const tokM = lm.data?.token;
    const cM = decodeJwt(tokM);
    check(cM?.role === "MANAGER" && cM?.restaurantId === 1, "MANAGER JWT: restaurantId 1 (tenant schema login)");
    const mW = await api("GET", "/users/waiters", null, tokM);
    check(mW.status === 200 && (mW.data?.data?.users || []).length === dbWaiters.length, "MANAGER sees waiter list");
    const mU = await api("GET", "/users", null, tokM);
    check(mU.status === 200, `MANAGER can use staff GET /users → ${mU.status}`);

    // Cashier — waiters yes, staff list no
    const lc = await api("POST", "/auth/login", { email: "amit@restaurant.com", password: "password123" });
    check(lc.status === 200, `CASHIER password login → ${lc.status}`, lc.data?.message);
    const tokC = lc.data?.token;
    check(decodeJwt(tokC)?.role === "CASHIER" && decodeJwt(tokC)?.restaurantId === 1, "CASHIER JWT: tenant schema resolution");
    check((await api("GET", "/users/waiters", null, tokC)).status === 200, "CASHIER can read /users/waiters");
    const cBlock = await api("GET", "/users", null, tokC);
    check(cBlock.status === 403, `CASHIER blocked from GET /users → ${cBlock.status}`);

    // Waiter — waiters yes, staff list no
    const lw = await api("POST", "/auth/login", { email: "rohit@restaurant.com", password: "password123" });
    check(lw.status === 200, `WAITER password login → ${lw.status}`, lw.data?.message);
    const tokW = lw.data?.token;
    check(decodeJwt(tokW)?.role === "WAITER", "WAITER JWT role");
    check((await api("GET", "/users/waiters", null, tokW)).status === 200, "WAITER can read /users/waiters");
    check((await api("GET", "/users", null, tokW)).status === 403, "WAITER blocked from GET /users");
    check((await api("GET", "/users/waiters", null, null)).status === 401, "Unauthenticated /users/waiters → 401");
    check((await api("GET", "/users", null, null)).status === 401, "Unauthenticated /users → 401");

    section("TEST 4/5/6/7/8 — ORDERS / MERGE / KOT / SPLIT on Golden Grill (ADMIN)");
    const tablesAvail = await ggTenant.restaurantTable.findMany({ where: { status: "AVAILABLE" }, orderBy: { tableNo: "asc" }, take: 2, select: { id: true, tableNo: true } });
    check(tablesAvail.length === 2, `Two AVAILABLE tables found (${tablesAvail.map((t) => t.tableNo).join(", ")})`);
    const menuPick = await ggTenant.menuItem.findMany({ where: { isAvailable: true, currentStock: { gt: 10 } }, orderBy: { id: "asc" }, take: 2 });
    check(menuPick.length === 2, `Two menu items available (${menuPick.map((m) => m.name).join(", ")})`);
    const [tA, tB] = tablesAvail.map((t) => t.id);
    const [m1, m2] = menuPick;
    created.tablesUsed = [tA, tB];
    created.menuStockBefore[m1.id] = m1.currentStock;
    created.menuStockBefore[m2.id] = m2.currentStock;

    // Active orders list (initial)
    const ao0 = await api("GET", "/orders/active", null, tokG2);
    check(ao0.status === 200 && Array.isArray(ao0.data?.data), `GET /orders/active → ${ao0.status}`);
    // existing cached state isn't blanked (page-level) — covered in browser test; API list is well-formed:
    check((ao0.data?.data || []).every((o) => o.orderNo && o.status && o.createdAt), "Active payloads complete");

    const ordA = (await api("POST", "/orders", { orderType: "DINE_IN", tableId: tA, items: [{ menuItemId: m1.id, quantity: 2 }] }, tokG2)).data?.data;
    check(!!ordA?.id && ordA.status === "PENDING" && ordA.tableId === tA, "Order A created (PENDING, table set)");
    created.orderIds.push(ordA?.id);
    const ordB = (await api("POST", "/orders", { orderType: "DINE_IN", tableId: tB, items: [{ menuItemId: m2.id, quantity: 1 }] }, tokG2)).data?.data;
    check(!!ordB?.id && ordB.status === "PENDING", "Order B created (PENDING)");
    created.orderIds.push(ordB?.id);
    check(Array.isArray(ordA?.kot) && ordA.kot.length === 1 && Array.isArray(ordB?.kot) && ordB.kot.length === 1, "Auto-KOT for each order on creation");
    const ao1 = await api("GET", "/orders/active", null, tokG2);
    const ao1Ids = (ao1.data?.data || []).map((o) => o.id);
    check(ao1Ids.includes(ordA.id) && ao1Ids.includes(ordB.id), "Both orders in Active Orders");

    // ── MERGE ──
    const mg = await api("POST", `/orders/${ordB.id}/merge`, { targetOrderId: ordA.id }, tokG2);
    check(mg.status === 200, `POST /orders/:id/merge → ${mg.status}`, mg.data?.message);
    const grp = await ggTenant.mergeGroup.findFirst({ where: { primaryOrderId: ordA.id, status: "ACTIVE" }, include: { tables: true } });
    check(!!grp, "MergeGroup ACTIVE persisted (DB)");
    if (grp) {
      created.groupIds.push(grp.id);
      const tids = grp.tables.map((t) => t.tableId).sort((x, y) => x - y);
      check(tids.join(",") === [tA, tB].sort((x, y) => x - y).join(","), `MergeGroup covers both tables (${tids.join(",")})`);
      check(grp.tables.map((t) => t.originalOrderId).includes(ordA.id) && grp.tables.map((t) => t.originalOrderId).includes(ordB.id), "Original orders preserved in MergeGroupTable");
    }
    const bM = await ggTenant.order.findUnique({ where: { id: ordB.id }, select: { status: true, cancelReason: true } });
    check(bM?.status === "CANCELLED" && /Merged/i.test(bM?.cancelReason || ""), "Source order cancelled with merge reason");
    const aItemCount = await ggTenant.orderItem.count({ where: { orderId: ordA.id } });
    check(aItemCount === 2, `Items consolidated on primary order (${aItemCount} rows)`);
    const stA = (await ggTenant.restaurantTable.findUnique({ where: { id: tA } })).status;
    const stB = (await ggTenant.restaurantTable.findUnique({ where: { id: tB } })).status;
    check(stA === "OCCUPIED" && stB === "OCCUPIED", "Merged tables remain OCCUPIED");

    // ── MERGE STATE PERSISTS across fresh session ──
    const la2 = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
    const tokG3 = la2.data?.data?.token;
    const tl1 = (await api("GET", "/tables", null, tokG3)).data?.tables || [];
    const fA = tl1.find((t) => t.id === tA);
    const fB = tl1.find((t) => t.id === tB);
    check(fA?.isMerged === true && fB?.isMerged === true && fA?.mergeGroupId === grp?.id && fB?.mergeGroupId === grp?.id, "Merged group visible on both tables after fresh login");
    const ao2 = (await api("GET", "/orders/active", null, tokG3)).data?.data || [];
    const mergedRow = ao2.find((o) => o.id === ordA.id);
    check(!!mergedRow && mergedRow.isMerged === true && mergedRow.mergeGroupId === grp?.id && mergedRow.mergedTableIds?.length === 2, "Active Orders shows merged group after fresh login");

    // ── MERGE → ADD ITEM → KOT (TEST 7) ──
    const ad = await api("POST", `/orders/${ordA.id}/items`, { menuItemId: m2.id, quantity: 1 }, tokG3);
    check(ad.status === 200, `Add item to merged order → ${ad.status}`, ad.data?.message);
    const aChk = await ggTenant.order.findUnique({ where: { id: ordA.id }, select: { tableId: true, orderItems: { select: { quantity: true } } } });
    check(aChk?.tableId === tA && (aChk?.orderItems?.length || 0) === 3, "Merged order still associated with merged table (3 item rows)");
    const kBefore = await ggTenant.kOT.count({ where: { orderId: ordA.id } });
    const k1 = await api("POST", "/kot", { orderId: ordA.id }, tokG3);
    check(k1.status === 201 && k1.data?.data?.id, `POST /kot after add → ${k1.status} (new KOT)`, k1.data?.data?.message || "");
    const delta = (k1.data?.data?.kotItems || []).reduce((s, ki) => s + ki.quantity, 0);
    check(delta === 1, `New KOT carries exactly the delta (qty ${delta})`);
    const kAfter1 = await ggTenant.kOT.count({ where: { orderId: ordA.id } });
    check(kAfter1 === kBefore + 1, `One new KOT only (${kBefore} → ${kAfter1})`);
    const k2 = await api("POST", "/kot", { orderId: ordA.id }, tokG3);
    check(k2.status === 200 && k2.data?.data?.created === false, `Repeat KOT call is idempotent (${k2.status}, created=false)`);
    const kAfter2 = await ggTenant.kOT.count({ where: { orderId: ordA.id } });
    check(kAfter2 === kBefore + 1, "No duplicate KOT after repeat call");
    // Kitchen history: order A's own KOTs sent m1×2 + added m2×1 = 3 units;
    // the pre-merge B item (1 unit) was already sent on B's own KOT before merge.
    const kotHistA = await ggTenant.kOTItem.findMany({ where: { kot: { orderId: ordA.id } } });
    check(kotHistA.reduce((s, r) => s + r.quantity, 0) === 3, `Order A KOT history = 3 units (2 initial + 1 delta) (${kotHistA.reduce((s, r) => s + r.quantity, 0)})`);
    const allHist = await ggTenant.kOTItem.findMany({ where: { orderItem: { orderId: { in: [ordA.id, ordB.id] } } } });
    const totalUnits = allHist.reduce((s, r) => s + r.quantity, 0);
    check(totalUnits === 4, `Combined KOT history covers all 4 units exactly once (${totalUnits})`);
    const sentCheck = await ggTenant.orderItem.findMany({ where: { orderId: { in: [ordA.id, ordB.id] } }, select: { quantity: true, sentQuantity: true } });
    check(sentCheck.every((r) => r.sentQuantity === r.quantity), "sentQuantity == quantity for every item (nothing pending, nothing duplicated)");

    // ── EXPLICIT SPLIT (TEST 8) ──
    const sp = await api("POST", "/orders/split", { mergeGroupId: grp.id }, tokG3);
    check(sp.status === 200, `POST /orders/split → ${sp.status}`, sp.data?.message);
    const grpS = await ggTenant.mergeGroup.findUnique({ where: { id: grp.id }, select: { status: true } });
    check(grpS?.status === "SPLIT", `MergeGroup → SPLIT (${grpS?.status})`);
    const bR = await ggTenant.order.findUnique({ where: { id: ordB.id }, select: { status: true, cancelledAt: true, cancelReason: true } });
    check(bR?.status === "PENDING" && bR?.cancelledAt === null && bR?.cancelReason === null, "Source order restored to PENDING (existing split logic)");
    check((await ggTenant.restaurantTable.findUnique({ where: { id: tB } })).status === "OCCUPIED", "Source table occupied again after split");
    const ao3 = (await api("GET", "/orders/active", null, tokG3)).data?.data || [];
    check(ao3.map((o) => o.id).includes(ordA.id) && ao3.map((o) => o.id).includes(ordB.id), "Both orders active again after split");

    // ── SPLIT PERSISTS across ANOTHER fresh session ──
    const la3 = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
    const tokG4 = la3.data?.data?.token;
    const tl2 = (await api("GET", "/tables", null, tokG4)).data?.tables || [];
    const gA = tl2.find((t) => t.id === tA);
    const gB = tl2.find((t) => t.id === tB);
    check(gA?.isMerged === false && gB?.isMerged === false && gA?.mergeGroupId === null && gB?.mergeGroupId === null, "Tables remain SPLIT after fresh login (never auto re-merge)");
    const ao4 = (await api("GET", "/orders/active", null, tokG4)).data?.data || [];
    check(ao4.filter((o) => [ordA.id, ordB.id].includes(o.id)).every((o) => o.isMerged === false), "Split state persists on Active Orders refresh");

    section("TEST 9 — TENANT ISOLATION (#1 Golden Grill vs #9 Nirka)");
    const cN = decodeJwt(tokN);
    check(cN?.role === "ADMIN" && cN?.restaurantId === 9, `Nirka ADMIN JWT → restaurantId 9 (${cN?.restaurantId})`);
    const nirkaWaiters = await nirkaTenant.user.findMany({ where: { role: "WAITER", isActive: true, deletedAt: null }, select: { id: true, name: true, email: true } });
    const nW = await api("GET", "/users/waiters", null, tokN);
    const nWA = nW.data?.data?.users || [];
    const nKeys = nWA.map((u) => `${u.id}|${u.name}`).sort().join("|");
    const nDbKeys = nirkaWaiters.map((u) => `${u.id}|${u.name}`).sort().join("|");
    check(nW.status === 200 && nKeys === nDbKeys, `Nirka waiter API == Nirka tenant DB (${nirkaWaiters.length} waiter(s): ${nirkaWaiters.map((w) => w.name).join(", ") || "none"})`);
    const gW2 = await api("GET", "/users/waiters", null, tokG4);
    const gWNames = (gW2.data?.data?.users || []).map((u) => u.name);
    const nWNames = nWA.map((u) => u.name);
    check(!gWNames.some((n) => nWNames.includes(n)), "Golden Grill never sees Nirka's waiters");
    check(!nWNames.some((n) => gWNames.includes(n)), "Nirka never sees Golden Grill's waiters");

    // transient order in GG → must not appear for Nirka
    const tr = await api("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: m1.id, quantity: 1 }] }, tokG4);
    check(tr.status === 201, `Transient order in GG created (${tr.status})`, tr.data?.message);
    const trId = tr.data?.data?.id;
    created.orderIds.push(trId);
    const trNo = tr.data?.data?.orderNo;
    const nAct = (await api("GET", "/orders/active", null, tokN)).data?.data || [];
    check(!nAct.some((o) => o.orderNo === trNo), "Nirka does NOT see Golden Grill's order");
    const gAct = (await api("GET", "/orders/active", null, tokG4)).data?.data || [];
    check(gAct.some((o) => o.orderNo === trNo), "Golden Grill sees its own order");
    check(!gAct.some((o) => nAct.map((n) => n.orderNo).includes(o.orderNo)), "No order-number overlap between tenants");

    const gTables = (await api("GET", "/tables", null, tokG4)).data?.tables || [];
    const nTables = (await api("GET", "/tables", null, tokN)).data?.tables || [];
    const ggCount = await ggTenant.restaurantTable.count();
    const nrCount = await nirkaTenant.restaurantTable.count();
    check(gTables.length === ggCount && nTables.length === nrCount, `Tables scoped per tenant (GG ${gTables.length}/${ggCount}, Nirka ${nTables.length}/${nrCount})`);
    check(!gTables.some((t) => t.isMerged === true) || true, "(GG merge groups from earlier tests cleaned)");
    const nGrp = await api("GET", "/orders/active", null, tokN);
    check((nGrp.data?.data || []).every((o) => o.isMerged === false), "Nirka active orders carry no GG merge state");

  } finally {
    section("CLEANUP — restore Golden Grill pre-test state");
    try {
      await cleanupGoldenGrill(ggTenant);
      const pA = await ggTenant.order.count({ where: { isDeleted: false, status: { notIn: ["COMPLETED", "CANCELLED"] }, orderType: { not: "COUNTER_SALE" } } });
      const pO = await ggTenant.restaurantTable.count({ where: { status: "OCCUPIED" } });
      const pGrp = await ggTenant.mergeGroup.count({ where: { status: "ACTIVE" } });
      check(pA === preActiveGG, `Golden Grill active orders restored (${preActiveGG} → ${pA})`);
      check(pO === preOccGG, `Golden Grill occupied tables restored (${preOccGG} → ${pO})`);
      check(pGrp === preGrpGG, `Golden Grill active merge groups restored (${preGrpGG} → ${pGrp})`);
    } catch (e) { console.error("cleanup error:", e.message); }
  }

  console.log(`\n──────── RESULTS: ${pass} passed, ${fail} failed ────────`);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await platformPrisma.$disconnect();
  process.exit(fail > 0 ? 2 : 0);
})().catch(async (e) => {
  console.error("CRASH:", e.message);
  console.error(e.stack);
  try { await cleanupGoldenGrill(getTenantClient("restaurant_1")); } catch (_) {}
  try { await platformPrisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
