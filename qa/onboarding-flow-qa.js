/**
 * LIVE QA — self-serve restaurant onboarding flow.
 *
 * Requires the backend on :5001 (fresh code) and the dev DATABASE_URL in .env.
 * Hits the real API + real DB. Razorpay is NOT configured in this environment,
 * so the payment step is verified up to the graceful 503 + the anti-fake-success
 * guard; the verified-payment path is exercised by flipping the payment row to
 * PAID exactly like the signature/webhook verification would, then running the
 * SUPER_ADMIN approval (manual mode) and finishVerifiedPayment (auto mode).
 *
 * Usage: node qa/onboarding-flow-qa.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const { platformPrisma } = require("../src/config/tenantPrisma");
const { getTenantClient, invalidateTenantClient } = require("../src/config/tenantPrisma");
const onboardingService = require("../src/services/onboarding.service");

const BASE = "http://127.0.0.1:5001/api";
let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg + (detail ? " :: " + JSON.stringify(detail).slice(0, 500) : "")); console.log("  ❌ " + msg + (detail ? "\n     " + JSON.stringify(detail).slice(0, 500) : "")); }
}
function section(t) { console.log("\n──────── " + t + " ────────"); }

async function api(method, p, body, token) {
  const options = { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
  if (body !== undefined && body !== null) options.body = JSON.stringify(body);
  const res = await fetch(BASE + p, options);
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON (e.g. file) */ }
  return { status: res.status, data };
}

