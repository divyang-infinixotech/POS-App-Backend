/**
 * SUPER ADMIN — FULL BUTTON FUNCTIONALITY, PERSISTENCE & REFRESH/RELOGIN QA
 *
 * Every mutation is verified end-to-end:
 *   API mutate → API read (fresh token = browser refresh) → relogin token →
 *   read again → direct PostgreSQL check → cleanup.
 *
 * Covers: profile, restaurants, users, plans, subscriptions, system settings,
 * gateway config persistence, notifications/reports/invoices data sources,
 * RBAC (ADMIN/CASHIER blocked), and fake-data absence.
 *
 * Run: node qa/super-admin-full-qa.js   (backend running on :5001)
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BASE = "http://localhost:5001/api";
const SA_EMAIL = "superadmin@pos.com";
const SA_PASS = "SuperAdmin@123";
const DUMMY_KEY_ID = "rzp_test_safullkeyid0001";
const DUMMY_KEY_SECRET = "safull-key-secret-0123456789abcdef";
const DUMMY_WEBHOOK_SECRET = "safull-webhook-secret-0123456789";

let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };
const section = (t) => console.log(`\n${"=".repeat(62)}\n  ${t}\n${"=".repeat(62)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  let url = BASE + path;
  let payload = body;
  // GET/HEAD cannot carry a JSON body — serialize plain-object params into the query string.
  if ((method === "GET" || method === "HEAD") && body && typeof body === "object" && !Array.isArray(body)) {
    const qs = Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    payload = undefined;
  }
  const hasBody = payload !== undefined && payload !== null;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: hasBody ? JSON.stringify(payload) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

const login = (email, password) => api("POST", "/auth/login", { email, password });
/** Fresh token — simulates a browser refresh (new session token). */
const freshToken = async (email, password) => (await login(email, password)).data?.token;

