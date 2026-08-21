/**
 * Super Admin Profile + Plan Module Access — LIVE QA suite.
 *
 * Runs against the real backend + PostgreSQL (server must be on :5001).
 * Covers:
 *   §1  SA own-profile GET/PUT (validation, email-unique, persistence, RBAC 403)
 *   §2  SA change password (old stops working, new works, token invalidation)
 *   §3  module catalog — only real restaurant modules available
 *   §4  plan module gating — two restaurants, API 403/200, immediate propagation
 *
 * Run: node qa/profile-modules-qa.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BASE = "http://localhost:5001/api";
const SA_EMAIL = "superadmin@pos.com";
const SA_PASS = "SuperAdmin@123";

let pass = 0, fail = 0;
const check = (cond, msg) => {
  process.stdout.write(cond ? "  ✅ " : "  ❌ ");
  console.log(msg);
  cond ? pass++ : fail++;
};
const section = (t) => console.log(`\n${"=".repeat(62)}\n  ${t}\n${"=".repeat(62)}`);

async function api(method, path, body, token) {
  const hasBody = body !== undefined && body !== null;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  const ts = Date.now();
  const suffix = ts;

  // ── Bootstrap ──
  section("BOOTSTRAP");
  const saLogin = await api("POST", "/auth/login", { email: SA_EMAIL, password: SA_PASS });
  const saToken = saLogin.data?.token;
  check(!!saToken, `Super Admin login (${saLogin.status})`);
  const saId = saLogin.data?.user?.id;
  const saOrig = {
    name: saLogin.data?.user?.name,
    email: saLogin.data?.user?.email,
    phone: saLogin.data?.user?.phone,
  };

  // ═══════════════ §1 SA PROFILE ═══════════════
  section("§1 SUPER ADMIN PROFILE — own profile GET/PUT");

  const me = await api("GET", "/super-admin/profile", null, saToken);
  check(me.status === 200, `GET /super-admin/profile → ${me.status}`);
  const prof = me.data?.data;
  check(!!prof && prof.id === saId, "profile returned belongs to the logged-in SA");
  check("password" in (prof || {}) === false, "password never exposed in profile response");
  check(typeof prof?.name === "string" && typeof prof?.email === "string", "name + email present");

  // Valid update — name + phone, persist
  const newName = `Super Admin QA ${suffix}`;
  const putOk = await api("PUT", "/super-admin/profile", { name: newName, phone: "9876543210" }, saToken);
  check(putOk.status === 200, `PUT profile (name/phone) → ${putOk.status}`);
  const me2 = await api("GET", "/super-admin/profile", null, saToken);
  check(me2.data?.data?.name === newName, "updated name persisted (re-GET matches)");
  check(me2.data?.data?.phone === "9876543210", "updated phone persisted");
  check(me2.data?.data?.email === saOrig.email, "email unchanged when not submitted");

  // Validation + uniqueness
  const badEmail = await api("PUT", "/super-admin/profile", { email: "not-an-email" }, saToken);
  check(badEmail.status === 400, `invalid email → ${badEmail.status}`);
  const shortName = await api("PUT", "/super-admin/profile", { name: "A" }, saToken);
  check(shortName.status === 400, `name < 2 chars → ${shortName.status}`);
  const empty = await api("PUT", "/super-admin/profile", {}, saToken);
  check(empty.status === 400, `empty body → ${empty.status}`);

  // Email uniqueness — steal a restaurant admin's email
  const res = await api("POST", "/super-admin/restaurants", {
    name: `QA Prof ${suffix}`, ownerName: "QA Owner",
    mobile: `973${String(suffix).slice(-8)}`, email: `qa-prof-${suffix}@test.com`,
    adminName: "QA Admin", adminEmail: `qa-prof-admin-${suffix}@test.com`, adminPassword: "SubPass@123",
  }, saToken);
  const restId = res.data?.data?.id || res.data?.restaurant?.id;
  const dup = await api("PUT", "/super-admin/profile", { email: `qa-prof-admin-${suffix}@test.com` }, saToken);
  check(dup.status === 400 && /exists/i.test(dup.data?.message || ""), `duplicate email → 400 "${dup.data?.message}"`);

  // RBAC — restaurant ADMIN + CASHIER cannot touch SA profile
  const adminLogin = await api("POST", "/auth/login", { email: `qa-prof-admin-${suffix}@test.com`, password: "SubPass@123" });
  const cashier = await api("POST", "/super-admin/users", {
    restaurantId: restId, name: "QA Cashier", email: `qa-prof-cashier-${suffix}@test.com`,
    password: "CashPass@123", role: "CASHIER",
  }, saToken);
  const cashierLogin = await api("POST", "/auth/login", { email: `qa-prof-cashier-${suffix}@test.com`, password: "CashPass@123" });
  check((await api("GET", "/super-admin/profile", null, adminLogin.data?.token)).status === 403, `restaurant ADMIN → 403`);
  check((await api("GET", "/super-admin/profile", null, cashierLogin.data?.token)).status === 403, `CASHIER → 403`);
  check((await api("PUT", "/super-admin/profile", { name: "HACK" }, adminLogin.data?.token)).status === 403, `ADMIN profile write → 403`);

  // Restore SA name/phone (email untouched by tests)
  await api("PUT", "/super-admin/profile", { name: saOrig.name, phone: saOrig.phone }, saToken);

  // ═══════════════ §2 SA CHANGE PASSWORD ═══════════════
  section("§2 SUPER ADMIN CHANGE PASSWORD (existing /auth/change-password)");

  const wrongCurrent = await api("POST", "/auth/change-password", { currentPassword: "WrongPass@999", newPassword: "TempPass@456" }, saToken);
  check(wrongCurrent.status === 400, `wrong current password → ${wrongCurrent.status}`);

  const change = await api("POST", "/auth/change-password", { currentPassword: SA_PASS, newPassword: "TempSA@45678" }, saToken);
  check(change.status === 200, `change password → ${change.status}`);

  // Old password must stop working
  const oldLogin = await api("POST", "/auth/login", { email: SA_EMAIL, password: SA_PASS });
  check(oldLogin.status === 401, `old password login → ${oldLogin.status} (rejected)`);

  // Token issued before the change is invalidated (passwordChangedAt)
  const staleToken = await api("GET", "/super-admin/profile", null, saToken);
  check(staleToken.status === 401, `pre-change token → 401 (invalidated)`);

  // New password works
  const newLogin = await api("POST", "/auth/login", { email: SA_EMAIL, password: "TempSA@45678" });
  check(newLogin.status === 200 && !!newLogin.data?.token, `new password login → ${newLogin.status}`);

  // Revert to the original password
  const revert = await api("POST", "/auth/change-password", { currentPassword: "TempSA@45678", newPassword: SA_PASS }, newLogin.data?.token);
  check(revert.status === 200, `revert to original password → ${revert.status}`);
  const origBack = await api("POST", "/auth/login", { email: SA_EMAIL, password: SA_PASS });
  check(origBack.status === 200, `original password works again → ${origBack.status}`);
  // The revert also invalidated the pre-revert token — use a FRESH one for the rest.
  const freshLogin = await api("POST", "/auth/login", { email: SA_EMAIL, password: SA_PASS });
  const saToken2 = freshLogin.data?.token;
  check(!!saToken2, "fresh SA token after revert");

  // ═══════════════ §3 MODULE CATALOG ═══════════════
  section("§3 PLAN MODULE CATALOG — only real restaurant modules available");

  const cat = await api("GET", "/super-admin/plans/modules", null, saToken2);
  check(cat.status === 200, `GET /super-admin/plans/modules → ${cat.status}`);
  const modules = cat.data?.data || [];
  const byKey = Object.fromEntries(modules.map((m) => [m.key, m]));

  const EXPECTED_AVAILABLE = ["dashboard", "pos", "billing", "floors", "tables", "kitchen", "active_orders", "menu", "customers", "staff", "reports", "settings"];
  const EXPECTED_UNAVAILABLE = ["inventory", "printers", "qr_ordering", "api_access", "multi_terminal"];

  check(EXPECTED_AVAILABLE.every((k) => byKey[k]?.available === true), `all 12 real modules available:true (${EXPECTED_AVAILABLE.length})`);
  check(EXPECTED_UNAVAILABLE.every((k) => byKey[k]?.available === false), `5 fake/placeholder modules available:false (${EXPECTED_UNAVAILABLE.join(", ")})`);
  check(!modules.some((m) => m.key.startsWith("sa_") || /gateway|restaurant|plan|user/.test(m.key)), "no Super Admin platform modules in the catalog");
  check(modules.every((m) => typeof m.available === "boolean"), "every catalog row has an explicit available flag");

  // ═══════════════ §4 PLAN MODULE GATING ═══════════════
  section("§4 PLAN MODULE GATING — two restaurants, immediate propagation");

  // Temp plan WITHOUT reports
  const mkPlan = await api("POST", "/super-admin/plans", {
    code: `QANOREPS${suffix}`, name: `QA No Reports ${suffix}`, yearlyPrice: 100, billingCycle: "YEARLY",
    modules: EXPECTED_AVAILABLE.filter((k) => k !== "reports").map((k) => ({ moduleKey: k, enabled: true })),
  }, saToken2);
  const noRepPlan = mkPlan.data?.data;
  check(!!noRepPlan?.id, `temp plan without reports created (${mkPlan.status})`);
  check(!(noRepPlan?.features || []).includes("reports"), "temp plan features exclude reports");

  // Two restaurants on different plans
  const resA = await api("POST", "/super-admin/restaurants", {
    name: `QA Gate A ${suffix}`, ownerName: "QA Owner",
    mobile: `974${String(suffix).slice(-8)}`, email: `qa-gate-a-${suffix}@test.com`,
    adminName: "QA Admin", adminEmail: `qa-gate-a-admin-${suffix}@test.com`, adminPassword: "SubPass@123",
  }, saToken2);
  const resB = await api("POST", "/super-admin/restaurants", {
    name: `QA Gate B ${suffix}`, ownerName: "QA Owner",
    mobile: `975${String(suffix).slice(-8)}`, email: `qa-gate-b-${suffix}@test.com`,
    adminName: "QA Admin", adminEmail: `qa-gate-b-admin-${suffix}@test.com`, adminPassword: "SubPass@123",
  }, saToken2);
  const idA = resA.data?.data?.id || resA.data?.restaurant?.id;
  const idB = resB.data?.data?.id || resB.data?.restaurant?.id;
  check(!!idA && !!idB, `restaurants A(${idA}) B(${idB}) created`);

  const assignB = await api("PUT", `/super-admin/subscriptions/${idB}/plan`, { planId: noRepPlan.id, billingCycle: "YEARLY" }, saToken2);
  check(assignB.status === 200, `B assigned to plan-without-reports (${assignB.status})`);

  const loginA = await api("POST", "/auth/login", { email: `qa-gate-a-admin-${suffix}@test.com`, password: "SubPass@123" });
  const loginB = await api("POST", "/auth/login", { email: `qa-gate-b-admin-${suffix}@test.com`, password: "SubPass@123" });
  const tokenA = loginA.data?.token;
  const tokenB = loginB.data?.token;

  // Backend blocking — B cannot reach reports, A can
  const reportsA = await api("GET", "/reports/sales?date=2026-01-01", null, tokenA);
  check(reportsA.status === 200, `A (reports in plan) GET /reports/sales → ${reportsA.status}`);
  const reportsB = await api("GET", "/reports/sales?date=2026-01-01", null, tokenB);
  check(reportsB.status === 403, `B (no reports) GET /reports/sales → ${reportsB.status} (blocked server-side)`);
  check(/not included/i.test(reportsB.data?.message || ""), `B 403 message explains plan limitation`);

  // Shared infrastructure still works for B (menu gated by [menu,pos])
  const menuB = await api("GET", "/menu", null, tokenB);
  check(menuB.status === 200, `B can still use Menu & Stock → ${menuB.status} (core flow not broken)`);

  // Snapshot for the frontend — B's login subscription features lack reports
  check(!(loginB.data?.subscription?.features || []).includes("reports"), "B login subscription.features exclude reports (sidebar hides it)");
  check((loginA.data?.subscription?.features || []).includes("reports"), "A login subscription.features include reports");

  // Immediate propagation — add reports to the plan, B regains access WITHOUT user changes
  const editPlan = await api("PUT", `/super-admin/plans/${noRepPlan.id}`, {
    name: `QA No Reports ${suffix}`, yearlyPrice: 100, billingCycle: "YEARLY",
    modules: EXPECTED_AVAILABLE.map((k) => ({ moduleKey: k, enabled: true })),
  }, saToken2);
  check(editPlan.status === 200, `plan edited — reports now enabled (${editPlan.status})`);
  const loginB2 = await api("POST", "/auth/login", { email: `qa-gate-b-admin-${suffix}@test.com`, password: "SubPass@123" });
  check((loginB2.data?.subscription?.features || []).includes("reports"), "B snapshot now includes reports after plan edit (no user record touched)");
  const reportsB2 = await api("GET", "/reports/sales?date=2026-01-01", null, loginB2.data?.token);
  check(reportsB2.status === 200, `B GET /reports/sales → ${reportsB2.status} (regained after propagation)`);

  // ── Cleanup: restore SA profile, delete temp plan + restaurants ──
  section("CLEANUP");
  await api("PUT", "/super-admin/profile", { name: saOrig.name, phone: saOrig.phone }, saToken2);
  await api("DELETE", `/super-admin/restaurants/${idA}`, undefined, saToken2);
  await api("DELETE", `/super-admin/restaurants/${idB}`, undefined, saToken2);
  await api("DELETE", `/super-admin/restaurants/${restId}`, undefined, saToken2);
  await api("DELETE", `/super-admin/plans/${noRepPlan.id}`, undefined, saToken2);
  await prisma.plan.deleteMany({ where: { code: `QANOREPS${suffix}` } }).catch(() => {});
  const saNow = await api("GET", "/super-admin/profile", null, saToken2);
  check(saNow.data?.data?.name === saOrig.name && saNow.data?.data?.email === saOrig.email, "SA profile restored to original values");
  await prisma.$disconnect();

  console.log(`\n${"=".repeat(62)}\n  RESULT: ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error("FATAL", e); await prisma.$disconnect(); process.exit(1); });
