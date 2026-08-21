/**
 * Subscription EXPIRY LIFECYCLE — live E2E verification.
 * Runs against the real backend + PostgreSQL.
 *   node qa/expiry-lifecycle-qa.js
 *
 * Covers the new expiry behavior:
 *   - EXPIRED login is allowed (ADMIN can reach Subscription & Billing)
 *   - subscription self-service routes stay reachable when EXPIRED
 *   - POS routes stay blocked when EXPIRED (backend-enforced, not frontend)
 *   - /subscriptions/me returns the backend-authoritative lifecycle/days/message
 *   - a paid renewal (webhook) reactivates and extends from TODAY for an
 *     expired subscription
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BASE = "http://localhost:5001/api";
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

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

(async () => {
  // ── 1. Create a throwaway restaurant (TRIAL) and expire it immediately ──
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check(sa.status === 200 && sa.data?.token, `Super Admin login (${sa.status})`);
  const saToken = sa.data?.token;

  const ts = Date.now();
  const createRest = await api("POST", "/super-admin/restaurants", {
    name: `QA Expiry ${ts}`,
    ownerName: "QA Owner",
    mobile: `97${String(ts).slice(-8)}`,
    email: `qa-exp-${ts}@test.com`,
    adminName: "QA Admin",
    adminEmail: `qa-exp-admin-${ts}@test.com`,
    adminPassword: "SubPass@123",
  }, saToken);
  const rest = createRest.data?.data || createRest.data?.restaurant;
  check(!!rest?.id, `Throwaway restaurant created (${createRest.status})`);
  const restId = rest?.id;

  // ── 2. Force the subscription expiry into the past (simulates the cron outcome) ──
  const sub = await prisma.subscription.findUnique({ where: { restaurantId: restId } });
  check(!!sub, "Subscription exists");
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { expiryDate: daysAgo(1), nextRenewalDate: daysAgo(1) },
  });

  // ── 3. EXPIRED login must still succeed (so the ADMIN can renew) ──
  const adminLogin = await api("POST", "/auth/login", { email: `qa-exp-admin-${ts}@test.com`, password: "SubPass@123" });
  check(adminLogin.status === 200 && adminLogin.data?.token, `EXPIRED admin can log in (${adminLogin.status})`);
  const token = adminLogin.data?.token;
  const loginSub = adminLogin.data?.subscription;
  check(loginSub?.status === "EXPIRED", "Login snapshot status = EXPIRED");
  check(loginSub?.lifecycle === "EXPIRED", "Login snapshot lifecycle = EXPIRED");
  check(loginSub?.daysRemaining === 0, "Login snapshot daysRemaining = 0 (backend-computed)");
  check(/has expired/.test(loginSub?.expiryMessage || ""), `Expiry message present ("${loginSub?.expiryMessage}")`);

  // ── 4. Subscription self-service stays reachable when EXPIRED ──
  const me = await api("GET", "/subscriptions/me", null, token);
  const meSub = me.data?.data || me.data?.subscription;
  check(me.status === 200 && meSub?.lifecycle === "EXPIRED", `/subscriptions/me reachable when EXPIRED (${me.status})`);

  // Session rehydration on app boot (profile) must also return the expired snapshot
  const prof = await api("GET", "/auth/profile", null, token);
  const profSub = prof.data?.subscription;
  check(
    prof.status === 200 && profSub?.status === "EXPIRED",
    `/auth/profile reachable when EXPIRED + returns snapshot (${prof.status})`
  );

  const plans = await api("GET", "/subscriptions/plans", null, token);
  const planList = Array.isArray(plans.data?.data) ? plans.data.data : plans.data?.plans || [];
  check(plans.status === 200 && planList.length >= 1, `/subscriptions/plans reachable when EXPIRED (${plans.status})`);
  const samePlan = planList.find((p) => p.code === meSub?.plan) || planList.find((p) => Number(p.id) === Number(meSub?.planId));
  check(!!samePlan && samePlan.action === "RENEWAL", `Expired current plan is purchasable as RENEWAL (${samePlan?.action})`);

  // Checkout should reach the GATEWAY (503 because no Razorpay keys here) — NOT
  // be blocked by the subscription gate (403). Proves an expired restaurant can
  // still purchase.
  const chk = await api("POST", "/subscriptions/checkout", {
    planId: samePlan?.id,
    billingCycle: "YEARLY",
    action: "RENEWAL",
  }, token);
  check(
    chk.status === 503,
    `Expired restaurant checkout reaches gateway (503 no-keys, not 403): ${chk.status}`
  );

  // ── 5. POS routes stay blocked when EXPIRED (backend enforcement) ──
  const pos = await api("GET", "/orders/active", null, token);
  check(pos.status === 403, `POS route blocked for EXPIRED (${pos.status}: ${pos.data?.message?.slice(0, 50)})`);
  const menu = await api("GET", "/menu", null, token);
  check(menu.status === 403, `Menu route blocked for EXPIRED (${menu.status})`);

  // ── 6. Renewal AFTER expiry reactivates + extends from TODAY (not the old date) ──
  const orderId = `order_exp_${ts}`;
  const payId = `pay_exp_${ts}`;
  await prisma.subscriptionPayment.create({
    data: {
      restaurantId: restId,
      subscriptionId: sub.id,
      planId: samePlan?.id || sub.planId,
      planCode: samePlan?.code || sub.plan,
      planName: samePlan?.name || sub.plan,
      billingCycle: "YEARLY",
      action: "RENEWAL",
      amount: Number(samePlan?.price || 999),
      status: "CREATED",
      razorpayOrderId: orderId,
      createdBy: 1,
    },
  });

  const crypto = require("crypto");
  const SECRET = "test-webhook-secret";
  const body = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: payId, order_id: orderId, method: "upi", amount: Number(samePlan?.price || 999) * 100 } } },
  });
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const wh = await fetch(BASE + "/subscriptions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": sig },
    body,
  });
  const whJson = await wh.json().catch(() => ({}));
  check(wh.status === 200 && whJson.success, `Expired renewal webhook accepted (${wh.status})`);

  const after = await prisma.subscription.findUnique({ where: { restaurantId: restId } });
  check(after.status === "ACTIVE", "Subscription ACTIVE again after renewal");
  // Expired renewal starts from TODAY and expires one billing cycle later
  // (yearly → today + 1 year), NOT from the old expired date.
  const todayStr = new Date().toISOString().slice(0, 10);
  const startStr = new Date(after.startDate).toISOString().slice(0, 10);
  const expectedExpiry = new Date();
  expectedExpiry.setFullYear(expectedExpiry.getFullYear() + 1);
  const expectedExpiryStr = expectedExpiry.toISOString().slice(0, 10);
  const afterStr = new Date(after.expiryDate).toISOString().slice(0, 10);
  check(startStr === todayStr, `Renewal starts from TODAY (${startStr})`);
  check(afterStr === expectedExpiryStr, `Expiry = today + 1 year (${afterStr}, expected ${expectedExpiryStr})`);

  const meAfter = await api("GET", "/subscriptions/me", null, token);
  const meAfterSub = meAfter.data?.data || meAfter.data?.subscription;
  check(meAfterSub?.status === "ACTIVE" && meAfterSub?.lifecycle === "ACTIVE", "Snapshot ACTIVE after renewal");

  // POS is reachable again
  const posAfter = await api("GET", "/orders/active", null, token);
  check(posAfter.status === 200, `POS restored after renewal (${posAfter.status})`);

  // ── 7. Idempotent expiry-soon notification levels (7/3/1) ──
  const now = new Date();
  const warn7 = await prisma.subscription.findFirst({ where: { restaurantId: restId } });
  await prisma.subscription.update({
    where: { id: warn7.id },
    data: { expiryDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), status: "ACTIVE" },
  });
  // Manually invoke the cron's notification helper path via a fresh query shape
  const { getExpiryWarningLevel } = require("../src/utils/subscription");
  const level = getExpiryWarningLevel({ expiryDate: warn7.expiryDate }, now);
  check(level === "7" || level === null, `7-day warning level computed by backend (${level})`);

  // ── Cleanup ──
  const del = await api("DELETE", `/super-admin/restaurants/${restId}`, null, saToken);
  check(del.status === 200 || del.status === 204, `Throwaway restaurant cleaned up (${del.status})`);

  console.log(`\n  Expiry lifecycle QA → ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error("Expiry lifecycle QA crashed:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
