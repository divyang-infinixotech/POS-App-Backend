/**
 * LIVE VERIFICATION — PHASE 12/25: staff email editing.
 *
 *   1. Create QA staff → email editable via PUT /users/:id.
 *   2. Same user ID preserved after email change.
 *   3. Login works with the NEW email (auth identity follows the update).
 *   4. Invalid email → 400.
 *   5. Duplicate email (another tenant user) → 400/409, no second record.
 *   6. Staff card data (GET /users) exposes email for the roster UI.
 *   7. Cleanup: QA staff removed, existing data untouched.
 *
 * Run: node qa/live-verify-staff-email.js
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
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check("Super Admin login", sa.status === 200);
  const la = await api("GET", "/super-admin/restaurants/1/login-as", null, sa.json?.token);
  const adminToken = la.json?.token || la.json?.data?.token;
  check("login-as restaurant 1 ADMIN", la.status === 200 && !!adminToken);
  if (!adminToken) { console.log("No admin token — aborting."); process.exit(1); }

  // ── 1. Create QA staff ──
  const email1 = `qa-email-a-${STAMP}@example.com`;
  const created = await api("POST", "/users", {
    name: "QA Email A",
    email: email1,
    password: "TestPass@123",
    role: "WAITER",
  }, adminToken);
  const user = created.json?.data?.user || created.json?.user || created.json?.data;
  const userId = user?.id;
  check("create QA staff → 2xx", [200, 201].includes(created.status), `status=${created.status}`);
  check("QA staff id returned", userId != null, JSON.stringify(created.json).slice(0, 150));

  // ── 2. Edit email → persists, same user ID ──
  const email2 = `qa-email-b-${STAMP}@example.com`;
  const upd = await api("PUT", `/users/${userId}`, { email: email2 }, adminToken);
  check("PUT email → 2xx", [200, 201].includes(upd.status), `status=${upd.status} body=${JSON.stringify(upd.json).slice(0, 150)}`);
  const got1 = await api("GET", `/users/${userId}`, null, adminToken);
  const row1 = got1.json?.data?.user || got1.json?.user || got1.json?.data;
  check("GET after PUT shows new email", (row1?.email || "").toLowerCase() === email2, `got ${row1?.email}`);
  check("same user ID preserved", Number(row1?.id) === Number(userId), `id=${row1?.id}`);

  // ── 3. Login with the NEW email ──
  const relogin = await api("POST", "/auth/login", { email: email2, password: "TestPass@123" });
  check("login with updated email → 200", relogin.status === 200, `status=${relogin.status}`);
  const oldLogin = await api("POST", "/auth/login", { email: email1, password: "TestPass@123" });
  check("login with OLD email fails", oldLogin.status !== 200, `status=${oldLogin.status}`);

  // ── 4. Invalid email → 400 ──
  const invalid = await api("PUT", `/users/${userId}`, { email: "not-an-email" }, adminToken);
  check("invalid email → 400", invalid.status === 400, `status=${invalid.status}`);

  // ── 5. Duplicate email → 400/409 ──
  const staffList = await api("GET", "/users", null, adminToken);
  const users = staffList.json?.data?.users || staffList.json?.data || staffList.json?.users || [];
  const other = users.find((u) => Number(u.id) !== Number(userId) && u.email);
  if (other) {
    const dup = await api("PUT", `/users/${userId}`, { email: other.email }, adminToken);
    check(`duplicate email (of user ${other.id}) → 400/409`, [400, 409].includes(dup.status), `status=${dup.status}`);
    const after = await api("GET", `/users/${userId}`, null, adminToken);
    const rowA = after.json?.data?.user || after.json?.user || after.json?.data;
    check("email unchanged after duplicate attempt", (rowA?.email || "").toLowerCase() === email2, `got ${rowA?.email}`);
  } else {
    check("duplicate email test — another user exists", false, "no second user found");
  }

  // ── 6. Roster exposes email (staff card UI data) ──
  const roster = await api("GET", "/users", null, adminToken);
  const rosterUsers = roster.json?.data?.users || roster.json?.data || roster.json?.users || [];
  const me = rosterUsers.find((u) => Number(u.id) === Number(userId));
  check("roster row exposes email for staff card", !!me?.email, JSON.stringify(me || {}).slice(0, 120));

  // ── cleanup ──
  const del = await api("DELETE", `/users/${userId}`, null, adminToken);
  check("QA staff cleaned up", [200, 204].includes(del.status), `status=${del.status}`);

  console.log(`\n──────── LIVE RESULTS: ${passed} passed, ${failed} failed ────────`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });
