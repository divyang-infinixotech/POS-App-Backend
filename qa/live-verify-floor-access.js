/**
 * Live verification of Part 26 (floor assignment + access enforcement),
 * against restaurant_1 (Golden Grill) on the running dev server.
 *
 *   1. Ensure Ground Floor + First Floor exist.
 *   2. Create two QA waiters (unique emails).
 *   3. Assign Waiter A → Ground, Waiter B → First via PUT /users/:id/floors.
 *   4. GET /tables as Waiter A → only Ground-Floor tables; B → only First-Floor.
 *   5. Direct API to an unassigned floor's table → 403 (list scoping + per-table).
 *   6. ADMIN sees all floors (exempt role).
 *   7. Removing the assignment restores full access (opt-in narrowing).
 *   8. Cleanup: deletes QA staff and QA tables (existing data untouched).
 *
 * Run: node qa/live-verify-floor-access.js
 */
const BASE = "http://127.0.0.1:5001/api";
const STAMP = Date.now();

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  // ── Login chain ──
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check("Super Admin login", sa.status === 200);
  const saToken = sa.json?.token;
  const la = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
  const adminToken = la.json?.token || la.json?.data?.token;
  check("login-as restaurant 1 ADMIN", la.status === 200 && !!adminToken);
  if (!adminToken) { console.log("Cannot proceed without an admin token."); process.exit(1); }

  const users = async (q) => (await api("GET", "/users" + (q || ""), null, adminToken)).json;
  const allUsers = await api("GET", "/users", null, adminToken);
  check("GET /users (roster) → 200", allUsers.status === 200);

  // ── 1. Ensure two floors exist ──
  const floorsRes = await api("GET", "/floors", null, adminToken);
  check("GET /floors → 200", floorsRes.status === 200);
  const floorsArr = floorsRes.json?.data?.floors || floorsRes.json?.data || floorsRes.json?.floors || [];
  let ground = floorsArr.find((f) => /ground/i.test(f.name));
  let first = floorsArr.find((f) => /first/i.test(f.name));
  if (!ground) {
    const g = await api("POST", "/floors", { name: "Ground Floor" }, adminToken);
    ground = g.json?.floor || g.json?.data?.floor || g.json?.data;
  }
  if (!first) {
    const f = await api("POST", "/floors", { name: "First Floor" }, adminToken);
    first = f.json?.floor || f.json?.data?.floor || f.json?.data;
  }
  check("Ground Floor + First Floor available", !!ground?.id && !!first?.id, `ground=${ground?.id} first=${first?.id}`);
  if (!ground?.id || !first?.id) { console.log("Cannot proceed without both floors."); process.exit(1); }

  // ── 2. Create QA waiters ──
  const mk = async (n) => {
    const r = await api("POST", "/users", {
      name: `QA Waiter ${n}`,
      email: `qa-waiter-${n.toLowerCase()}-${STAMP}@example.com`,
      password: "TestPass@123",
      role: "WAITER",
    }, adminToken);
    const u = r.json?.user || r.json?.data?.user || r.json?.data;
    check(`create QA Waiter ${n}`, r.status === 200 || r.status === 201, `status=${r.status} msg=${JSON.stringify(r.json?.message || "").slice(0, 120)}`);
    return u?.id;
  };
  const waiterA = await mk("A");
  const waiterB = await mk("B");
  check("waiter IDs returned", !!waiterA && !!waiterB);

  // ── 3. Floor assignments ──
  const assignA = await api("PUT", `/users/${waiterA}/floors`, { floorIds: [ground.id] }, adminToken);
  check("assign Waiter A → Ground Floor", assignA.status === 200, `status=${assignA.status} msg=${JSON.stringify(assignA.json?.message || "").slice(0, 120)}`);
  const assignB = await api("PUT", `/users/${waiterB}/floors`, { floorIds: [first.id] }, adminToken);
  check("assign Waiter B → First Floor", assignB.status === 200, `status=${assignB.status} msg=${JSON.stringify(assignB.json?.message || "").slice(0, 120)}`);

  // Login as the waiters (real staff logins, not impersonation)
  const loginStaff = async (email) => {
    const r = await api("POST", "/auth/login", { email, password: "TestPass@123" });
    return r.json?.token;
  };
  const tokenA = await loginStaff(`qa-waiter-a-${STAMP}@example.com`);
  const tokenB = await loginStaff(`qa-waiter-b-${STAMP}@example.com`);
  check("Waiter A + B logins", !!tokenA && !!tokenB);

  // ── 4. One table per floor for the direct-API test (created by ADMIN) ──
  const mkTable = async (floorId, tag) => {
    const r = await api("POST", "/tables", {
      tableNo: `QA${tag}${STAMP % 100000}`,
      name: `QA Table ${tag}`,
      capacity: 2,
      floorId,
    }, adminToken);
    const t = r.json?.table || r.json?.data?.table || r.json?.data;
    if (!t?.id) console.log(`  (table create ${tag}: status=${r.status} msg=${JSON.stringify(r.json?.message || "").slice(0, 100)})`);
    return t?.id;
  };
  const groundTableId = await mkTable(ground.id, "G");
  const firstTableId = await mkTable(first.id, "F");
  check("QA tables created on both floors", !!groundTableId && !!firstTableId);

  // ── 5. List scoping ──
  const tablesA = await api("GET", "/tables", null, tokenA);
  const tablesAArr = tablesA.json?.data?.tables || tablesA.json?.data || tablesA.json?.tables || [];
  const aOnGround = tablesAArr.filter((t) => t.floorId === ground.id).length;
  const aOnFirst = tablesAArr.filter((t) => t.floorId === first.id).length;
  check("Waiter A sees Ground-Floor tables", tablesA.status === 200 && aOnGround > 0, `status=${tablesA.status} ground=${aOnGround}`);
  check("Waiter A does NOT see First-Floor tables", aOnFirst === 0, `first=${aOnFirst}`);

  const tablesB = await api("GET", "/tables", null, tokenB);
  const tablesBArr = tablesB.json?.data?.tables || tablesB.json?.data || tablesB.json?.tables || [];
  const bOnFirst = tablesBArr.filter((t) => t.floorId === first.id).length;
  const bOnGround = tablesBArr.filter((t) => t.floorId === ground.id).length;
  check("Waiter B sees First-Floor tables", tablesB.status === 200 && bOnFirst > 0, `status=${tablesB.status} first=${bOnFirst}`);
  check("Waiter B does NOT see Ground-Floor tables", bOnGround === 0, `ground=${bOnGround}`);

  // ADMIN (exempt role) sees all floors
  const tablesAdmin = await api("GET", "/tables", null, adminToken);
  const adminArr = tablesAdmin.json?.data?.tables || tablesAdmin.json?.data || tablesAdmin.json?.tables || [];
  check("ADMIN sees all floors (restaurant-wide)", tablesAdmin.status === 200 && adminArr.some((t) => t.floorId === ground.id) && adminArr.some((t) => t.floorId === first.id));

  // ── 6. Direct API to unassigned floor → 403 (PUT is the per-table route) ──
  const mutateA = await api("PUT", `/tables/${firstTableId}`, { name: "Hacked Name" }, tokenA);
  check("Waiter A direct PUT unassigned-floor table → 403", mutateA.status === 403, `status=${mutateA.status} msg=${JSON.stringify(mutateA.json?.message || "").slice(0, 100)}`);

  // ── 7. Multiple assignments widen access; removing restores opt-in baseline ──
  const both = await api("PUT", `/users/${waiterA}/floors`, { floorIds: [ground.id, first.id] }, adminToken);
  const tablesA2 = await api("GET", "/tables", null, tokenA);
  const arrA2 = tablesA2.json?.data?.tables || tablesA2.json?.data || tablesA2.json?.tables || [];
  check(
    "Waiter A with Ground+First sees both floors",
    both.status === 200 && arrA2.some((t) => t.floorId === ground.id) && arrA2.some((t) => t.floorId === first.id)
  );
  const onlyGround = await api("PUT", `/users/${waiterA}/floors`, { floorIds: [ground.id] }, adminToken);
  const directA2 = await api("PUT", `/tables/${firstTableId}`, { name: "Still Hacking" }, tokenA);
  check(
    "Removing First-Floor assignment revokes access again",
    onlyGround.status === 200 && directA2.status === 403,
    `put-assign=${onlyGround.status} put-table=${directA2.status}`
  );

  // ── 8. Cleanup ──
  for (const id of [groundTableId, firstTableId]) if (id) await api("DELETE", `/tables/${id}`, null, adminToken);
  for (const id of [waiterA, waiterB]) if (id) await api("DELETE", `/users/${id}`, null, adminToken);
  console.log("  🧹 QA staff + QA tables cleaned up (floors kept)");

  console.log(`\n──────── LIVE RESULTS: ${passed} passed, ${failed} failed ────────`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("Script error:", e.message); process.exit(1); });
