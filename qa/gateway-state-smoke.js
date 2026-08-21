/**
 * Gateway state smoke test — every behavior that does NOT require a real
 * Razorpay network call.
 *
 * This intentionally stops at the real Razorpay API boundary: with dummy keys
 * the order-creation attempt returns 502 ("Unable to reach the payment
 * gateway") — that IS the boundary. A real TEST checkout additionally needs
 * valid RAZORPAY TEST credentials (see qa/browser-walkthrough.js for the UI
 * flow to run once keys are configured).
 *
 * Run: node qa/gateway-state-smoke.js   (backend running)
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BASE = "http://localhost:5001/api";
const SA_EMAIL = "superadmin@pos.com";
const SA_PASS = "SuperAdmin@123";
const DUMMY_KEY_ID = "rzp_test_smoke_key_id_0001";
const DUMMY_KEY_SECRET = "smoke-key-secret-abcdef0123456789";
const DUMMY_WEBHOOK_SECRET = "smoke-webhook-secret-abcdef0123456789";

let pass = 0, fail = 0;
const check = (cond, msg) => { process.stdout.write(cond ? "  ✅ " : "  ❌ "); console.log(msg); cond ? pass++ : fail++; };
const section = (t) => console.log(`\n${"=".repeat(62)}\n  ${t}\n${"=".repeat(62)}`);
async function api(method, path, body, token) {
  const hasBody = body !== undefined && body !== null;
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  const saLogin = await api("POST", "/auth/login", { email: SA_EMAIL, password: SA_PASS });
  const saToken = saLogin.data?.token;
  check(!!saToken, "Super Admin login");

  // Ensure a clean baseline (no stored config → env fallback)
  await prisma.systemSetting.deleteMany({ where: { key: { in: ["payment_gateway_razorpay", "payment_gateway_razorpay_webhook"] } } });

  // ── §1 Gateway status reporting (unconfigured) ──
  section("§1 GATEWAY STATUS — unconfigured baseline");
  const st0 = await api("GET", "/super-admin/payments/gateway", null, saToken);
  const g0 = st0.data?.data || {};
  check(st0.status === 200, `SA gateway status endpoint (${st0.status})`);
  check(["NOT_CONFIGURED", "PARTIAL"].includes(g0.status), `status reports no keys (${g0.status}) — never CONFIGURED without keys`);
  check(g0.enabled === false, "enabled = false when no keys are configured (env fallback is honest)");
  check(!JSON.stringify(g0).includes(DUMMY_KEY_SECRET), "No secrets in status response");

  // ── §2 Temporary TEST plan: purchasable, backend-authoritative ──
  section("§2 TEMPORARY TEST PLAN — purchasable + backend-computed values");
  const ts = Date.now();
  const create = await api("POST", "/super-admin/restaurants", {
    name: `QA Smoke ${ts}`, ownerName: "QA", mobile: `965${String(ts).slice(-7)}`,
    email: `qa-smoke-${ts}@test.com`, adminName: "QA", adminEmail: `qa-smoke-admin-${ts}@test.com`, adminPassword: "SubPass@123",
  }, saToken);
  const rest = create.data?.data;
  const adminLogin = await api("POST", "/auth/login", { email: `qa-smoke-admin-${ts}@test.com`, password: "SubPass@123" });
  const token = adminLogin.data?.token;
  check(!!rest?.id && !!token, "Throwaway restaurant + admin ready");

  const tmpPlan = await api("POST", "/super-admin/plans", {
    code: `SMOKE_${String(ts).slice(-6)}`, name: "Smoke Test Plan", monthlyPrice: 4321, yearlyPrice: 43210,
    billingCycle: "MONTHLY", isActive: true,
    modules: [{ moduleKey: "dashboard", enabled: true }, { moduleKey: "pos", enabled: true }],
  }, saToken);
  const tmpPlanId = tmpPlan.data?.data?.id;
  check(!!tmpPlanId, `Temp plan created (id=${tmpPlanId}, yearly price 43210)`);

  // Yearly-only: even a legacy ?cycle=MONTHLY query returns YEARLY pricing.
  const plans = await api("GET", "/subscriptions/plans?cycle=MONTHLY", null, token);
  const planList = Array.isArray(plans.data?.data) ? plans.data.data : [];
  const tmpInList = planList.find((p) => p.id === tmpPlanId);
  check(!!tmpInList, "Temp plan offered to restaurants (active)");
  check(Number(tmpInList?.price) === 43210, `Price from BACKEND = ₹43210 / yearly (${tmpInList?.price}) — never monthly`);
  check(tmpInList?.billingCycle === "YEARLY", "Plans API reports billingCycle = YEARLY");
  check(!!tmpInList?.expectedExpiry, "expectedExpiry computed by the backend");
  check(["RENEWAL", "UPGRADE", "SWITCH"].includes(tmpInList?.action), `Action computed by the backend (${tmpInList?.action})`);

  // ── §4/§16 Checkout boundary while gateway unconfigured → 503, subscription untouched ──
  section("§4/§16 CHECKOUT BOUNDARY — unconfigured → 503");
  const me = await api("GET", "/subscriptions/me", null, token);
  const sub0 = me.data?.data || me.data?.subscription;
  const co503 = await api("POST", "/subscriptions/checkout", { planId: tmpPlanId, billingCycle: "YEARLY" }, token);
  check(co503.status === 503, `Checkout unconfigured → 503 (${co503.status})`);
  check(co503.data?.message === "Online payments are currently unavailable. Please contact your Super Admin.", "Exact 503 copy");
  const me1 = await api("GET", "/subscriptions/me", null, token);
  const sub1 = me1.data?.data || me1.data?.subscription;
  check(sub1.plan === sub0.plan && sub1.expiryDate === sub0.expiryDate && sub1.status === sub0.status, "Subscription unchanged");

  // ── §17 Save config (dummy keys) → masked, no secrets, cache invalidated ──
  section("§17 SAVE CONFIGURATION — masked, encrypted, cache invalidated");
  const save = await api("PUT", "/super-admin/payments/gateway", {
    environment: "TEST", enabled: true, keyId: DUMMY_KEY_ID, keySecret: DUMMY_KEY_SECRET, webhookSecret: DUMMY_WEBHOOK_SECRET,
  }, saToken);
  check(save.status === 200, `Save config (${save.status})`);
  const st1 = await api("GET", "/super-admin/payments/gateway", null, saToken);
  const g1 = st1.data?.data || {};
  check(g1.status === "CONFIGURED" && g1.enabled === true, `CONFIGURED + enabled (${g1.status})`);
  check(g1.environment === "TEST", "Environment = TEST");
  check((g1.keyId || "").includes("*") && (g1.keyId || "").includes(DUMMY_KEY_ID.slice(0, 4)), "Key ID masked (first4****last4)");
  check(!JSON.stringify(g1).includes(DUMMY_KEY_SECRET) && !JSON.stringify(g1).includes(DUMMY_WEBHOOK_SECRET), "No secrets in status");
  const stored = await prisma.systemSetting.findUnique({ where: { key: "payment_gateway_razorpay" } });
  const sv = typeof stored.value === "string" ? JSON.parse(stored.value) : stored.value;
  check(!!sv.keySecretEnc && !sv.keySecretEnc.includes(DUMMY_KEY_SECRET) && !sv.keySecret, "Key secret encrypted at rest (never plaintext)");
  check(!!sv.webhookSecretEnc && !sv.webhookSecretEnc.includes(DUMMY_WEBHOOK_SECRET), "Webhook secret encrypted at rest");

  // Immediately after save: order creation is ATTEMPTED (502 boundary — Razorpay rejects dummy creds)
  const co502 = await api("POST", "/subscriptions/checkout", { planId: tmpPlanId, billingCycle: "YEARLY" }, token);
  check(co502.status === 502, `Checkout after save → 502 (order creation attempted — REAL Razorpay boundary, creds invalid) ${co502.status}`);
  check((co502.data?.message || "").includes("payment gateway"), "Sanitized 502 message (no secrets)");
  const me2 = await api("GET", "/subscriptions/me", null, token);
  check((me2.data?.data || me2.data?.subscription).status === sub0.status, "Subscription unchanged after boundary attempt");
  const payRows = await prisma.subscriptionPayment.count({ where: { restaurantId: rest.id } });
  check(payRows === 0, "No payment row created (order never completed)");

  // ── §17 Test connection with dummy keys → sanitized failure ──
  const tst = await api("POST", "/super-admin/payments/gateway/test", {}, saToken);
  check(tst.status === 502 || tst.status === 400, `Test connection → sanitized ${tst.status} (no secrets)`);
  check(!JSON.stringify(tst.data).includes(DUMMY_KEY_SECRET), "Test-connection error never contains the secret");

  // ── §16 Disable → 503 immediately; re-enable → 502 without restart ──
  section("§16 ENABLE / DISABLE — takes effect without restart");
  const off = await api("POST", "/super-admin/payments/gateway/toggle", { enabled: false }, saToken);
  check(off.status === 200 && off.data?.data?.enabled === false, "Gateway disabled via SA");
  const coOff = await api("POST", "/subscriptions/checkout", { planId: tmpPlanId, billingCycle: "YEARLY" }, token);
  check(coOff.status === 503, `Checkout after disable → 503 immediately (${coOff.status})`);
  const on = await api("POST", "/super-admin/payments/gateway/toggle", { enabled: true }, saToken);
  check(on.status === 200 && on.data?.data?.enabled === true, "Gateway re-enabled via SA");
  const coOn = await api("POST", "/subscriptions/checkout", { planId: tmpPlanId, billingCycle: "YEARLY" }, token);
  check(coOn.status === 502, `Checkout after re-enable → available again (502 boundary) without frontend rebuild (${coOn.status})`);

  // ── §2/§20 Cleanup: remove temp plan + throwaway restaurant + config ──
  section("§20 CLEANUP");
  await api("DELETE", `/super-admin/plans/${tmpPlanId}`, null, saToken);
  const gone = (await api("GET", "/super-admin/plans?active=true", null, saToken)).data?.data || [];
  check(!gone.find((p) => p.id === tmpPlanId), "Temp plan removed");
  await api("DELETE", `/super-admin/restaurants/${rest.id}`, null, saToken);
  await prisma.systemSetting.deleteMany({ where: { key: { in: ["payment_gateway_razorpay", "payment_gateway_razorpay_webhook"] } } });
  const stFinal = await api("GET", "/super-admin/payments/gateway", null, saToken);
  check(stFinal.data?.data?.enabled === false, "Gateway restored to unconfigured baseline (no stored config left)");

  console.log(`\n  Gateway state smoke → ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error("Gateway state smoke crashed:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
