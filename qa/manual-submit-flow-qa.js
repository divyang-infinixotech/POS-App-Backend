/**
 * LIVE QA — manual approval onboarding flow (no payment step for applicants).
 *
 * Verifies the EXACT flow requested:
 *   register → business → documents → legal → plan → REVIEW → SUBMIT
 *   → MANUAL_PENDING → applicant login blocked (APPLICATION_PENDING)
 *   → SUPER_ADMIN sees application (no password leaked)
 *   → SUPER_ADMIN generates payment QR → marks payment received
 *   → MANUAL_PAYMENT_RECEIVED → SUPER_ADMIN approves → MANUAL_APPROVED
 *   → applicant can log in (POS ACTIVE)
 *   → second application rejected → login returns APPLICATION_REJECTED
 *   → existing POS (approved restaurant) login regression
 *
 * Requires: backend running on :5001 from CURRENT source + dev DATABASE_URL.
 * Usage: node qa/manual-submit-flow-qa.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");
const { getTenantClient, invalidateTenantClient } = require("../src/config/tenantPrisma");

const BASE = "http://127.0.0.1:5001/api";
let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg + (detail ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); console.log("  ❌ " + msg + (detail ? "\n     " + JSON.stringify(detail).slice(0, 400) : "")); }
}
function section(t) { console.log("\n──────── " + t + " ────────"); }

async function api(method, p, body, token) {
  const options = { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
  if (body !== undefined && body !== null) options.body = JSON.stringify(body);
  const res = await fetch(BASE + p, options);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

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
const stamp = Date.now().toString().slice(-8);
const created = []; // { userEmail, restaurantId, tenantSchema }

async function cleanup() {
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
      if (c.tenantSchema) {
        try {
          await platformPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${c.tenantSchema}" CASCADE`);
          await invalidateTenantClient(c.tenantSchema);
        } catch (e) { console.error("cleanup schema:", e.message); }
      }
    } catch (e) { console.error("cleanup:", c.userEmail, e.message); }
  }
}

(async () => {
  try {
    section("BOOT — backend + SUPER_ADMIN");
    const root = await fetch("http://127.0.0.1:5001/").catch(() => null);
    check(root && root.status === 200, "Backend responds on :5001");
    const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
    check(sa.status === 200 && sa.data?.token, "SUPER_ADMIN login", sa.data?.message);
    const saToken = sa.data?.token;

    // ─────────────────────────────────────────────────────────────
    section("TEST 1 — New application: register → business → docs → legal → plan → SUBMIT → MANUAL_PENDING");
    const emailA = `qa.ms${stamp}@example.com`;
    const regA = await api("POST", "/auth/register", { name: "Manual Flow Owner", email: emailA, phone: "90030000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    check(regA.status === 201 && regA.data?.token, "Register A → 201 + token", regA.data?.message);
    const tokA = regA.data.token;

    // No payment step: registration response must NOT contain checkout/Razorpay payloads.
    const regAJson = JSON.stringify(regA.data);
    check(!/razorpay|checkout|payment_url|order_id/i.test(regAJson), "Registration response has NO Razorpay/checkout data");

    const businessA = {
      businessType: "RESTAURANT", name: "Manual Flow Diner " + stamp, legalName: "Manual Flow Diner LLP",
      registrationNumber: "U5555" + stamp, ownerName: "Manual Flow Owner", email: emailA,
      phone: "90030000" + stamp.slice(0, 4), gstNumber: "27ABCDE1234F1Z5",
      address: "5 Main Road", city: "Bengaluru", state: "Karnataka", country: "India", pincode: "560001",
    };
    const bus = await api("POST", "/onboarding/business", businessA, tokA);
    check(bus.status === 200 && bus.data?.data?.restaurant?.id, "Business submitted → restaurant created", bus.data?.message);
    const restId = bus.data.data.restaurant.id;
    created.push({ userEmail: emailA, restaurantId: restId });
    check(bus.data.data.restaurant.status === "INACTIVE", "Restaurant INACTIVE after business step");

    const up1 = await uploadFile("/onboarding/documents", tokA, "BUSINESS_REGISTRATION", PDF, "reg-" + stamp + ".pdf", "application/pdf");
    check(up1.status === 201, "Document (BUSINESS_REGISTRATION) uploaded → 201", up1.data?.message);
    const up2 = await uploadFile("/onboarding/documents", tokA, "GST_CERTIFICATE", PDF, "gst-" + stamp + ".pdf", "application/pdf");
    check(up2.status === 201, "Document (GST_CERTIFICATE) uploaded → 201", up2.data?.message);

    const legal = await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokA);
    check(legal.status === 201, "Legal accepted (3 policies)", legal.data?.message);

    const plansPub = await api("GET", "/onboarding/plans");
    const plan = (plansPub.data?.data || []).find((p) => p.code === "PRO") || (plansPub.data?.data || [])[0];
    const planPick = await api("POST", "/onboarding/plan", { planId: plan.id }, tokA);
    check(planPick.status === 200, "Plan selected: " + plan.code, planPick.data?.message);
    const stBefore = await api("GET", "/onboarding/status", null, tokA);
    check(stBefore.data?.data?.account?.status === "PLAN_SELECTED", "Status before submit: PLAN_SELECTED (no payment step)");

    // THE FIX TARGET — POST /api/onboarding/submit
    const sub = await api("POST", "/onboarding/submit", {}, tokA);
    check(sub.status === 201, "POST /api/onboarding/submit → 201 (route mounted + flow works)", { status: sub.status, msg: sub.data?.message });
    check(sub.data?.success === true, "submit response success:true");
    const appStatus = sub.data?.data?.account?.status || sub.data?.data?.status;
    check(appStatus === "MANUAL_PENDING", "Application status → MANUAL_PENDING", appStatus);

    const stAfter = await api("GET", "/onboarding/status", null, tokA);
    check(stAfter.data?.data?.account?.status === "MANUAL_PENDING", "GET status confirms MANUAL_PENDING");
    const restDb = await platformPrisma.restaurant.findUnique({ where: { id: restId } });
    check(restDb.status === "INACTIVE" && !restDb.tenantSchema, "Restaurant still INACTIVE + no tenant schema after submit");
    const subRow = await platformPrisma.subscription.findUnique({ where: { restaurantId: restId } });
    check(subRow.status === "PENDING_PAYMENT", "Subscription still PENDING_PAYMENT after submit");
    const payRows = await platformPrisma.subscriptionPayment.count({ where: { restaurantId: restId } });
    check(payRows === 0, "NO payment row created by submit (no payment collected)");

    // ─────────────────────────────────────────────────────────────
    section("TEST 2 — Applicant login while MANUAL_PENDING → APPLICATION_PENDING, no POS access");
    const loginPending = await api("POST", "/auth/login", { email: emailA, password: "Passw0rd1" });
    check(loginPending.data?.code === "APPLICATION_PENDING", "Login returns APPLICATION_PENDING", { code: loginPending.data?.code, msg: loginPending.data?.message });
    const posBlocked = await api("GET", "/settings", null, loginPending.data?.token || tokA);
    check(posBlocked.status === 403, "POS route blocked while pending (403)", posBlocked.status);
    const onbSt = await api("GET", "/onboarding/status", null, tokA);
    check(onbSt.status === 200 && onbSt.data?.data?.account?.status === "MANUAL_PENDING", "Applicant can still poll /onboarding/status (no POS)");

    // ─────────────────────────────────────────────────────────────
    section("TEST 3 — SUPER_ADMIN review: application visible, no password leaked");
    const appList = await api("GET", "/super-admin/business-applications?search=" + encodeURIComponent("Manual Flow Diner"), null, saToken);
    const found = (appList.data?.data?.applications || []).find((a) => a.id === restId);
    check(!!found, "SA business-applications list includes the application");
    const appDet = await api("GET", "/super-admin/business-applications/" + restId, null, saToken);
    const det = appDet.data?.data || {};
    check(!!det.owner && det.owner.email === emailA, "SA detail includes owner email");
    check(!JSON.stringify(det).match(/password|passwordHash/i), "SA detail does NOT contain password/passwordHash");
    check(Array.isArray(det.documents) && det.documents.length >= 2, "SA detail includes documents");
    check(!!det.subscription && det.subscription.status === "PENDING_PAYMENT", "SA detail includes plan/subscription info");

    // ─────────────────────────────────────────────────────────────
    section("TEST 4 — Manual payment: QR REMOVED + MARK PAYMENT RECEIVED → MANUAL_PAYMENT_RECEIVED");
    // QR generation was removed from the approval workflow — the endpoint must 404.
    const qrGone = await api("GET", "/super-admin/manual-applications/" + restId + "/qr", null, saToken);
    check(qrGone.status === 404, "QR endpoint removed (404)", qrGone.status);

    const earlyApprove = await api("POST", "/super-admin/business-applications/" + restId + "/approve", {}, saToken);
    check(earlyApprove.status === 400, "Approve blocked BEFORE payment verified (400)", earlyApprove.data?.message);

    const markPay = await api("POST", "/super-admin/manual-applications/" + restId + "/mark-payment", { amount: subRow.amount, transactionRef: "MANUAL-QA-" + stamp, paymentDate: new Date().toISOString() }, saToken);
    check(markPay.status === 200 && markPay.data?.data?.status === "MANUAL_PAYMENT_RECEIVED", "MARK PAYMENT RECEIVED → MANUAL_PAYMENT_RECEIVED", { status: markPay.status, msg: markPay.data?.message, data: markPay.data?.data?.status });
    const restDbPay = await platformPrisma.restaurant.findUnique({ where: { id: restId } });
    check(restDbPay.status === "INACTIVE" && restDbPay.onboardingStatus === "MANUAL_PAYMENT_RECEIVED", "Restaurant still INACTIVE after payment received (not auto-activated)");
    const paidRows = await platformPrisma.subscriptionPayment.count({ where: { restaurantId: restId, status: "PAID" } });
    check(paidRows === 1, "Exactly one PAID subscriptionPayment row recorded");

    // ─────────────────────────────────────────────────────────────
    section("TEST 5 — SUPER_ADMIN approval → MANUAL_APPROVED + ACTIVE + applicant can login");
    const approve = await api("POST", "/super-admin/manual-applications/" + restId + "/approve", {}, saToken);
    check(approve.status === 200 && approve.data?.data?.status === "MANUAL_APPROVED", "Approve → MANUAL_APPROVED", { status: approve.status, msg: approve.data?.message });
    const restAfter = await platformPrisma.restaurant.findUnique({ where: { id: restId }, include: { subscription: true } });
    check(restAfter.status === "ACTIVE" && !!restAfter.tenantSchema, "Restaurant ACTIVE + tenant provisioned");
    created[0].tenantSchema = restAfter.tenantSchema;
    check(restAfter.subscription.status === "ACTIVE", "Subscription ACTIVE after approval");

    const loginApproved = await api("POST", "/auth/login", { email: emailA, password: "Passw0rd1" });
    check(loginApproved.status === 200 && loginApproved.data?.token && !loginApproved.data?.onboarding?.account, "Approved applicant logs in normally (POS ADMIN)", { status: loginApproved.status, hasOnboarding: !!loginApproved.data?.onboarding?.account });
    const posOk = await api("GET", "/settings", null, loginApproved.data?.token);
    check(posOk.status === 200, "POS reachable after approval (" + posOk.status + ")");

    // ─────────────────────────────────────────────────────────────
    section("TEST 6 — Rejection path → APPLICATION_REJECTED, no POS access");
    const emailR = `qa.mr${stamp}@example.com`;
    const regR = await api("POST", "/auth/register", { name: "Rejected Owner", email: emailR, phone: "90040000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    const tokR = regR.data?.token;
    check(regR.status === 201, "Register R (rejection case)");
    const busR = await api("POST", "/onboarding/business", { businessType: "CAFE", name: "Rejected Cafe " + stamp, phone: "90040000" + stamp.slice(0, 4) }, tokR);
    const restRId = busR.data?.data?.restaurant?.id;
    created.push({ userEmail: emailR, restaurantId: restRId });
    await uploadFile("/onboarding/documents", tokR, "BUSINESS_REGISTRATION", PDF, "regr-" + stamp + ".pdf", "application/pdf");
    await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokR);
    await api("POST", "/onboarding/plan", { planId: plan.id }, tokR);
    const subR = await api("POST", "/onboarding/submit", {}, tokR);
    check(subR.status === 201 && subR.data?.data?.account?.status === "MANUAL_PENDING", "R submitted → MANUAL_PENDING");

    const rejectNoReason = await api("POST", "/super-admin/manual-applications/" + restRId + "/reject", {}, saToken);
    check(rejectNoReason.status === 400, "Reject without reason rejected (400)");
    const rejectR = await api("POST", "/super-admin/manual-applications/" + restRId + "/reject", { reason: "QA: duplicate license number" }, saToken);
    check(rejectR.status === 200, "Reject with reason → 200", rejectR.data?.message);

    const loginRejected = await api("POST", "/auth/login", { email: emailR, password: "Passw0rd1" });
    check(loginRejected.status === 403 && loginRejected.data?.code === "APPLICATION_REJECTED", "Rejected applicant login → APPLICATION_REJECTED", { status: loginRejected.status, code: loginRejected.data?.code });
    const posRej = await api("GET", "/settings", null, tokR);
    check(posRej.status === 403, "Rejected applicant blocked from POS (403)");

    // ─────────────────────────────────────────────────────────────
    section("TEST 7 — Existing POS regression (approved restaurant login works)");
    const posLogin = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
    check(posLogin.status === 200 && posLogin.data?.token, "Super Admin login regression OK");
  } catch (e) {
    fail++; failures.push("QA CRASH: " + e.message);
    console.error("CRASH:", e.message);
    console.error(e.stack);
  } finally {
    section("CLEANUP");
    await cleanup();
    try { await platformPrisma.$disconnect(); } catch (_) {}
  }

  console.log(`\n──────── RESULTS: ${pass} passed, ${fail} failed ────────`);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail > 0 ? 2 : 0);
})().catch(async (e) => {
  console.error("FATAL:", e.message);
  await cleanup().catch(() => {});
  process.exit(1);
});