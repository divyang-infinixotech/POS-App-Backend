/**
 * Live test: Razorpay webhook → signature verification → idempotent activation.
 *
 * Since real Razorpay keys are not configured in this environment, the
 * signature is computed locally with the same HMAC algorithm and the same
 * webhook secret the backend is running with. This exercises the REAL
 * crypto.verifyWebhookSignature path, the raw-body parser, and the
 * activateSubscriptionPayment transaction against live PostgreSQL.
 *
 * Requires backend started with: RAZORPAY_WEBHOOK_SECRET=test-webhook-secret
 */
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BASE = "http://localhost:5001/api";
const SECRET = "test-webhook-secret";
let pass = 0, fail = 0;
const check = (cond, msg) => {
  process.stdout.write(cond ? "  ✅ " : "  ❌ ");
  console.log(msg);
  cond ? pass++ : fail++;
};

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

(async () => {
  // ── 1. Super admin login + throwaway restaurant ──
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  const saToken = sa.data?.token;
  const ts = Date.now();
  const createRest = await api("POST", "/super-admin/restaurants", {
    name: `QA Webhook ${ts}`,
    ownerName: "QA Owner",
    mobile: `98${String(ts).slice(-8)}`,
    email: `qa-wh-${ts}@test.com`,
    adminName: "QA Admin",
    adminEmail: `qa-wh-admin-${ts}@test.com`,
    adminPassword: "SubPass@123",
  }, saToken);
  const rest = createRest.data?.data || createRest.data?.restaurant;
  check(!!rest?.id, `Throwaway restaurant created (${createRest.status})`);

  const adminLogin = await api("POST", "/auth/login", { email: `qa-wh-admin-${ts}@test.com`, password: "SubPass@123" });
  const token = adminLogin.data?.token;

  const me = await api("GET", "/subscriptions/me", null, token);
  const sub = me.data?.data || me.data?.subscription;
  const beforePlan = sub?.plan;
  const beforeExpiry = sub?.expiryDate;
  check(!!sub?.id, `Subscription snapshot before activation (plan=${beforePlan})`);

  // ── 2. Pick a higher plan for the upgrade webhook ──
  const plans = await api("GET", "/subscriptions/plans", null, token);
  const planList = Array.isArray(plans.data?.data) ? plans.data.data : plans.data?.plans || [];
  const current = planList.find((p) => p.code === beforePlan);
  const higher = planList.find((p) => Number(p.monthlyPrice) > Number(current?.monthlyPrice || 0) && p.code !== "TRIAL");
  check(!!higher, `Higher plan for activation test (${higher?.code || "none"})`);

  // ── 3. Create a CREATED SubscriptionPayment directly (as checkout would) ──
  const orderId = `order_test_${ts}`;
  const payId = `pay_test_${ts}`;
  const amount = Number(higher.monthlyPrice) * 100; // paise
  const sp = await prisma.subscriptionPayment.create({
    data: {
      restaurantId: rest.id,
      subscriptionId: sub.id,
      planId: higher.id,
      planCode: higher.code,
      planName: higher.name,
      billingCycle: "MONTHLY",
      action: "UPGRADE",
      amount: Number(higher.monthlyPrice),
      status: "CREATED",
      razorpayOrderId: orderId,
      createdBy: 1,
    },
  });
  check(!!sp.id, `SubscriptionPayment CREATED row recorded (id=${sp.id})`);

  // ── 4. POST a valid signed webhook (payment.captured) ──
  const body = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: { id: payId, order_id: orderId, method: "upi", amount },
      },
    },
  });
  const sig = sign(body);
  const res = await fetch(BASE + "/subscriptions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": sig },
    body,
  });
  const json = await res.json().catch(() => ({}));
  check(res.status === 200 && json.success, `Valid signed webhook accepted (${res.status})`);

  // ── 5. Verify activation in the DB ──
  const after = await prisma.subscription.findUnique({ where: { restaurantId: rest.id } });
  check(after.plan === higher.code, `Subscription plan activated → ${after.plan} (was ${beforePlan})`);
  check(after.status === "ACTIVE", "Subscription status ACTIVE after webhook");
  check(after.amount === Number(higher.monthlyPrice), `Subscription amount updated → ${after.amount}`);
  const spAfter = await prisma.subscriptionPayment.findUnique({ where: { id: sp.id } });
  check(spAfter.status === "PAID", "Payment row marked PAID");
  check(spAfter.razorpayPaymentId === payId, "Real gateway payment reference stored");
  check(spAfter.paymentMethod === "upi", "Payment method stored from webhook entity");

  const historyCount = await prisma.subscriptionHistory.count({ where: { restaurantId: rest.id } });
  check(historyCount >= 1, `SubscriptionHistory appended (${historyCount} rows)`);

  // ── 6. Idempotency: replay the same webhook must NOT extend again ──
  const beforeReplay = after.expiryDate;
  const res2 = await fetch(BASE + "/subscriptions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": sig },
    body,
  });
  const json2 = await res2.json().catch(() => ({}));
  check(res2.status === 200 && json2.alreadyPaid === true, `Replayed webhook → alreadyPaid (${res2.status})`);
  const afterReplay = await prisma.subscription.findUnique({ where: { restaurantId: rest.id } });
  check(
    new Date(afterReplay.expiryDate).getTime() === new Date(beforeReplay).getTime(),
    "Replay did NOT extend the expiry again"
  );
  const paidCount = await prisma.subscriptionPayment.count({ where: { id: sp.id, status: "PAID" } });
  check(paidCount === 1, "Exactly one PAID payment row (no duplicate)");

  // ── 6b. Super Admin portal reflects the activation (live DB) ──
  const saList = await api("GET", `/super-admin/subscriptions?search=${encodeURIComponent(rest.name)}`, null, saToken);
  const saSubs = saList.data?.data?.subscriptions || [];
  const saFound = saSubs.find((s) => Number(s.restaurantId) === Number(rest.id));
  check(
    !!saFound && saFound.plan === higher.code && saFound.status === "ACTIVE",
    `SA portal shows new plan after purchase (plan=${saFound?.plan}, status=${saFound?.status})`
  );
  const saHist = await api("GET", `/super-admin/subscriptions/${rest.id}/history`, null, saToken);
  const saHistory = saHist.data?.data || [];
  check(saHistory.length >= 1, `SA plan history shows the change (${saHistory.length} rows)`);
  const saPayments = await api("GET", `/super-admin/subscriptions/${rest.id}/payments`, null, saToken);
  const saPayList = saPayments.data?.data || [];
  const paidRow = saPayList.find((p) => p.id === sp.id);
  check(
    !!paidRow && paidRow.status === "PAID" && paidRow.razorpayPaymentId === payId,
    `SA payment history shows the real gateway record (${paidRow?.status})`
  );

  // ── 7. Tampered webhook (bad signature) rejected with 400 ──
  const badRes = await fetch(BASE + "/subscriptions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": "deadbeef" },
    body,
  });
  check(badRes.status === 400, `Tampered webhook → 400 (${badRes.status})`);

  // ── 8. Renewal webhook math: extends from current expiry ──
  const cur = await prisma.subscription.findUnique({ where: { restaurantId: rest.id } });
  const renewPay = await prisma.subscriptionPayment.create({
    data: {
      restaurantId: rest.id,
      subscriptionId: cur.id,
      planId: higher.id,
      planCode: higher.code,
      planName: higher.name,
      billingCycle: "MONTHLY",
      action: "RENEWAL",
      amount: Number(higher.monthlyPrice),
      status: "CREATED",
      razorpayOrderId: `order_renew_${ts}`,
      createdBy: 1,
    },
  });
  const renewBody = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: `pay_renew_${ts}`, order_id: `order_renew_${ts}`, method: "card", amount } } },
  });
  const renewSig = sign(renewBody);
  const renewRes = await fetch(BASE + "/subscriptions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": renewSig },
    body: renewBody,
  });
  const renewJson = await renewRes.json().catch(() => ({}));
  check(renewRes.status === 200 && renewJson.success, `Renewal webhook accepted (${renewRes.status})`);
  const renewed = await prisma.subscription.findUnique({ where: { restaurantId: rest.id } });
  const expected = new Date(cur.expiryDate);
  expected.setMonth(expected.getMonth() + 1);
  check(
    new Date(renewed.expiryDate).getTime() === expected.getTime(),
    `Renewal extends from current expiry (${renewed.expiryDate.toISOString().slice(0, 10)})`
  );

  // ── 9. SWITCH (lower-priced) purchase activates IMMEDIATELY via webhook ──
  // New business rule: a restaurant choosing a lower-priced plan changes to it
  // right after verified payment — no scheduled downgrade.
  const lowerPlan = await prisma.plan.create({
    data: {
      code: `QA-SWITCH-${ts}`,
      name: `QA Switch ${ts}`,
      description: "Lower-priced QA plan",
      monthlyPrice: 199,
      yearlyPrice: 1990,
      sortOrder: 999,
      isActive: true,
      billingCycle: "MONTHLY",
      maxUsers: 5,
      maxTables: 5,
      maxMenuItems: 50,
      maxOrdersPerMonth: 1000,
    },
  });
  const beforeSwitch = await prisma.subscription.findUnique({ where: { restaurantId: rest.id } });
  const switchPay = await prisma.subscriptionPayment.create({
    data: {
      restaurantId: rest.id,
      subscriptionId: beforeSwitch.id,
      planId: lowerPlan.id,
      planCode: lowerPlan.code,
      planName: lowerPlan.name,
      billingCycle: "MONTHLY",
      action: "SWITCH",
      amount: 199,
      status: "CREATED",
      razorpayOrderId: `order_switch_${ts}`,
      createdBy: 1,
    },
  });
  const switchBody = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: `pay_switch_${ts}`, order_id: `order_switch_${ts}`, method: "upi", amount: 19900 } } },
  });
  const switchSig = sign(switchBody);
  const switchRes = await fetch(BASE + "/subscriptions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": switchSig },
    body: switchBody,
  });
  const switchJson = await switchRes.json().catch(() => ({}));
  check(switchRes.status === 200 && switchJson.success, `SWITCH webhook accepted (${switchRes.status})`);
  const switched = await prisma.subscription.findUnique({ where: { restaurantId: rest.id } });
  check(
    switched.plan === lowerPlan.code && switched.status === "ACTIVE",
    `SWITCH activated immediately → ${switched.plan} (was ${beforeSwitch.plan})`
  );
  check(
    switched.amount === 199 && switched.scheduledPlanId === null,
    `SWITCH amount correct + scheduledPlanId cleared (₹${switched.amount})`
  );
  const switchHist = await prisma.subscriptionHistory.findFirst({
    where: { restaurantId: rest.id, changeType: "SWITCH" },
    orderBy: { id: "desc" },
  });
  check(
    !!switchHist && switchHist.previousPlan === beforeSwitch.plan && switchHist.newPlan === lowerPlan.code,
    `History records ${switchHist?.previousPlan} → ${switchHist?.newPlan} as SWITCH`
  );
  const switchPayRow = await prisma.subscriptionPayment.findUnique({ where: { id: switchPay.id } });
  check(switchPayRow.status === "PAID" && switchPayRow.razorpayPaymentId === `pay_switch_${ts}`, "SWITCH payment row PAID with real reference");
  await prisma.plan.delete({ where: { id: lowerPlan.id } }).catch(() => {});

  // ── Cleanup ──
  const del = await api("DELETE", `/super-admin/restaurants/${rest.id}`, null, saToken);
  check(del.status === 200 || del.status === 204, `Throwaway restaurant cleaned up (${del.status})`);

  console.log(`\n  Webhook activation QA → ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error("Webhook activation QA crashed:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
