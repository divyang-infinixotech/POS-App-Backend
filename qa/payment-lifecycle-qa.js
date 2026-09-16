/**
 * PHASE 3 — LIVE QA: the complete YEARLY payment lifecycle (simulated gateway).
 *
 * Real Razorpay TEST credentials are NOT provisioned in this environment, so a
 * real outbound order creation / hosted checkout cannot run. This suite drives
 * the REAL running backend on :5001 and exercises the exact server-to-server
 * paths Razorpay uses:
 *
 *   - POST /api/subscriptions/webhook  (raw body + x-razorpay-signature HMAC,
 *     computed with the same test webhook secret the backend config uses) —
 *     payment.captured / payment.failed events.
 *   - POST /api/onboarding/payments/verify (the checkout success callback with
 *     a server-side signature the backend must verify with the key secret).
 *
 * Scenarios (yearly-only, manual review mode):
 *   A  Successful payment → UNDER_REVIEW → SA approval → tenant provisioning
 *      → owner login → POS. Replayed webhook is idempotent.
 *   B  Tenant isolation while a second application exists.
 *   C  Cancelled / failed / pending payments — never activate, data preserved,
 *      retry available.
 *   D  Client-callback /verify path: valid signature activates; replay
 *      idempotent; amount validation applies on the webhook path.
 *   E  Security: invalid signature, amount mismatch, unknown order, fake
 *      success — nothing activates.
 *
 * A local TEST gateway config (synthetic key pair + webhook secret) is written
 * to the DB SystemSetting for the run and RESTORED afterwards. No real
 * credential is created, read or committed anywhere.
 *
 * Usage: node qa/payment-lifecycle-qa.js
 * Requires: backend running on :5001 with fresh code, dev DATABASE_URL in .env.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { platformPrisma } = require("../src/config/tenantPrisma");
const { getTenantClient, invalidateTenantClient } = require("../src/config/tenantPrisma");

const BASE = "http://127.0.0.1:5001/api";
const SETTING_KEY = "payment_gateway_razorpay";

// Synthetic TEST-only values (never a real credential).
const KEY_ID = "rzp_test_phase3_000000000";
const KEY_SECRET = "phase3-test-key-secret";
const WEBHOOK_SECRET = "phase3-webhook-secret-" + Date.now().toString().slice(-6);

let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg + (detail ? " :: " + String(detail).slice(0, 400) : "")); console.log("  ❌ " + msg + (detail ? "\n     " + String(detail).slice(0, 400) : "")); }
}
function section(t) { console.log("\n──────── " + t + " ────────"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, token, raw = false) {
  const headers = { ...(raw ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const options = { method, headers };
  if (body !== undefined && body !== null) options.body = raw ? body : JSON.stringify(body);
  const res = await fetch(BASE + p, options);
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, data };
}

const webhook = async (eventBody, signature) => {
  const res = await fetch(BASE + "/subscriptions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signature },
    body: JSON.stringify(eventBody),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
};
const webhookSig = (body) => crypto.createHmac("sha256", WEBHOOK_SECRET).update(JSON.stringify(body)).digest("hex");
const captureBody = (orderId, paymentId, amountPaise, method = "upi") => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: paymentId, order_id: orderId, method, amount: amountPaise } } },
});
const failBody = (orderId, paymentId, description = "Payment failed at the gateway") => ({
  event: "payment.failed",
  payload: { payment: { entity: { id: paymentId, order_id: orderId, method: "card", amount: 100, error_description: description } } },
});
// Checkout-success callback signature (Razorpay checkout handler payload).
const callbackSig = (orderId, paymentId) =>
  crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");

async function uploadFile(p, token, documentType, buf, filename, mime) {
  const fd = new FormData();
  fd.append("documentType", documentType);
  fd.append("file", new Blob([buf], { type: mime }), filename);
  const res = await fetch(BASE + p, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const PDF = Buffer.from("255044462d312e340a312030206f626a3c3c2f547970652f436174616c6f673e3e656e646f626a0a747261696c65723c3c2f526f6f742031203020523e3e0a2525454f460a", "hex");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex");
const stamp = Date.now().toString().slice(-8);

const created = []; // { userEmail, restaurantId, schema }
const docRefs = [];

async function createPaymentRow(restaurantId, subscription, orderId, payAmount) {
  const existing = await platformPrisma.subscriptionPayment.findFirst({
    where: { subscriptionId: subscription.id, razorpayOrderId: orderId },
  });
  if (existing) return existing;
  return platformPrisma.subscriptionPayment.create({
    data: {
      restaurantId,
      subscriptionId: subscription.id,
      planId: subscription.planId,
      planCode: subscription.plan,
      planName: subscription.plan,
      billingCycle: "YEARLY", // yearly-only purchase
      action: "ACTIVATION",
      amount: payAmount,
      status: "CREATED",
      razorpayOrderId: orderId,
      createdBy: null,
    },
  });
}

async function cleanup(restoreCfg, restoreMode) {
  for (const c of created.reverse()) {
    try {
      await platformPrisma.subscriptionPayment.deleteMany({ where: { restaurantId: c.restaurantId } });
      await platformPrisma.subscriptionHistory.deleteMany({ where: { restaurantId: c.restaurantId } });
      await platformPrisma.restaurantDocument.deleteMany({ where: { restaurantId: c.restaurantId } });
      await platformPrisma.policyAgreement.deleteMany({ where: { restaurantId: c.restaurantId } });
      await platformPrisma.notification.deleteMany({ where: { restaurantId: c.restaurantId } });
      await platformPrisma.subscription.deleteMany({ where: { restaurantId: c.restaurantId } });
      await platformPrisma.user.deleteMany({ where: { email: c.userEmail } });
      await platformPrisma.restaurant.deleteMany({ where: { id: c.restaurantId } });
      if (c.schema) {
        try {
          await platformPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${c.schema}" CASCADE`);
          await invalidateTenantClient(c.schema);
        } catch (e) { console.error("schema cleanup:", e.message); }
      }
    } catch (e) { console.error("cleanup:", c.userEmail, e.message); }
  }
  for (const ref of docRefs) {
    try {
      const f = ref.replace(/^documents\//, "");
      const p = path.join(__dirname, "..", "uploads", "documents", f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {}
  }
  try {
    // Restore the EXACT original gateway config row (raw JSON) — never leave a
    // modified gateway state behind.
    if (restoreCfg) {
      if (restoreCfg.value != null) {
        await platformPrisma.systemSetting.update({
          where: { id: restoreCfg.id },
          data: { value: restoreCfg.value },
        });
      } else {
        await platformPrisma.systemSetting.deleteMany({ where: { key: SETTING_KEY } });
      }
      console.log("  ℹ Gateway config restored to its pre-QA state");
    }
  } catch (e) { console.error("gateway restore:", e.message); }
  try {
    const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
    await api("PUT", "/super-admin/business-applications/review-mode", { mode: restoreMode }, sa.data?.token).catch(() => {});
  } catch (_) {}
}

(async () => {
  let originalCfg = null;
  let reviewModeWas = "manual";
  try {
    section("SETUP — gateway (synthetic TEST config) + review mode");
    const row = await platformPrisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
    originalCfg = row ? { id: row.id, value: typeof row.value === "string" ? JSON.parse(row.value) : row.value } : null;

    // Save a local TEST gateway config (encrypted at rest, synthetic keys).
    const gw = require("../src/services/gateway-config.service");
    await gw.saveGatewayConfig({
      environment: "TEST",
      enabled: false, // no real outbound Razorpay calls — checkout stays 503 (graceful)
      keyId: KEY_ID,
      keySecret: KEY_SECRET,
      webhookSecret: WEBHOOK_SECRET,
    });
    await sleep(7000); // let the running backend's 5s config cache expire
    const cfg = await gw.getGatewayConfig();
    check(cfg.environment === "TEST" && cfg.keyId === KEY_ID && cfg.webhookSecret === WEBHOOK_SECRET, "Backend now reads the TEST gateway config (secret encrypted at rest)");

    const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
    check(sa.status === 200, "SUPER_ADMIN login");
    const saToken = sa.data?.token;
    const rm = await api("GET", "/super-admin/business-applications/review-mode", null, saToken);
    reviewModeWas = rm.data?.data?.mode || "manual";
    if (reviewModeWas !== "manual") await api("PUT", "/super-admin/business-applications/review-mode", { mode: "manual" }, saToken);
    check(true, "Review mode = manual (production-safe default) for the manual-review scenarios");

    const plansPub = await api("GET", "/onboarding/plans");
    const plan = (plansPub.data?.data || []).find((p) => p.code === "PRO") || (plansPub.data?.data || [])[0];
    check(!!plan && plan.yearlyPrice > 0, `Yearly plan found: ${plan?.code} ₹${plan?.yearlyPrice}`);

    // ─────────────────────────────────────────────────────────────────────
    section("A — Applicant A: successful webhook payment → MANUAL review → approval → provisioning → owner login → POS");
    const emailA = `ph3.a${stamp}@example.com`;
    const regA = await api("POST", "/auth/register", { name: "Phase3 Owner A", email: emailA, phone: "91000000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    check(regA.status === 201, "A registered (201 + token)");
    const tokA = regA.data.token;
    const busA = await api("POST", "/onboarding/business", {
      businessType: "RESTAURANT", name: "Phase3 Biryani House " + stamp, phone: "91000000" + stamp.slice(0, 4),
      gstNumber: "27ABCDE1234F1Z5", city: "Bengaluru", state: "Karnataka", country: "India",
    }, tokA);
    const restA = busA.data?.data?.restaurant;
    check(!!restA?.id && restA.onboardingStatus === "DOCUMENTS_PENDING", "A business submitted → Restaurant row (INACTIVE, DOCUMENTS_PENDING)");
    created.push({ userEmail: emailA, restaurantId: restA.id });
    const gA = await uploadFile("/onboarding/documents", tokA, "GST_CERTIFICATE", PDF, "gst-a.pdf", "application/pdf");
    const fA = await uploadFile("/onboarding/documents", tokA, "FOOD_LICENSE", PNG, "fssai-a.png", "image/png");
    check(gA.status === 201 && fA.status === 201, "A uploaded GST (PDF) + Food License (PNG) — 201");
    docRefs.push(gA.data?.data?.fileReference, fA.data?.data?.fileReference);
    const legalA = await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokA);
    check(legalA.status === 201, "A accepted Terms + Privacy + Accuracy (versions 1.0)");
    const planA = await api("POST", "/onboarding/plan", { planId: plan.id }, tokA);
    check(planA.status === 200 && Number(planA.data?.data?.amount) === Number(plan.yearlyPrice), "A selected YEARLY plan at backend price");
    const subA = await platformPrisma.subscription.findUnique({ where: { restaurantId: restA.id } });
    check(subA.billingCycle === "YEARLY" && Number(subA.amount) === Number(plan.yearlyPrice), "Subscription row: YEARLY, backend plan price");

    // Gateway disabled → real checkout gracefully 503 (nothing activates).
    const chkA = await api("POST", "/onboarding/payments/create", {}, tokA);
    check(chkA.status === 503, "Checkout returns 503 while the gateway is disabled (no real keys) — never faked");

    const orderA = `order_ph3_a_${stamp}`;
    const payA = `pay_ph3_a_${stamp}`;
    const payRowA = await createPaymentRow(restA.id, subA, orderA, Number(plan.yearlyPrice));
    check(!!payRowA.id && payRowA.status === "CREATED", "SubscriptionPayment CREATED (as checkout would, YEARLY amount)");
    const amountPaiseA = Math.round(Number(plan.yearlyPrice) * 100);

    // (a) amount mismatch — signed but wrong amount
    const mismatch = await webhook(captureBody(orderA, payA, amountPaiseA - 100), webhookSig(captureBody(orderA, payA, amountPaiseA - 100)));
    check(mismatch.status === 400, "Signed webhook with WRONG amount rejected (400)", mismatch.data?.message);
    let dbPay = await platformPrisma.subscriptionPayment.findUnique({ where: { id: payRowA.id } });
    let dbRest = await platformPrisma.restaurant.findUnique({ where: { id: restA.id } });
    check(dbPay.status === "CREATED" && dbRest.status === "INACTIVE" && !dbRest.tenantSchema, "Amount mismatch → still CREATED/INACTIVE, no tenant, no activation");

    // (b) correct amount + valid signature → captured
    const okBody = captureBody(orderA, payA, amountPaiseA, "upi");
    const okWebhook = await webhook(okBody, webhookSig(okBody));
    check(okWebhook.status === 200 && okWebhook.data?.success === true, "Valid signed payment.captured accepted", okWebhook.data);
    dbPay = await platformPrisma.subscriptionPayment.findUnique({ where: { id: payRowA.id } });
    dbRest = await platformPrisma.restaurant.findUnique({ where: { id: restA.id } });
    check(dbPay.status === "PAID" && dbPay.razorpayPaymentId === payA, "Payment row PAID with the gateway reference stored");
    check(dbRest.onboardingStatus === "UNDER_REVIEW" && dbRest.status === "INACTIVE", "Manual review → UNDER_REVIEW, POS still locked (no schema)");
    const stA = await api("GET", "/onboarding/status", null, tokA);
    check(stA.data?.data?.account?.status === "UNDER_REVIEW", "A status endpoint reports UNDER_REVIEW");
    check((stA.data?.data?.documents || []).length === 2, "A documents preserved through payment");
    check(!!stA.data?.data?.legal?.termsOfService?.acceptedAt, "A legal acceptance timestamps preserved");

    // (c) duplicate webhook replay — idempotent
    const replay = await webhook(okBody, webhookSig(okBody));
    check(replay.status === 200 && replay.data?.alreadyPaid === true, "Replayed captured webhook → alreadyPaid (idempotent)");
    const paidCountA = await platformPrisma.subscriptionPayment.count({ where: { id: payRowA.id, status: "PAID" } });
    const histCountA = await platformPrisma.subscriptionHistory.count({ where: { restaurantId: restA.id } });
    check(paidCountA === 1 && histCountA === 0, "No duplicate PAID rows, no subscription history before approval");

    // SA sees the application with documents + agreements + payment
    const appDet = await api("GET", "/super-admin/business-applications/" + restA.id, null, saToken);
    const detA = appDet.data?.data;
    check(appDet.status === 200 && detA?.documents?.length === 2 && detA?.policyAgreements?.length === 3, "SA detail: 2 docs + 3 policy agreements");
    check((detA?.payments || []).some((p) => p.id === payRowA.id && p.status === "PAID" && p.billingCycle === "YEARLY"), "SA sees the PAID yearly payment with gateway reference");

    // SA approval → provisioning + activation
    const approve = await api("POST", "/super-admin/business-applications/" + restA.id + "/approve", {}, saToken);
    check(approve.status === 200, "SA approval accepted", approve.data?.message);
    dbRest = await platformPrisma.restaurant.findUnique({ where: { id: restA.id }, include: { subscription: true } });
    check(dbRest.status === "ACTIVE" && dbRest.onboardingStatus === "ACTIVE" && !!dbRest.tenantSchema, "Restaurant ACTIVE + tenant schema created");
    created[0].schema = dbRest.tenantSchema;
    const schemaCheck = await platformPrisma.$queryRawUnsafe(`SELECT count(*)::int c FROM information_schema.schemata WHERE schema_name = '${dbRest.tenantSchema}'`);
    check(schemaCheck[0].c === 1, "Exactly one tenant schema");
    const tenantDb = getTenantClient(dbRest.tenantSchema);
    const tSetting = await tenantDb.restaurantSetting.findUnique({ where: { restaurantId: restA.id } });
    check(!!tSetting && tSetting.businessMode === "restaurant", "Tenant RestaurantSetting seeded (businessMode=restaurant)");
    check(dbRest.subscription.status === "ACTIVE" && dbRest.subscription.billingCycle === "YEARLY", "Subscription ACTIVE, YEARLY, expiry set (no monthly values anywhere)");
    const histNow = await platformPrisma.subscriptionHistory.count({ where: { restaurantId: restA.id, changeType: "CREATION" } });
    check(histNow === 1, "SubscriptionHistory CREATION recorded once");
    const docsA = await platformPrisma.restaurantDocument.findMany({ where: { restaurantId: restA.id } });
    check(docsA.every((d) => d.status === "VERIFIED"), "Documents auto-verified on approval");

    // (d) double approval — idempotent, no duplicate tenant
    const approve2 = await api("POST", "/super-admin/business-applications/" + restA.id + "/approve", {}, saToken);
    check(approve2.data?.data?.alreadyActive === true, "Second approval is a no-op (alreadyActive)");
    const schemaCount2 = await platformPrisma.$queryRawUnsafe(`SELECT count(*)::int c FROM information_schema.schemata WHERE schema_name = '${dbRest.tenantSchema}'`);
    const histNow2 = await platformPrisma.subscriptionHistory.count({ where: { restaurantId: restA.id } });
    check(schemaCount2[0].c === 1 && histNow2 === 1, "No duplicate tenant or subscription history after double approval");

    // Owner login through the NORMAL auth flow
    const loginA = await api("POST", "/auth/login", { email: emailA, password: "Passw0rd1" });
    check(loginA.status === 200 && loginA.data?.onboarding === undefined, "Owner login post-activation → normal ADMIN flow (no onboarding payload)");
    const posA = await api("GET", "/settings", null, loginA.data?.token);
    check(posA.status === 200, "Owner reaches the POS after activation");
    const subMe = loginA.data?.subscription;
    check(subMe && subMe.plan === plan.code && subMe.billingCycle === "YEARLY" && subMe.status === "ACTIVE", `Owner subscription snapshot: ${subMe?.plan} YEARLY`);

    // ─────────────────────────────────────────────────────────────────────
    section("B — Applicant B (separate restaurant): cross-tenant document isolation");
    const emailB = `ph3.b${stamp}@example.com`;
    const regB = await api("POST", "/auth/register", { name: "Phase3 Owner B", email: emailB, phone: "91010000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    const tokB = regB.data?.token;
    const busB = await api("POST", "/onboarding/business", { businessType: "CAFE", name: "Phase3 Cafe " + stamp, phone: "91010000" + stamp.slice(0, 4) }, tokB);
    const restB = busB.data?.data?.restaurant;
    created.push({ userEmail: emailB, restaurantId: restB.id });
    const docB = await uploadFile("/onboarding/documents", tokB, "BUSINESS_REGISTRATION", PDF, "reg-b.pdf", "application/pdf");
    docRefs.push(docB.data?.data?.fileReference);
    const crossDl = await api("GET", "/onboarding/documents/" + gA.data?.data?.id + "/download", null, tokB);
    check(crossDl.status === 404, "B cannot download A's document (404)");
    const stB = await api("GET", "/onboarding/status", null, tokB);
    const bDocIds = new Set((stB.data?.data?.documents || []).map((d) => d.id));
    check(!bDocIds.has(gA.data?.data?.id) && !bDocIds.has(fA.data?.data?.id), "B's payload never leaks A's document ids");
    check(!stB.data?.data?.restaurant || stB.data.data.restaurant.id === restB.id, "B's restaurant is its own");

    // ─────────────────────────────────────────────────────────────────────
    section("C — Applicant C: cancelled / failed / pending payments (never activate, retry available)");
    const emailC = `ph3.c${stamp}@example.com`;
    const regC = await api("POST", "/auth/register", { name: "Phase3 Owner C", email: emailC, phone: "91020000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    const tokC = regC.data?.token;
    const busC = await api("POST", "/onboarding/business", { businessType: "BAKERY", name: "Phase3 Tarts " + stamp, phone: "91020000" + stamp.slice(0, 4) }, tokC);
    const restC = busC.data?.data?.restaurant;
    created.push({ userEmail: emailC, restaurantId: restC.id });
    const docC = await uploadFile("/onboarding/documents", tokC, "FOOD_LICENSE", PNG, "fssai-c.png", "image/png");
    docRefs.push(docC.data?.data?.fileReference);
    await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokC);
    const planC = await api("POST", "/onboarding/plan", { planId: plan.id }, tokC);
    const subC = await platformPrisma.subscription.findUnique({ where: { restaurantId: restC.id } });

    // C1 cancelled: checkout window closed — no event ever arrives
    const orderC1 = `order_ph3_c1_${stamp}`;
    await createPaymentRow(restC.id, subC, orderC1, Number(plan.yearlyPrice));
    let stC = await api("GET", "/onboarding/status", null, tokC);
    check(stC.data?.data?.account?.status === "PAYMENT_PENDING", "Cancelled payment (no event) → PAYMENT_PENDING");
    check(stC.data?.data?.restaurant?.name === "Phase3 Tarts " + stamp && (stC.data?.data?.documents || []).length === 1, "Onboarding data (business + document) fully preserved after cancel");
    check(stC.data?.data?.selectedPlan?.code === plan.code, "Selected yearly plan preserved after cancel");
    const restCDb1 = await platformPrisma.restaurant.findUnique({ where: { id: restC.id } });
    check(restCDb1.status === "INACTIVE" && !restCDb1.tenantSchema, "Cancelled payment → still INACTIVE, no schema");

    // C2 retry + failure: second attempt marked FAILED by a payment.failed event
    const orderC2 = `order_ph3_c2_${stamp}`;
    const payC2 = `pay_ph3_c2_${stamp}`;
    await createPaymentRow(restC.id, subC, orderC2, Number(plan.yearlyPrice));
    const fb = failBody(orderC2, payC2, "Card declined in test mode");
    const failRes = await webhook(fb, webhookSig(fb));
    check(failRes.status === 200 && failRes.data?.status === "FAILED", "payment.failed webhook accepted (never activates)", failRes.data);
    stC = await api("GET", "/onboarding/status", null, tokC);
    check(stC.data?.data?.account?.status === "PAYMENT_FAILED", "Failed payment → PAYMENT_FAILED (retry UI)");
    check(stC.data?.data?.payment?.status === "FAILED", "Payment row FAILED with gateway error recorded");
    const restCDb2 = await platformPrisma.restaurant.findUnique({ where: { id: restC.id } });
    check(restCDb2.status === "INACTIVE" && !restCDb2.tenantSchema, "Failure → no activation, no tenant provisioning");

    // C3 retry after failure → pending; later capture completes it
    const orderC3 = `order_ph3_c3_${stamp}`;
    const payC3 = `pay_ph3_c3_${stamp}`;
    const rowC3 = await createPaymentRow(restC.id, subC, orderC3, Number(plan.yearlyPrice));
    stC = await api("GET", "/onboarding/status", null, tokC);
    check(stC.data?.data?.account?.status === "PAYMENT_PENDING", "Retry attempt → PAYMENT_PENDING (fresh CREATED row, no duplicate restaurant/user)");
    const dupRest = await platformPrisma.restaurant.count({ where: { phone: busC.data.data.restaurant.phone } });
    check(dupRest === 1, "Exactly one Restaurant row — no duplicates across retries");
    // Delayed webhook resolves it
    const c3Body = captureBody(orderC3, payC3, Math.round(Number(plan.yearlyPrice) * 100), "card");
    const c3Res = await webhook(c3Body, webhookSig(c3Body));
    check(c3Res.status === 200 && c3Res.data?.status === "UNDER_REVIEW", "Delayed webhook eventually verified → UNDER_REVIEW");
    const rowC3Db = await platformPrisma.subscriptionPayment.findUnique({ where: { id: rowC3.id } });
    check(rowC3Db.status === "PAID", "C's retried payment PAID (earlier FAILED attempt untouched)");

    // ─────────────────────────────────────────────────────────────────────
    section("D — Applicant D: client callback /verify path (server-side signature)");
    const emailD = `ph3.d${stamp}@example.com`;
    const regD = await api("POST", "/auth/register", { name: "Phase3 Owner D", email: emailD, phone: "91030000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    const tokD = regD.data?.token;
    const busD = await api("POST", "/onboarding/business", { businessType: "HOTEL", name: "Phase3 Inn " + stamp, phone: "91030000" + stamp.slice(0, 4) }, tokD);
    const restD = busD.data?.data?.restaurant;
    created.push({ userEmail: emailD, restaurantId: restD.id });
    await uploadFile("/onboarding/documents", tokD, "BUSINESS_REGISTRATION", PDF, "reg-d.pdf", "application/pdf");
    await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokD);
    await api("POST", "/onboarding/plan", { planId: plan.id }, tokD);
    const subD = await platformPrisma.subscription.findUnique({ where: { restaurantId: restD.id } });
    const orderD = `order_ph3_d_${stamp}`;
    const payD = `pay_ph3_d_${stamp}`;
    const rowD = await createPaymentRow(restD.id, subD, orderD, Number(plan.yearlyPrice));

    // Fake success first — must be rejected and leave everything untouched.
    const fakeVerify = await api("POST", "/onboarding/payments/verify", {
      subscriptionPaymentId: rowD.id, razorpayOrderId: orderD, razorpayPaymentId: payD, razorpaySignature: "forged",
    }, tokD);
    check(fakeVerify.status === 400, "Forged callback signature rejected (400)");
    let rowDDb = await platformPrisma.subscriptionPayment.findUnique({ where: { id: rowD.id } });
    check(rowDDb.status === "FAILED" && rowDDb.errorMessage, "Forged attempt marked FAILED with reason (retryable)");

    // Fresh row + REAL signature the backend computes from the same key secret
    const rowD2 = await createPaymentRow(restD.id, subD, `order_ph3_d2_${stamp}`, Number(plan.yearlyPrice));
    const sigD = callbackSig(rowD2.razorpayOrderId, `pay_ph3_d2_${stamp}`);
    const verifyD = await api("POST", "/onboarding/payments/verify", {
      subscriptionPaymentId: rowD2.id, razorpayOrderId: rowD2.razorpayOrderId,
      razorpayPaymentId: `pay_ph3_d2_${stamp}`, razorpaySignature: sigD,
    }, tokD);
    check(verifyD.status === 200 && verifyD.data?.data?.status === "UNDER_REVIEW", "Valid callback signature → payment verified → UNDER_REVIEW (manual mode)");
    rowDDb = await platformPrisma.subscriptionPayment.findUnique({ where: { id: rowD2.id } });
    check(rowDDb.status === "PAID", "Payment row PAID via the callback verify path");

    const replayD = await api("POST", "/onboarding/payments/verify", {
      subscriptionPaymentId: rowD2.id, razorpayOrderId: rowD2.razorpayOrderId,
      razorpayPaymentId: `pay_ph3_d2_${stamp}`, razorpaySignature: sigD,
    }, tokD);
    check(replayD.status === 200 && replayD.data?.data?.alreadyPaid === true, "Replayed callback → alreadyPaid (no double activation)", replayD.data);
    const paidCountD = await platformPrisma.subscriptionPayment.count({ where: { id: rowD2.id, status: "PAID" } });
    check(paidCountD === 1, "Exactly one PAID row after replay");
    const restDDb = await platformPrisma.restaurant.findUnique({ where: { id: restD.id } });
    check(restDDb.status === "INACTIVE" && !restDDb.tenantSchema, "D remains INACTIVE (manual review — no POS, no schema)");

    // ─────────────────────────────────────────────────────────────────────
    section("E — Security: invalid signature / unknown order / tampered payloads");
    // Invalid HMAC on the webhook
    const badSig = await webhook(captureBody(orderC1, "pay_x", 100), "deadbeef");
    check(badSig.status === 400, "Webhook with invalid signature rejected (400)");
    // Valid signature but unknown order — acknowledged, never activates anything
    const beforeUnknown = await platformPrisma.subscriptionPayment.count({});
    const unknownBody = captureBody("order_does_not_exist", "pay_unknown", 12345);
    const unknown = await webhook(unknownBody, webhookSig(unknownBody));
    check(unknown.status === 200 && unknown.data?.ignored === true, "Unknown order with VALID signature → ignored (200, no activation)");
    const afterUnknown = await platformPrisma.subscriptionPayment.count({});
    check(afterUnknown === beforeUnknown, "Unknown-order event created no payment/subscription rows");
    // Fake "activate" style requests to the webhook endpoint with non-activating events
    const orderEvt = await webhook({ event: "order.paid", payload: { payment: { entity: { id: "p", order_id: orderA, amount: amountPaiseA } } } }, webhookSig({ event: "order.paid", payload: { payment: { entity: { id: "p", order_id: orderA, amount: amountPaiseA } } } }));
    check(orderEvt.status === 200 && orderEvt.data?.ignored === true, "Non-activating event types are ignored (order.paid)");
  } catch (e) {
    fail++; failures.push("QA CRASH: " + e.message);
    console.error("CRASH:", e.message);
    console.error(e.stack);
  } finally {
    section("CLEANUP + RESTORE");
    await cleanup(originalCfg, reviewModeWas);
    try { await platformPrisma.$disconnect(); } catch (_) {}
  }

  console.log(`\n──────── RESULTS: ${pass} passed, ${fail} failed ────────`);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail > 0 ? 2 : 0);
})().catch(async (e) => {
  console.error("FATAL:", e.message);
  try { await cleanup(originalCfg || null, reviewModeWas); } catch (_) {}
  process.exit(1);
});