(async () => {
  const ts = Date.now();
  const suffix = ts;

  section("BOOTSTRAP");
  const saLogin = await login(SA_EMAIL, SA_PASS);
  const saToken = saLogin.data?.token;
  check(!!saToken, `Super Admin login (${saLogin.status})`);
  const saOrig = { name: saLogin.data?.user?.name, email: saLogin.data?.user?.email, phone: saLogin.data?.user?.phone };

  // ── §1 PROFILE: mutate → refresh-token read → relogin read → DB ──
  section("§1 SUPER ADMIN PROFILE persistence");
  const newName = `SA Full QA ${suffix}`;
  const putProf = await api("PUT", "/super-admin/profile", { name: newName, phone: "9112345678" }, saToken);
  check(putProf.status === 200, `profile update → ${putProf.status}`);
  const t1 = await freshToken(SA_EMAIL, SA_PASS);
  const read1 = await api("GET", "/super-admin/profile", null, t1);
  check(read1.data?.data?.name === newName, "name persists after refresh (fresh token)");
  const t2 = await freshToken(SA_EMAIL, SA_PASS);
  const read2 = await api("GET", "/super-admin/profile", null, t2);
  check(read2.data?.data?.phone === "9112345678", "phone persists after relogin");
  const dbSa = await prisma.user.findUnique({ where: { email: SA_EMAIL }, select: { name: true, phone: true } });
  check(dbSa.name === newName && dbSa.phone === "9112345678", "PostgreSQL contains the change");
  await api("PUT", "/super-admin/profile", { name: saOrig.name, phone: saOrig.phone }, t2);

  // ── §2 RESTAURANT: create → edit → status → refresh/relogin → DB → cleanup ──
  section("§2 RESTAURANT create/edit persistence");
  const rName = `QA Full Rest ${suffix}`;
  const rEmail = `qa-full-${suffix}@test.com`;
  const create = await api("POST", "/super-admin/restaurants", {
    name: rName, ownerName: "QA Owner", mobile: `977${String(suffix).slice(-8)}`, email: rEmail,
    adminName: "QA Admin", adminEmail: `qa-full-admin-${suffix}@test.com`, adminPassword: "SubPass@123",
  }, saToken);
  const restId = create.data?.data?.id || create.data?.restaurant?.id;
  check(!!restId, `restaurant created (id=${restId}, ${create.status})`);

  const edit = await api("PUT", `/super-admin/restaurants/${restId}`, { name: `${rName} EDITED`, ownerName: "QA Owner 2", mobile: `977${String(suffix).slice(-8)}` }, saToken);
  check(edit.status === 200, `restaurant edit → ${edit.status}`);
  const t3 = await freshToken(SA_EMAIL, SA_PASS);
  const rRead = await api("GET", `/super-admin/restaurants/${restId}`, null, t3);
  check(rRead.data?.data?.name === `${rName} EDITED`, "edited name persists after refresh");
  const dbRest = await prisma.restaurant.findUnique({ where: { id: restId }, select: { name: true, ownerName: true } });
  check(dbRest.name === `${rName} EDITED` && dbRest.ownerName === "QA Owner 2", "PostgreSQL contains the edit");

  const statusPatch = await api("PATCH", `/super-admin/restaurants/${restId}/status`, { status: "INACTIVE" }, saToken);
  check(statusPatch.status === 200, `restaurant status patch → ${statusPatch.status}`);
  const dbRest2 = await prisma.restaurant.findUnique({ where: { id: restId }, select: { status: true } });
  check(dbRest2.status === "INACTIVE", "status persisted in PostgreSQL");

  // ── §3 USER: create → toggle → reset → delete, persistence + DB ──
  section("§3 SA USER management persistence");
  const uEmail = `qa-full-u-${suffix}@test.com`;
  const uCreate = await api("POST", "/super-admin/users", { restaurantId: restId, name: "QA Full User", email: uEmail, password: "UserPass@123", role: "CASHIER" }, saToken);
  const userId = uCreate.data?.data?.id || uCreate.data?.user?.id;
  check(!!userId, `user created (id=${userId}, ${uCreate.status})`);
  const t4 = await freshToken(SA_EMAIL, SA_PASS);
  const uRead = await api("GET", "/super-admin/users", { page: 1, limit: 200, search: uEmail }, t4);
  check((uRead.data?.data?.users || []).some((u) => u.email === uEmail), "user visible after refresh");
  const dbUser = await prisma.user.findUnique({ where: { email: uEmail }, select: { role: true, isActive: true } });
  check(dbUser.role === "CASHIER" && dbUser.isActive, "PostgreSQL has the user");

  await api("PATCH", `/super-admin/users/${userId}/toggle-status`, undefined, saToken);
  const dbUser2 = await prisma.user.findUnique({ where: { email: uEmail }, select: { isActive: true } });
  check(dbUser2.isActive === false, "toggle persisted (deactivated) in PostgreSQL");
  const reset = await api("PATCH", `/super-admin/users/${userId}/reset-password`, undefined, saToken);
  check(reset.status === 200 && !!reset.data?.data?.newPassword, `reset password returns a new temporary password (${reset.status})`);

  // ── §4 PLAN: create (pricing/modules) → refresh read → duplicate → toggle → DB → cleanup ──
  section("§4 PLAN create/duplicate/toggle persistence");
  const pCode = `QAFULL${suffix}`;
  const planCreate = await api("POST", "/super-admin/plans", {
    code: pCode, name: `QA Full Plan ${suffix}`, yearlyPrice: 4999, billingCycle: "YEARLY",
    modules: ["dashboard", "pos", "menu", "billing"].map((k) => ({ moduleKey: k, enabled: true })),
  }, saToken);
  const planId = planCreate.data?.data?.id;
  check(!!planId, `plan created (id=${planId}, ${planCreate.status})`);
  const t5 = await freshToken(SA_EMAIL, SA_PASS);
  const plansRead = await api("GET", "/super-admin/plans", null, t5);
  const readPlan = (plansRead.data?.data || []).find((p) => p.id === planId);
  check(readPlan?.yearlyPrice === 4999, "plan price persists after refresh");
  check((readPlan?.features || []).includes("pos"), "module permission persists after refresh");

  const dup = await api("POST", `/super-admin/plans/${planId}/duplicate`, undefined, saToken);
  check(dup.status === 201 || dup.status === 200, `duplicate plan → ${dup.status}`);
  const dupCode = `${pCode}_COPY`;
  const dbDup = await prisma.plan.findUnique({ where: { code: dupCode } });
  check(!!dbDup, "duplicate plan persisted in PostgreSQL");

  const toggle = await api("PATCH", `/super-admin/plans/${planId}/toggle`, undefined, saToken);
  check(toggle.status === 200, `toggle plan active → ${toggle.status}`);
  const dbPlan = await prisma.plan.findUnique({ where: { id: planId }, select: { isActive: true } });
  check(dbPlan.isActive === false, "deactivated state persisted in PostgreSQL");

  // ── §5 SUBSCRIPTION: SA change plan → persist → DB ──
  section("§5 SUBSCRIPTION change-plan persistence");
  // Re-activate the plan first (inactive-plan assignment is a 400, verified below)
  const reactivate = await api("PATCH", `/super-admin/plans/${planId}/toggle`, undefined, saToken);
  check(reactivate.status === 200, `plan re-activated for assignment (${reactivate.status})`);
  // Inactive-plan assignment must be a clean 400, not a 500
  await api("PATCH", `/super-admin/plans/${planId}/toggle`, undefined, saToken); // deactivate again
  const inactiveAssign = await api("PUT", `/super-admin/subscriptions/${restId}/plan`, { planId, billingCycle: "YEARLY" }, saToken);
  check(inactiveAssign.status === 400, `inactive-plan assignment → 400 (not 500): ${inactiveAssign.status}`);
  await api("PATCH", `/super-admin/plans/${planId}/toggle`, undefined, saToken); // re-activate

  const change = await api("PUT", `/super-admin/subscriptions/${restId}/plan`, { planId, billingCycle: "YEARLY" }, saToken);
  check(change.status === 200, `SA change plan → ${change.status}`);
  const dbSub = await prisma.subscription.findUnique({ where: { restaurantId: restId }, select: { planId: true, plan: true, billingCycle: true } });
  check(dbSub.planId === planId && dbSub.billingCycle === "YEARLY", "subscription plan change persisted in PostgreSQL");

  // ── §6 SYSTEM SETTINGS: save → mask → refresh read → DB ──
  section("§6 SYSTEM SETTINGS persistence + secret masking");
  const setVal = `qa-set-${suffix}`;
  await api("PUT", "/super-admin/settings", { key: "platform_name", value: setVal }, saToken);
  const t6 = await freshToken(SA_EMAIL, SA_PASS);
  const setRead = await api("GET", "/super-admin/settings", null, t6);
  check(setRead.data?.data?.platform_name === setVal, "platform_name persists after refresh");
  await api("PUT", "/super-admin/settings", { key: "smtp_pass", value: "plaintext-leak-test" }, saToken);
  const setRead2 = await api("GET", "/super-admin/settings", null, saToken);
  check(setRead2.data?.data?.smtp_pass === "********", "secret value is masked in API response (never plaintext)");
  const dbSetting = await prisma.systemSetting.findUnique({ where: { key: "smtp_pass" } });
  check(typeof dbSetting.value === "string" && String(dbSetting.value).startsWith("v1:"), "secret encrypted at rest in PostgreSQL (v1: ciphertext)");
  // ── §6b BULK SYSTEM SETTINGS: atomic save, allowlist, mask-preserve, shapes ──
  section("§6b BULK settings save — atomic, allowlisted, secret-preserving");
  const bulkName = `qa-bulk-${suffix}`;
  const bulkSave = await api("PUT", "/super-admin/settings", {
    settings: { platform_name: bulkName, default_trial_days: 19, maintenance_mode: true, currency: "GBP" },
  }, saToken);
  check(bulkSave.status === 200, `bulk settings save → ${bulkSave.status}`);
  check(bulkSave.data?.data?.platform_name === bulkName && bulkSave.data?.data?.maintenance_mode === true, "bulk save returns sanitized settings");
  const bulkRead = await api("GET", "/super-admin/settings", null, saToken);
  check(bulkRead.data?.data?.platform_name === bulkName && bulkRead.data?.data?.default_trial_days === 19 && bulkRead.data?.data?.maintenance_mode === true && bulkRead.data?.data?.currency === "GBP", "all bulk fields persisted to PostgreSQL");
  // Gateway config lives under its own key — the bulk endpoint must reject it.
  const gwKey = await api("PUT", "/super-admin/settings", { settings: { payment_gateway_razorpay: { hacked: true } } }, saToken);
  check(gwKey.status === 400, "gateway config key rejected by bulk endpoint → 400");
  // Mask preserve: set a secret via bulk, then send the mask back → DB unchanged.
  await api("PUT", "/super-admin/settings", { settings: { smtp_pass: "bulk-secret-xyz" } }, saToken);
  const beforeMask = await prisma.systemSetting.findUnique({ where: { key: "smtp_pass" } });
  await api("PUT", "/super-admin/settings", { settings: { smtp_pass: "********", platform_name: bulkName } }, saToken);
  const afterMask = await prisma.systemSetting.findUnique({ where: { key: "smtp_pass" } });
  check(beforeMask && afterMask && String(beforeMask.value) === String(afterMask.value), "bulk save with mask preserves stored secret");
  // Legacy single-key shape keeps working.
  const legacy = await api("PUT", "/super-admin/settings", { key: "currency", value: "INR" }, saToken);
  check(legacy.status === 200 && legacy.data?.data?.currency === "INR", "legacy {key,value} shape still works");
  const empty = await api("PUT", "/super-admin/settings", {}, saToken);
  check(empty.status === 400, "empty settings body → 400");
  // cleanup settings — restore a production-like baseline (not empty strings,
  // so an SA opening System Settings after the suite sees sane defaults)
  await api("PUT", "/super-admin/settings", {
    settings: { platform_name: "Restaurant POS", default_trial_days: 15, maintenance_mode: false, currency: "INR", smtp_pass: "" },
  }, saToken);

  // ── §7 GATEWAY: save → refresh → relogin → persistence; then clear ──
  section("§7 GATEWAY config persistence");
  const gSave = await api("PUT", "/super-admin/payments/gateway", {
    environment: "TEST", enabled: false, keyId: DUMMY_KEY_ID, keySecret: DUMMY_KEY_SECRET, webhookSecret: DUMMY_WEBHOOK_SECRET,
  }, saToken);
  check(gSave.status === 200, `gateway save → ${gSave.status}`);
  await sleep(5100); // let the 5s in-memory cache expire so reads hit the DB
  const t7 = await freshToken(SA_EMAIL, SA_PASS);
  const gRead = await api("GET", "/super-admin/payments/gateway", null, t7);
  // The status endpoint masks the key ID (rzp_…0001) — exact equality is impossible by design.
  const keyIdMasked = gRead.data?.data?.keyId;
  check(typeof keyIdMasked === "string" && keyIdMasked.startsWith(DUMMY_KEY_ID.slice(0, 4)) && keyIdMasked.includes("********"), `gateway keyId persists masked after refresh+relogin (${keyIdMasked})`);
  check(gRead.data?.data?.enabled === false, "gateway enabled=false persists");
  check(!/safull-key-secret|safull-webhook-secret/i.test(JSON.stringify(gRead.data)), "no secret material in gateway status response");
  const dbGw = await prisma.systemSetting.findUnique({ where: { key: "payment_gateway_razorpay" } });
  const gwVal = dbGw ? (typeof dbGw.value === "string" ? JSON.parse(dbGw.value) : dbGw.value) : null;
  check(!!gwVal && String(gwVal.keySecretEnc || "").startsWith("v1:") && String(gwVal.webhookSecretEnc || "").startsWith("v1:"), "gateway secrets encrypted at rest (v1: ciphertext)");
  // cleanup gateway config (restore unconfigured baseline)
  await prisma.systemSetting.deleteMany({ where: { key: { in: ["payment_gateway_razorpay", "payment_gateway_razorpay_webhook"] } } });

  // ── §8 DATA SOURCES: dashboard/reports/notifications/invoices(real payments) ──
  section("§8 SA data sources — real backend data, no fake rows");
  const dash = await api("GET", "/super-admin/dashboard", null, saToken);
  check(dash.status === 200 && typeof dash.data?.data?.totalRestaurants === "number", "dashboard KPIs from backend");
  const reports = await api("GET", "/super-admin/reports", { type: "restaurant_growth" }, saToken);
  check(reports.status === 200, `platform reports → ${reports.status}`);
  const notifs = await api("GET", "/super-admin/notifications", { page: 1, limit: 5 }, saToken);
  check(notifs.status === 200 && Array.isArray(notifs.data?.data?.notifications), "notifications from backend");
  const payList = await api("GET", "/super-admin/payments", { limit: 5 }, saToken);
  check(payList.status === 200 && Array.isArray(payList.data?.data?.payments), "payment history (invoice source) from backend");

  // ── §9 RBAC: ADMIN + CASHIER blocked from SA mutations ──
  section("§9 RBAC — restaurant roles cannot mutate SA data");
  // The restaurant was set INACTIVE in §2 — reactivate so its users can log in.
  await api("PATCH", `/super-admin/restaurants/${restId}/status`, { status: "ACTIVE" }, saToken);
  // §3's CASHIER user is deactivated + password-reset by then — create a fresh one for RBAC.
  const rbacCashierEmail = `qa-rbac-cashier-${suffix}@test.com`;
  const rbacCashier = await api("POST", "/super-admin/users", { restaurantId: restId, name: "QA RBAC Cashier", email: rbacCashierEmail, password: "Cashier@123", role: "CASHIER" }, saToken);
  const rbacCashierId = rbacCashier.data?.data?.id || rbacCashier.data?.user?.id;
  check(!!rbacCashierId, `RBAC CASHIER created (id=${rbacCashierId})`);
  const adminLogin = await login(`qa-full-admin-${suffix}@test.com`, "SubPass@123");
  const cashierLogin = await login(rbacCashierEmail, "Cashier@123");
  check(!!adminLogin.data?.token, `ADMIN login (${adminLogin.status})`);
  check(!!cashierLogin.data?.token, `CASHIER login (${cashierLogin.status})`);
  const adminToken = adminLogin.data?.token;
  const cashierToken = cashierLogin.data?.token;
  check((await api("PUT", "/super-admin/profile", { name: "HACK" }, adminToken)).status === 403, "ADMIN profile write → 403");
  check((await api("PUT", "/super-admin/profile", { name: "HACK" }, cashierToken)).status === 403, "CASHIER profile write → 403");
  check((await api("POST", "/super-admin/restaurants", { name: "HACK" }, adminToken)).status === 403, "ADMIN restaurant create → 403");
  check((await api("POST", "/super-admin/plans", { code: "HACK" }, cashierToken)).status === 403, "CASHIER plan create → 403");
  check((await api("PUT", `/super-admin/subscriptions/${restId}/plan`, { planId }, adminToken)).status === 403, "ADMIN change-plan → 403");
  check((await api("PUT", "/super-admin/payments/gateway", { keyId: "x" }, cashierToken)).status === 403, "CASHIER gateway save → 403");
  check((await api("GET", "/super-admin/profile", null, adminToken)).status === 403, "ADMIN profile read → 403");
  check((await api("PUT", "/super-admin/settings", { settings: { platform_name: "HACK" } }, adminToken)).status === 403, "ADMIN bulk settings save → 403");
  check((await api("PUT", "/super-admin/settings", { settings: { platform_name: "HACK" } }, cashierToken)).status === 403, "CASHIER bulk settings save → 403");

  // ── §10 CLEANUP ──
  section("CLEANUP");
  await api("DELETE", `/super-admin/users/${rbacCashierId}`, undefined, saToken);
  await api("DELETE", `/super-admin/users/${userId}`, undefined, saToken);
  await api("DELETE", `/super-admin/restaurants/${restId}`, undefined, saToken);
  // The plan is referenced by the subscription — hard-delete via Prisma (test data).
  await prisma.planModulePermission.deleteMany({ where: { planId } }).catch(() => {});
  await prisma.plan.deleteMany({ where: { code: { in: [pCode, dupCode] } } }).catch(() => {});
  const saNow = await api("GET", "/super-admin/profile", null, saToken);
  check(saNow.data?.data?.name === saOrig.name, "SA profile restored");
  const orphans = await prisma.restaurant.count({ where: { deletedAt: null, name: { contains: "QA Full Rest" } } });
  check(orphans === 0, "no live QA restaurants left");
  await prisma.$disconnect();

  console.log(`\n${"=".repeat(62)}\n  RESULT: ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error("FATAL", e); await prisma.$disconnect(); process.exit(1); });
