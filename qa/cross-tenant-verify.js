/**
 * CROSS-TENANT ISOLATION — E2E verification (auth + tenant resolution + writes)
 *
 * Hits the ACTUAL running backend on :5001 and the actual local database.
 * Tenants under test (all ACTIVE): restaurant_1, restaurant_2, restaurant_9.
 *
 * Covers:
 *   A. Real tenant-staff password login (restaurant_1 MANAGER, password123)
 *   B/E/G. Tenant-scoped /api/menu data per restaurant (DB ground truth)
 *   C. restaurantId query override attempts must stay within the caller tenant
 *   H/I/J. Cross-tenant read attempts constrained to own tenant
 *   K. ADMIN staff creation with a hostile body restaurantId → must land in the
 *      caller's OWN tenant with restaurantId = caller's restaurant
 *   L. SUPER_ADMIN staff creation (restaurant_2 / restaurant_9 MANAGERs) must
 *      set restaurantId on the tenant row, and those staff must log in + stay
 *      inside their own tenant
 *   M. MANAGER cannot create staff (existing permission matrix)
 *   N. Socket.IO: valid tenant token connects; forged/mismatched restaurant
 *      token is rejected at connect (DB-authoritative identity)
 *   O. DB: no NULL/mismatched tenant User.restaurantId, sequences >= MAX(id)
 *
 * All QA-created users are deleted at the end (finally) — no production data is
 * touched besides tracked temp rows.
 *
 * Usage: node qa/cross-tenant-verify.js   (backend :5001 must be running)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const jwt = require("jsonwebtoken");
const { platformPrisma } = require("../src/config/tenantPrisma");
const { getTenantClient } = require("../src/config/tenantPrisma");

const BASE = "http://127.0.0.1:5001/api";
let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg + (detail ? " :: " + JSON.stringify(detail).slice(0, 500) : "")); console.log("  ❌ " + msg + (detail ? "\n     " + JSON.stringify(detail).slice(0, 500) : "")); }
}
function section(t) { console.log("\n──────── " + t + " ────────"); }

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
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

const TENANTS = [
  { id: 1, schema: "restaurant_1" },
  { id: 2, schema: "restaurant_2" },
  { id: 9, schema: "restaurant_9" },
];
const tenantClients = {};
for (const t of TENANTS) tenantClients[t.id] = getTenantClient(t.schema);

// QA users created during this run (deleted in finally)
const createdTenantUsers = []; // { client, id, restaurantId, email }

(async () => {
  // ── Backend alive ──
  const root = await fetch("http://127.0.0.1:5001/").catch(() => null);
  check(root && root.status === 200, "Backend responds on 5001", root ? root.status : "connection refused");

  section("SUPER ADMIN + LOGIN-AS tokens");
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check(sa.status === 200, `SUPER_ADMIN password login → ${sa.status}`, sa.data?.message || sa.data);
  const saToken = sa.data?.token;
  check(saToken && decodeJwt(saToken)?.role === "SUPER_ADMIN" && !decodeJwt(saToken)?.restaurantId, "SUPER_ADMIN JWT: role SUPER_ADMIN, no restaurantId claim");

  const admTokens = {};
  for (const t of TENANTS) {
    const la = await api("GET", `/super-admin/restaurants/${t.id}/login-as`, null, saToken);
    check(la.status === 200, `login-as ADMIN token for restaurant ${t.id} → ${la.status}`, la.data?.message);
    const tok = la.data?.data?.token;
    admTokens[t.id] = tok;
    const c = decodeJwt(tok);
    check(c?.role === "ADMIN" && Number(c?.restaurantId) === t.id, `JWT claims for restaurant ${t.id} ADMIN (${c?.role} @ ${c?.restaurantId})`);
    const prof = await api("GET", "/auth/profile", null, tok);
    check(prof.status === 200, `GET /auth/profile (restaurant ${t.id}) → ${prof.status}`);
  }

  // ── Ground truth: menu item id sets + user counts from the DB ──
  const ground = {};
  for (const t of TENANTS) {
    const db = tenantClients[t.id];
    const items = await db.menuItem.findMany({ select: { id: true, name: true }, orderBy: { id: "asc" } });
    const users = await db.user.findMany({ select: { id: true, email: true, role: true } });
    const tables = await db.restaurantTable.count();
    ground[t.id] = { itemIds: items.map((i) => i.id), itemNames: items.map((i) => i.name), userCount: users.length, tables, users };
  }
  for (const t of TENANTS) console.log(`  ground restaurant_${t.id}: menuItems=${ground[t.id].itemIds.length} users=${ground[t.id].userCount} tables=${ground[t.id].tables}`);

  function menuIdSet(payload) {
    const arr = (payload?.items || payload?.data?.items || payload?.data || []).map((x) => x.id);
    return arr.slice().sort((a, b) => a - b).join(",");
  }

  section("TEST A — restaurant_1 MANAGER real password login (tenant staff)");
  const lm = await api("POST", "/auth/login", { email: "manager@restaurant.com", password: "password123" });
  check(lm.status === 200, `MANAGER login → ${lm.status}`, lm.data?.message || lm.data);
  const tokM1 = lm.data?.token;
  const cM1 = decodeJwt(tokM1);
  check(cM1?.role === "MANAGER" && Number(cM1?.restaurantId) === 1, `MANAGER JWT: role=${cM1?.role} restaurantId=${cM1?.restaurantId} (must be 1)`);

  section("TEST B/C — tenant-scoped menu + restaurantId query override (restaurant_1 MANAGER)");
  const m1 = await api("GET", "/menu", null, tokM1);
  check(m1.status === 200, `GET /api/menu (MANAGER r1) → ${m1.status}`);
  const m1Ids = menuIdSet(m1.data);
  check(m1Ids === ground[1].itemIds.sort((a, b) => a - b).join(","), `Menu == restaurant_1 DB set (${m1Ids.split(",").length} items)`);
  const m1X = await api("GET", "/menu?restaurantId=2", null, tokM1);
  check(m1X.status === 200 && menuIdSet(m1X.data) === m1Ids, "GET /menu?restaurantId=2 → STILL restaurant_1 data (override blocked)");
  const m1X9 = await api("GET", "/menu?restaurantId=9", null, tokM1);
  check(m1X9.status === 200 && menuIdSet(m1X9.data) === m1Ids, "GET /menu?restaurantId=9 → STILL restaurant_1 data (override blocked)");
  const t1 = await api("GET", "/tables", null, tokM1);
  check(t1.status === 200 && (t1.data?.tables || []).length === ground[1].tables, `Tables scoped to restaurant_1 (${(t1.data?.tables || []).length}/${ground[1].tables})`);

  section("TEST D/E — restaurant_2 tenant staff (temp MANAGER via SUPER_ADMIN)");
  const suffix = Date.now();
  const m2Email = `ctqa.mgr2.${suffix}@ctqa.com`;
  const m2Create = await api("POST", "/super-admin/users", { restaurantId: 2, name: "CT QA Manager R2", email: m2Email, password: "CrossTenant@123", role: "MANAGER" }, saToken);
  check(m2Create.status === 201, `SUPER_ADMIN created MANAGER in restaurant_2 → ${m2Create.status}`, m2Create.data?.message || m2Create.data);
  const m2Row = m2Create.data?.data?.id ? m2Create.data.data : null;
  if (m2Row) createdTenantUsers.push({ client: tenantClients[2], id: m2Row.id, restaurantId: 2, email: m2Email });
  const m2Db = m2Row ? await tenantClients[2].user.findUnique({ where: { id: m2Row.id }, select: { id: true, restaurantId: true, role: true } }) : null;
  check(m2Db && m2Db.restaurantId === 2 && m2Db.role === "MANAGER", "restaurant_2 row has restaurantId=2 (SA create sets restaurantId)");
  const lm2 = await api("POST", "/auth/login", { email: m2Email, password: "CrossTenant@123" });
  check(lm2.status === 200, `restaurant_2 MANAGER login → ${lm2.status}`, lm2.data?.message || lm2.data);
  const tokM2 = lm2.data?.token;
  const cM2 = decodeJwt(tokM2);
  check(cM2?.role === "MANAGER" && Number(cM2?.restaurantId) === 2, `JWT: role=${cM2?.role} restaurantId=${cM2?.restaurantId} (must be 2)`);
  const m2menu = await api("GET", "/menu", null, tokM2);
  check(m2menu.status === 200 && menuIdSet(m2menu.data) === ground[2].itemIds.sort((a, b) => a - b).join(","), "Menu == restaurant_2 DB set");
  const m2x = await api("GET", "/menu?restaurantId=1", null, tokM2);
  check(m2x.status === 200 && menuIdSet(m2x.data) === menuIdSet(m2menu.data), "GET /menu?restaurantId=1 → STILL restaurant_2 data (override blocked)");
  // staff list is read AFTER the temp MANAGER was created for this run, so it
  // must contain the pre-existing users PLUS the temp manager (proves the temp
  // row landed in this tenant's own list, and only here)
  const m2u = await api("GET", "/users?limit=100", null, tokM2);
  const m2Emails = (m2u.data?.data?.users || []).map((u) => u.email);
  check(m2u.status === 200 && m2Emails.length === ground[2].userCount + 1 && m2Emails.includes(m2Email), `Staff list == restaurant_2 users + temp MANAGER (${m2Emails.length}/${ground[2].userCount + 1})`);
  const m2CreateStaff = await api("POST", "/users", { name: "Should Not", email: `ctqa.deny.${suffix}@ctqa.com`, password: "CrossTenant@123", role: "WAITER" }, tokM2);
  check(m2CreateStaff.status === 403, `MANAGER cannot create staff → ${m2CreateStaff.status} (existing permission matrix)`);

  section("TEST F/G — restaurant_9 tenant staff (temp MANAGER via SUPER_ADMIN)");
  const m9Email = `ctqa.mgr9.${suffix}@ctqa.com`;
  const m9Create = await api("POST", "/super-admin/users", { restaurantId: 9, name: "CT QA Manager R9", email: m9Email, password: "CrossTenant@123", role: "MANAGER" }, saToken);
  check(m9Create.status === 201, `SUPER_ADMIN created MANAGER in restaurant_9 → ${m9Create.status}`, m9Create.data?.message || m9Create.data);
  const m9Row = m9Create.data?.data?.id ? m9Create.data.data : null;
  if (m9Row) createdTenantUsers.push({ client: tenantClients[9], id: m9Row.id, restaurantId: 9, email: m9Email });
  const m9Db = m9Row ? await tenantClients[9].user.findUnique({ where: { id: m9Row.id }, select: { id: true, restaurantId: true, role: true } }) : null;
  check(m9Db && m9Db.restaurantId === 9 && m9Db.role === "MANAGER", "restaurant_9 row has restaurantId=9 (SA create sets restaurantId)");
  const lm9 = await api("POST", "/auth/login", { email: m9Email, password: "CrossTenant@123" });
  check(lm9.status === 200, `restaurant_9 MANAGER login → ${lm9.status}`, lm9.data?.message || lm9.data);
  const tokM9 = lm9.data?.token;
  const cM9 = decodeJwt(tokM9);
  check(cM9?.role === "MANAGER" && Number(cM9?.restaurantId) === 9, `JWT: role=${cM9?.role} restaurantId=${cM9?.restaurantId} (must be 9)`);
  const m9menu = await api("GET", "/menu", null, tokM9);
  check(m9menu.status === 200 && menuIdSet(m9menu.data) === ground[9].itemIds.sort((a, b) => a - b).join(","), "Menu == restaurant_9 DB set");
  const m9x = await api("GET", "/menu?restaurantId=1", null, tokM9);
  check(m9x.status === 200 && menuIdSet(m9x.data) === menuIdSet(m9menu.data), "GET /menu?restaurantId=1 → STILL restaurant_9 data (override blocked)");
  const m9u = await api("GET", "/users?limit=100", null, tokM9);
  const m9Emails = (m9u.data?.data?.users || []).map((u) => u.email);
  check(m9u.status === 200 && m9Emails.length === ground[9].userCount + 1 && m9Emails.includes(m9Email), `Staff list == restaurant_9 users + temp MANAGER (${m9Emails.length}/${ground[9].userCount + 1})`);

  section("TEST H/I/J — ADMIN cross-tenant reads stay in own tenant");
  for (const t of TENANTS) {
    const tok = admTokens[t.id];
    const menu = await api("GET", "/menu", null, tok);
    const menuSet = menuIdSet(menu.data);
    check(menu.status === 200 && menuSet === ground[t.id].itemIds.sort((a, b) => a - b).join(","), `restaurant ${t.id} ADMIN menu == own DB set`);
    const tbl = await api("GET", "/tables", null, tok);
    check(tbl.status === 200 && (tbl.data?.tables || []).length === ground[t.id].tables, `restaurant ${t.id} ADMIN tables == own tenant (${(tbl.data?.tables || []).length}/${ground[t.id].tables})`);
    const w = await api("GET", "/users/waiters", null, tok);
    const waiterIds = (w.data?.data?.users || []).map((u) => u.id);
    const ownWaiterIds = ground[t.id].users.filter((u) => u.role === "WAITER").map((u) => u.id);
    check(w.status === 200 && waiterIds.every((id) => ownWaiterIds.includes(id)), `restaurant ${t.id} waiters ⊆ own tenant (${waiterIds.length})`);
  }
  // overlapping waiter emails across tenants would break the ⊆ check above;
  // explicitly ensure no OTHER tenant's staff leaks into this tenant's list
  const r1Waiters = await api("GET", "/users/waiters", null, admTokens[1]);
  const r1WaiterIds = (r1Waiters.data?.data?.users || []).map((u) => u.id);
  const others = [...ground[2].users, ...ground[9].users].map((u) => u.id);
  check(!r1WaiterIds.some((id) => others.includes(id)), "restaurant_1 waiter list contains no restaurant_2/9 staff");

  section("TEST K — ADMIN staff creation with hostile body restaurantId stays in own tenant");
  const adminTok1 = admTokens[1];
  const wEmail = `ctqa.waiter.${suffix}@ctqa.com`;
  const createW = await api("POST", "/users", { name: "CT QA Waiter", email: wEmail, password: "CrossTenant@123", role: "WAITER", restaurantId: 9 }, adminTok1);
  check(createW.status === 201, `ADMIN(r1) POST /users with restaurantId=9 → ${createW.status}`, createW.data?.message || createW.data);
  const createdW = createW.data?.data || createW.data?.user;
  if (createdW?.id) createdTenantUsers.push({ client: tenantClients[1], id: createdW.id, restaurantId: 1, email: wEmail });
  const wInR1 = await tenantClients[1].user.findUnique({ where: { email: wEmail }, select: { id: true, restaurantId: true } });
  const wInR9 = await tenantClients[9].user.findUnique({ where: { email: wEmail }, select: { id: true } }).catch(() => null);
  check(!!wInR1 && wInR1.restaurantId === 1, "Staff created in restaurant_1 with restaurantId=1 (hostile restaurantId ignored)");
  check(!wInR9, "No row leaked into restaurant_9");
  const wLogin = await api("POST", "/auth/login", { email: wEmail, password: "CrossTenant@123" });
  check(wLogin.status === 200 && Number(decodeJwt(wLogin.data?.token)?.restaurantId) === 1, "New WAITER logs in as restaurant_1 staff");

  section("TEST N — Socket.IO tenant identity");
  let socketIORoot = path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules");
  const { io: Client } = require(path.join(socketIORoot, "socket.io-client"));
  const backendUrl = "http://127.0.0.1:5001";
  function connectWith(token, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const sock = Client(backendUrl, { transports: ["websocket"], auth: { token } });
      const done = (kind, detail) => { try { sock.close(); } catch (e) {} resolve({ kind, detail }); };
      const to = setTimeout(() => done("timeout", "no event"), timeoutMs);
      sock.on("connect", () => { clearTimeout(to); done("connect", sock.id); });
      sock.on("connect_error", (err) => { clearTimeout(to); done("error", err && err.message); });
    });
  }
  const okConn = await connectWith(tokM1);
  check(okConn.kind === "connect", `Socket connect with valid restaurant_1 MANAGER token → ${okConn.kind}`);
  // forged token: claims restaurant_1 manager id 32 but restaurantId=2 (mismatch vs DB row restaurantId=1)
  const forged = jwt.sign({ id: 32, role: "MANAGER", restaurantId: 2 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const badConn = await connectWith(forged);
  check(badConn.kind === "error", `Socket connect with mismatched restaurantId token → rejected (${badConn.detail || badConn.kind})`);
  // forged disabled-role claim
  const forgedAdmin = jwt.sign({ id: 32, role: "ADMIN", restaurantId: 1 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const badConn2 = await connectWith(forgedAdmin);
  check(badConn2.kind === "error", `Socket connect with forged role=ADMIN (public lookup fails) → rejected (${badConn2.detail || badConn2.kind})`);

  section("TEST O — DB verification (tenant User.restaurantId + sequences)");
  for (const t of TENANTS) {
    const db = tenantClients[t.id];
    const nullRid = await db.user.count({ where: { restaurantId: null } });
    const wrongRid = await db.user.count({ where: { restaurantId: { not: t.id } } });
    check(nullRid === 0, `restaurant_${t.id}: 0 users with NULL restaurantId (${nullRid})`);
    check(wrongRid === 0, `restaurant_${t.id}: 0 users with wrong restaurantId (${wrongRid})`);
    const agg = await db.user.aggregate({ _max: { id: true } });
    const seqRaw = await db.$queryRawUnsafe(`SELECT last_value FROM "${t.schema}"."User_id_seq"`);
    const lastVal = Number(seqRaw[0].last_value);
    check(lastVal >= agg._max.id, `restaurant_${t.id}: sequence ${lastVal} >= MAX(id) ${agg._max.id}`);
  }
  // brief landmark: user 931 exists only in restaurant_1
  const u931_1 = await tenantClients[1].user.findUnique({ where: { id: 931 }, select: { id: true, name: true, role: true, restaurantId: true } });
  const u931_2 = await tenantClients[2].user.findUnique({ where: { id: 931 } }).catch(() => null);
  const u931_9 = await tenantClients[9].user.findUnique({ where: { id: 931 } }).catch(() => null);
  check(!!u931_1 && u931_1.restaurantId === 1 && u931_1.role === "MANAGER", `User 931 exists ONLY in restaurant_1 as MANAGER(r1) (${u931_1 ? u931_1.name : "NOT FOUND"})`);
  check(!u931_2 && !u931_9, "User 931 absent from restaurant_2 / restaurant_9");

  console.log(`\n──────── RESULTS: ${pass} passed, ${fail} failed ────────`);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exitCode = fail > 0 ? 2 : 0;
})().catch(async (e) => {
  console.error("CRASH:", e && e.message);
  console.error(e && e.stack);
  process.exitCode = 1;
}).finally(async () => {
  // ── Cleanup: delete ONLY the QA users we created (restore tenant state) ──
  for (const u of createdTenantUsers) {
    try { await u.client.user.delete({ where: { id: u.id } }); console.log(`  cleaned tenant user ${u.restaurantId}#${u.id} (${u.email})`); }
    catch (e) { console.error("  cleanup failed for", u.email, e.message); }
  }
  try { await platformPrisma.$disconnect(); } catch (e) {}
});