async function uploadFile(p, token, documentType, buf, filename, mime) {
  const fd = new FormData();
  fd.append("documentType", documentType);
  fd.append("file", new Blob([buf], { type: mime }), filename);
  const res = await fetch(BASE + p, { method: "POST", headers: { Authorization: `Bearer ${token}` } , body: fd });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const PDF = Buffer.from("255044462d312e340a312030206f626a3c3c2f547970652f436174616c6f673e3e656e646f626a0a747261696c65723c3c2f526f6f742031203020523e3e0a2525454f460a", "hex");
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex")]);
const stamp = Date.now().toString().slice(-8);
const created = []; // { userEmail, restaurantId, tenantSchema, docFileReferences: [] }

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
  for (const c of created) {
    for (const ref of c.docFileReferences || []) {
      const file = ref.replace(/^documents\//, "");
      const p = require("path").join(__dirname, "..", "uploads", "documents", file);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
  }
}

(async () => {
  let reviewModeWas = "manual";
  try {
    section("BOOT — backend + SUPER_ADMIN");
    const root = await fetch("http://127.0.0.1:5001/").catch(() => null);
    check(root && root.status === 200, "Backend responds on :5001");
    const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
    check(sa.status === 200, "SUPER_ADMIN login", sa.data?.message);
    const saToken = sa.data?.token;
    const rm = await api("GET", "/super-admin/business-applications/review-mode", null, saToken);
    reviewModeWas = rm.data?.data?.mode || "manual";
    check(reviewModeWas === "manual" || reviewModeWas === "auto", "Review mode readable (default manual)");
    if (reviewModeWas !== "manual") await api("PUT", "/super-admin/business-applications/review-mode", { mode: "manual" }, saToken);

    // ─────────────────────────────────────────────────────────────
    section("FLOW — Applicant A: register → business → docs → legal → plan → payment → MANUAL review → approval → ACTIVE");
    const emailA = `qa.a${stamp}@example.com`;
    const regA = await api("POST", "/auth/register", { name: "QA Owner A", email: emailA, phone: "90000000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    check(regA.status === 201 && regA.data?.token, `Register A → 201 + token`, regA.data?.message);
    const tokA = regA.data.token;
    const onbA0 = regA.data.onboarding || {};
    check(onbA0.account?.status === "REGISTERED" && onbA0.account?.step === "business", "Registration → REGISTERED / business step (no restaurant yet)");
    check(regA.data?.user?.role === "ADMIN" && !regA.data?.user?.restaurantId, "Registered as ADMIN with NO restaurantId (role escalation impossible)");

    // Duplicate email + POS blocked pre-activation
    const regA2 = await api("POST", "/auth/register", { name: "Dup", email: emailA, phone: "9000999999", password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    check(regA2.status === 400, "Duplicate email registration rejected");
    const posBlocked = await api("GET", "/settings", null, tokA);
    check(posBlocked.status === 403, "POS route blocked pre-activation (" + posBlocked.status + ")");

    // Public config + plans
    const cfg = await api("GET", "/onboarding/config");
    check(cfg.status === 200 && cfg.data?.data?.businessTypes?.length >= 7 && cfg.data?.data?.documentTypes?.length >= 7, "Public onboarding config (business/document types)");
    const plansPub = await api("GET", "/onboarding/plans");
    check(plansPub.status === 200 && Array.isArray(plansPub.data?.data) && plansPub.data.data.length >= 3, "Public plan list (no auth)");
    const plan = plansPub.data.data.find((p) => p.code === "PRO") || plansPub.data.data[0];
    check(!!plan && plan.yearlyPrice > 0, "Plan with yearly price found: " + (plan ? plan.code : "none"));

    // Status endpoint
    const st0 = await api("GET", "/onboarding/status", null, tokA);
    check(st0.status === 200 && st0.data?.data?.account?.status === "REGISTERED", "GET /onboarding/status → REGISTERED");

    // Business details
    const businessA = {
      businessType: "BAKERY", name: "QA Sweet Bakery " + stamp, legalName: "QA Sweet Bakery LLP", registrationNumber: "U1234" + stamp,
      ownerName: "QA Owner A", email: emailA, phone: "90000000" + stamp.slice(0, 4), gstNumber: "27ABCDE1234F1Z5",
      address: "12 Main Road", city: "Bengaluru", state: "Karnataka", country: "India", pincode: "560001", website: "https://qa.example.in",
    };
    const bus = await api("POST", "/onboarding/business", businessA, tokA);
    check(bus.status === 200 && bus.data?.data?.restaurant?.id, "Business details submitted → restaurant created", bus.data?.message);
    const restA = bus.data.data.restaurant;
    check(restA.onboardingStatus === "DOCUMENTS_PENDING" && restA.status === "INACTIVE", "Restaurant INACTIVE + DOCUMENTS_PENDING");
    check(restA.selfServe === true && restA.businessType === "BAKERY" && restA.legalName === "QA Sweet Bakery LLP" && restA.registrationNumber === "U1234" + stamp, "Business type/legal name/registration persisted");
    created.push({ userEmail: emailA, restaurantId: restA.id, docFileReferences: [] });

    // Editing own application (same phone) is allowed and must NOT rename it.
    const busDup = await api("POST", "/onboarding/business", { ...businessA, city: "Mysuru" }, tokA);
    check(busDup.status === 200 && busDup.data?.data?.restaurant?.name === businessA.name, "Business edit (same phone = same application) allowed, name preserved");

    // Documents: invalid then valid
    const badUpload = await uploadFile("/onboarding/documents", tokA, "GST_CERTIFICATE", Buffer.from("plain text pretending pdf"), "fake.pdf", "application/pdf");
    check(badUpload.status === 400, "Fake PDF (text bytes) rejected → 400", badUpload.data?.message);
    const gstUp = await uploadFile("/onboarding/documents", tokA, "GST_CERTIFICATE", PDF, "gst-" + stamp + ".pdf", "application/pdf");
    check(gstUp.status === 201 && gstUp.data?.data?.id, "Valid PDF (GST) uploaded → 201");
    const foodUp = await uploadFile("/onboarding/documents", tokA, "FOOD_LICENSE", PNG, "fssai-" + stamp + ".png", "image/png");
    check(foodUp.status === 201, "Valid PNG (Food License) uploaded → 201");
    const docA1 = gstUp.data.data;
    const docA2 = foodUp.data.data;
    created[0].docFileReferences.push(docA1.fileReference, docA2.fileReference);

    const huge = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
    const bigUp = await uploadFile("/onboarding/documents", tokA, "OTHER", huge, "huge.pdf", "application/pdf");
    check(bigUp.status === 400, "Oversized upload rejected → 400", bigUp.data?.message);

    const stAfterDocs = await api("GET", "/onboarding/status", null, tokA);
    check(stAfterDocs.data?.data?.account?.status === "LEGAL_PENDING", "After first valid doc → LEGAL_PENDING");

    // Privacy: docs not reachable via public /uploads
    const pubDoc = await fetch("http://127.0.0.1:5001/uploads/" + docA1.fileReference);
    check(pubDoc.status === 404, "Public /uploads/<document> blocked (404)");

    // Legal
    const partialLegal = await api("POST", "/onboarding/legal", { acceptances: [{ type: "TERMS_OF_SERVICE", version: "1.0" }] }, tokA);
    check(partialLegal.status === 400, "Partial legal (terms only) rejected");
    const wrongVer = await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "2.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokA);
    check(wrongVer.status === 400, "Wrong policy version rejected (backend version authoritative)");
    const legal = await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokA);
    check(legal.status === 201, "Legal accepted (3 explicit agreements)");
    const stAfterLegal = await api("GET", "/onboarding/status", null, tokA);
    check(stAfterLegal.data?.data?.account?.status === "PLAN_PENDING", "After legal → PLAN_PENDING");
    const pa = stAfterLegal.data.data.legal;
    check(pa.termsOfService?.version === "1.0" && pa.privacyPolicy?.version === "1.0" && pa.accuracyConfirmation?.version === "1.0" && pa.termsOfService?.acceptedAt, "Exact versions + acceptance timestamps stored");

    // Plan selection
    const planPick = await api("POST", "/onboarding/plan", { planId: plan.id }, tokA);
    check(planPick.status === 200 && planPick.data?.data?.amount === plan.yearlyPrice, "Plan selected (yearly amount " + plan.yearlyPrice + ")");
    const stAfterPlan = await api("GET", "/onboarding/status", null, tokA);
    check(stAfterPlan.data?.data?.account?.status === "PLAN_SELECTED", "After plan → PLAN_SELECTED");
    check(stAfterPlan.data?.data?.selectedPlan?.code === plan.code, "Selected plan visible on status");

    // Payment: gateway unavailable → graceful 503 (never a silent activation)
    const chk = await api("POST", "/onboarding/payments/create", {}, tokA);
    check(chk.status === 503 || chk.status === 201, "Checkout: 503 when gateway unconfigured (expected here) or 201", chk.data?.message);
    check(stAfterPlan.data?.data?.payment === null, "No payment row before checkout");

    // Anti-fake-success: bogus verify must NOT activate anything
    const fakeVerify = await api("POST", "/onboarding/payments/verify", { subscriptionPaymentId: 999999, razorpayOrderId: "order_fake", razorpayPaymentId: "pay_fake", razorpaySignature: "bogus" }, tokA);
    check(fakeVerify.status === 400 || fakeVerify.status === 404, "Fabricated payment verification rejected (" + fakeVerify.status + ")");
    const restDbAfterFake = await platformPrisma.restaurant.findUnique({ where: { id: restA.id }, select: { status: true, tenantSchema: true, onboardingStatus: true } });
    check(restDbAfterFake.status === "INACTIVE" && !restDbAfterFake.tenantSchema, "No activation after fake success (frontend cannot self-activate)");

    // SA list + detail
    const appList = await api("GET", "/super-admin/business-applications?search=" + encodeURIComponent("QA Sweet Bakery"), null, saToken);
    check(appList.status === 200 && (appList.data?.data?.applications || []).some((a) => a.id === restA.id), "SA business-applications list includes application A");
    const appDet = await api("GET", "/super-admin/business-applications/" + restA.id, null, saToken);
    const det = appDet.data?.data;
    check(appDet.status === 200 && det?.documents?.length === 2 && det?.policyAgreements?.length === 3, "SA detail: 2 docs + 3 policy agreements");
    check(det?.subscription?.status === "PENDING_PAYMENT" && det?.owner?.email === emailA, "SA detail: pending subscription + owner");

    // SA cannot approve an UNPAID application
    const earlyApprove = await api("POST", "/super-admin/business-applications/" + restA.id + "/approve", {}, saToken);
    check(earlyApprove.status === 400, "Approve blocked before verified payment");

    // Cross-tenant: applicant B (own restaurant) cannot read A's document
    const emailB = `qa.b${stamp}@example.com`;
    const regB = await api("POST", "/auth/register", { name: "QA Owner B", email: emailB, phone: "90010000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    const tokB = regB.data?.token;
    const busB = await api("POST", "/onboarding/business", { businessType: "CAFE", name: "QA Cafe " + stamp, phone: "90010000" + stamp.slice(0, 4) }, tokB);
    check(busB.status === 200, "Applicant B business created");
    const restB = busB.data.data.restaurant;
    created.push({ userEmail: emailB, restaurantId: restB.id, docFileReferences: [] });

    // Duplicate phone across DIFFERENT applications is rejected.
    const phoneDup = await api("POST", "/onboarding/business", { businessType: "CAFE", name: "QA Cafe dup", phone: businessA.phone }, tokB);
    check(phoneDup.status === 400 && /phone/i.test(phoneDup.data?.message || ""), "Duplicate phone across applications rejected", phoneDup.data?.message);

    const crossDoc = await api("GET", "/onboarding/documents/" + docA1.id + "/download", null, tokB);
    check(crossDoc.status === 404, "Cross-tenant document access blocked (B → A's doc 404)");
    const bSt = await api("GET", "/onboarding/status", null, tokB);
    check((bSt.data?.data?.documents || []).length === 0, "B sees only its own onboarding data");

    // Simulate the verified webhook: the gateway is not configured here, so no
    // CREATED row exists (checkout returned 503). Create the row exactly as
    // createCheckout would, then flip it PAID like the signature verification.
    const subRow = await platformPrisma.subscription.findUnique({ where: { restaurantId: restA.id } });
    let payRow = await platformPrisma.subscriptionPayment.findFirst({ where: { subscriptionId: subRow.id }, orderBy: { createdAt: "desc" } });
    if (!payRow) {
      payRow = await platformPrisma.subscriptionPayment.create({
        data: {
          restaurantId: restA.id, subscriptionId: subRow.id, planId: subRow.planId, planCode: subRow.plan,
          planName: subRow.plan, billingCycle: "YEARLY", action: "ACTIVATION", amount: subRow.amount, status: "CREATED",
          razorpayOrderId: "order_QA_" + stamp, createdBy: null,
        },
      });
    }
    await platformPrisma.subscriptionPayment.update({ where: { id: payRow.id }, data: { status: "PAID", razorpayPaymentId: "pay_QA_" + stamp, paidAt: new Date() } });

    // Manual review: SA approve → provision + activate
    const approve = await api("POST", "/super-admin/business-applications/" + restA.id + "/approve", {}, saToken);
    check(approve.status === 200, "SA approval → provisioning + activation", approve.data?.message);
    const restAAfter = await platformPrisma.restaurant.findUnique({ where: { id: restA.id }, include: { subscription: true } });
    check(restAAfter.status === "ACTIVE" && restAAfter.onboardingStatus === "ACTIVE" && !!restAAfter.tenantSchema, "Restaurant ACTIVE + tenant schema created");
    created[0].tenantSchema = restAAfter.tenantSchema;
    const tenantA = getTenantClient(restAAfter.tenantSchema);
    const tSetting = await tenantA.restaurantSetting.findUnique({ where: { restaurantId: restA.id } });
    check(!!tSetting && tSetting.restaurantName === "QA Sweet Bakery " + stamp, "Tenant RestaurantSetting seeded");
    const subAfter = await platformPrisma.subscription.findUnique({ where: { restaurantId: restA.id } });
    check(subAfter.status === "ACTIVE" && subAfter.businessMode === "RESTAURANT" && subAfter.plan === plan.code, "Subscription ACTIVE with plan snapshot");
    const hist = await platformPrisma.subscriptionHistory.count({ where: { restaurantId: restA.id } });
    check(hist >= 1, "SubscriptionHistory CREATION recorded");
    const docsAfter = await platformPrisma.restaurantDocument.findMany({ where: { restaurantId: restA.id } });
    check(docsAfter.every((d) => d.status === "VERIFIED"), "Documents auto-verified on approval");

    // Idempotency: second approval must not re-provision
    const approve2 = await api("POST", "/super-admin/business-applications/" + restA.id + "/approve", {}, saToken);
    check(approve2.status === 200 && approve2.data?.data?.alreadyActive === true, "Duplicate approval is a no-op (alreadyActive)");
    const schemas2 = await platformPrisma.$queryRawUnsafe(`SELECT count(*)::int c FROM information_schema.schemata WHERE schema_name = '${restAAfter.tenantSchema}'`);
    check(schemas2[0].c === 1, "Tenant schema not duplicated");

    // Owner now logs in normally (existing flow — no onboarding payload)
    const loginA2 = await api("POST", "/auth/login", { email: emailA, password: "Passw0rd1" });
    check(loginA2.status === 200 && loginA2.data?.onboarding === undefined && loginA2.data?.subscription?.plan === plan.code, "Owner login post-activation → normal ADMIN flow with subscription");
    const posOk = await api("GET", "/settings", null, loginA2.data?.token);
    check(posOk.status === 200, "POS route reachable after activation (" + posOk.status + ")");

    // Authorized downloads
    const ownerDl = await fetch(BASE + "/onboarding/documents/" + docA2.id + "/download", { headers: { Authorization: `Bearer ${loginA2.data.token}` } });
    const ownerBytes = (await ownerDl.arrayBuffer()).byteLength;
    check(ownerDl.status === 200 && ownerBytes > 0, "Owner can download own document (authorized, " + ownerBytes + " bytes)");
    const saDl = await fetch(BASE + `/super-admin/restaurants/${restA.id}/documents/${docA1.id}/download?token=${encodeURIComponent(saToken)}`);
    check(saDl.status === 200, "SUPER_ADMIN can download application document (token-query)");
    const unauthDl = await fetch(BASE + "/onboarding/documents/" + docA1.id + "/download");
    check(unauthDl.status === 401 || unauthDl.status === 404, "Unauthenticated document download denied");

    // ─────────────────────────────────────────────────────────────
    section("FLOW — Applicant B: zero documents can't continue; rejection path");
    const legalNoDoc = await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokB);
    check(legalNoDoc.status === 400 && /at least one valid business document|not available yet/i.test(legalNoDoc.data?.message || ""), "Legal rejected with ZERO documents", legalNoDoc.data?.message);
    const planNoDoc = await api("POST", "/onboarding/plan", { planId: plan.id }, tokB);
    check(planNoDoc.status === 400, "Plan selection rejected with ZERO documents");

    const rejectB = await api("POST", "/super-admin/business-applications/" + restB.id + "/reject", { reason: "QA: invalid registration certificate content" }, saToken);
    check(rejectB.status === 200, "SA rejection recorded (reason required path)");
    const rejectNoReason = await api("POST", "/super-admin/business-applications/" + restB.id + "/reject", {}, saToken);
    check(rejectNoReason.status === 400, "Rejection without reason rejected");
    const loginB2 = await api("POST", "/auth/login", { email: emailB, password: "Passw0rd1" });
    const onbB = loginB2.data?.onboarding;
    check(loginB2.status === 200 && onbB?.account?.status === "REJECTED" && /invalid registration/.test(onbB?.restaurant?.onboardingNote || ""), "Rejected owner logs in → sees rejection reason");
    check((await api("GET", "/settings", null, loginB2.data?.token)).status === 403, "Rejected account still blocked from POS");
    const editBlocked = await api("POST", "/onboarding/business", { businessType: "CAFE", name: "QA Cafe " + stamp + " edit", phone: "90010000" + stamp.slice(0, 4) }, tokB);
    check(editBlocked.status === 400, "Rejected applicant cannot edit business");

    // ─────────────────────────────────────────────────────────────
    section("FLOW — Applicant D: AUTO review mode (config toggle) provisions immediately");
    const emailD = `qa.d${stamp}@example.com`;
    const regD = await api("POST", "/auth/register", { name: "QA Owner D", email: emailD, phone: "90020000" + stamp.slice(0, 4), password: "Passw0rd1", confirmPassword: "Passw0rd1" });
    const tokD = regD.data?.token;
    check(regD.status === 201, "Register D");
    const busD = await api("POST", "/onboarding/business", { businessType: "HOTEL", name: "QA Hotel " + stamp, phone: "90020000" + stamp.slice(0, 4) }, tokD);
    const restD = busD.data?.data?.restaurant;
    created.push({ userEmail: emailD, restaurantId: restD.id, docFileReferences: [] });
    await uploadFile("/onboarding/documents", tokD, "BUSINESS_REGISTRATION", PDF, "reg-" + stamp + ".pdf", "application/pdf");
    const dUp = await platformPrisma.restaurantDocument.findFirst({ where: { restaurantId: restD.id } });
    if (dUp) created[2].docFileReferences.push(dUp.fileReference);
    await api("POST", "/onboarding/legal", { acceptances: [
      { type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" },
    ] }, tokD);
    const pickD = await api("POST", "/onboarding/plan", { planId: plan.id }, tokD);
    check(pickD.status === 200, "D plan selected");
    const subD = await platformPrisma.subscription.findUnique({ where: { restaurantId: restD.id } });
    let payD = await platformPrisma.subscriptionPayment.findFirst({ where: { subscriptionId: subD.id } });
    if (!payD) {
      payD = await platformPrisma.subscriptionPayment.create({
        data: {
          restaurantId: restD.id, subscriptionId: subD.id, planId: subD.planId, planCode: subD.plan,
          planName: subD.plan, billingCycle: "YEARLY", action: "ACTIVATION", amount: subD.amount, status: "CREATED",
          razorpayOrderId: "order_QA_d_" + stamp, createdBy: null,
        },
      });
    }
    await platformPrisma.subscriptionPayment.update({ where: { id: payD.id }, data: { status: "PAID", razorpayPaymentId: "pay_QA_d_" + stamp, paidAt: new Date() } });
    await api("PUT", "/super-admin/business-applications/review-mode", { mode: "auto" }, saToken);
    const finD = await onboardingService.finishVerifiedPayment({ id: restD.id, status: "INACTIVE" }, { amount: subD.amount, planCode: subD.plan }, null, { ipAddress: null, userAgent: "qa-auto" });
    check(finD.status === "ACTIVE", "Auto mode: verified payment → immediate activation");
    const restDAfter = await platformPrisma.restaurant.findUnique({ where: { id: restD.id }, select: { status: true, onboardingStatus: true, tenantSchema: true } });
    check(restDAfter.status === "ACTIVE" && restDAfter.onboardingStatus === "ACTIVE" && !!restDAfter.tenantSchema, "D provisioned + ACTIVE (auto review)");
    created[2].tenantSchema = restDAfter.tenantSchema;
    const finD2 = await onboardingService.finishVerifiedPayment({ id: restD.id, status: "ACTIVE" }, { amount: subD.amount }, null, {});
    check(finD2.alreadyActive === true, "Auto path idempotent (second call no-ops)");
  } catch (e) {
    fail++; failures.push("QA CRASH: " + e.message);
    console.error("CRASH:", e.message);
    console.error(e.stack);
  } finally {
    // Restore review mode + cleanup
    try {
      const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
      await api("PUT", "/super-admin/business-applications/review-mode", { mode: reviewModeWas }, sa.data?.token).catch(() => {});
    } catch (_) {}
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
