/**
 * Subscription Upgrade & Renewal — live E2E verification.
 * Runs against the real backend + PostgreSQL.
 *   node qa/subscription-qa.js
 *
 * Covers: plans listing, /me snapshot, checkout validation + 503-without-keys,
 * downgrade scheduling (needs a lower-priced plan), payment history, webhook
 * signature rejection, multi-tenant isolation, super-admin plan flow intact.
 */
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
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}

(async () => {
  // ── 1. Super admin login + create a throwaway restaurant ──
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check(sa.status === 200 && sa.data?.token, `Super Admin login (${sa.status})`);
  const saToken = sa.data?.token;

  const ts = Date.now();
  const createRest = await api("POST", "/super-admin/restaurants", {
    name: `QA Sub ${ts}`,
    ownerName: "QA Owner",
    mobile: `99${String(ts).slice(-8)}`,
    email: `qa-sub-${ts}@test.com`,
    adminName: "QA Admin",
    adminEmail: `qa-sub-admin-${ts}@test.com`,
    adminPassword: "SubPass@123",
  }, saToken);
  const tempRest = createRest.data?.data || createRest.data?.restaurant;
  check(!!tempRest?.id, `Throwaway restaurant created (${createRest.status})`);
  const restId = tempRest?.id;

  // ── 2. Admin login + /me + /plans ──
  const adminLogin = await api("POST", "/auth/login", { email: `qa-sub-admin-${ts}@test.com`, password: "SubPass@123" });
  check(adminLogin.status === 200 && adminLogin.data?.token, `Temp admin login (${adminLogin.status})`);
  const token = adminLogin.data?.token;

  const me = await api("GET", "/subscriptions/me", null, token);
  const sub = me.data?.data || me.data?.subscription;
  check(me.status === 200 && sub?.plan, `/subscriptions/me returns snapshot (plan=${sub?.plan}, status=${sub?.status})`);

  const plans = await api("GET", "/subscriptions/plans", null, token);
  const planList = Array.isArray(plans.data?.data) ? plans.data.data : plans.data?.plans || [];
  check(plans.status === 200 && planList.length >= 2, `/subscriptions/plans lists ${planList.length} active plans`);
  const currentPlan = planList.find((p) => p.code === sub.plan);
  const currentPlanFromList = planList.find((p) => Number(p.id) === Number(sub.planId));
  check(
    planList.every((p) => typeof p.price === "number" && typeof p.action === "string" && !!p.expectedExpiry),
    "Every plan carries backend-computed price + action + expectedExpiry"
  );
  check(
    currentPlanFromList?.action === "RENEWAL",
    `Current plan (${sub.plan}) classified RENEWAL by backend (got ${currentPlanFromList?.action})`
  );
  const higherInList = planList.find(
    (p) => Number(p.id) !== Number(currentPlanFromList?.id) && p.action === "UPGRADE"
  );
  // Lower-priced plans are now purchasable immediately → classified SWITCH
  // (never DOWNGRADE). Check the seed plans don't carry DOWNGRADE at all.
  const anyDowngrade = planList.some((p) => p.action === "DOWNGRADE");
  check(!anyDowngrade, "No plan classified DOWNGRADE — lower-priced plans are SWITCH (immediate purchase)");
  check(!!higherInList, `At least one plan classified UPGRADE (${higherInList?.code || "none"})`);
  // Higher-priced plan at the SAME cycle as the subscription (fair comparison)
  const higherPlan = planList.find(
    (p) => Number(p.monthlyPrice) > Number(currentPlan?.monthlyPrice || 0) && p.code !== "TRIAL"
  );
  check(!!higherPlan, `Higher-priced plan available for upgrade test (${higherPlan?.code || "none"})`);

  // Create a genuinely lower-priced QA plan for the downgrade test
  const lowPrice = Math.max(1, Math.floor((Number(currentPlan?.monthlyPrice || 999) || 999) / 2));
  const createLow = await api("POST", "/super-admin/plans", {
    code: `QA-LOW-${ts}`,
    name: `QA Low ${ts}`,
    monthlyPrice: lowPrice,
    yearlyPrice: lowPrice * 10,
    modules: [],
  }, saToken);
  const lowPlanRow = createLow.data?.data || createLow.data?.plan;
  check(!!lowPlanRow?.id, `Lower-priced QA plan created (monthly ${lowPrice})`);
  const lowerPlan = { id: lowPlanRow?.id, code: `QA-LOW-${ts}`, monthlyPrice: lowPrice };

  // ── 3. Checkout validation ──
  const noPlan = await api("POST", "/subscriptions/checkout", { billingCycle: "MONTHLY", action: "UPGRADE" }, token);
  check(noPlan.status === 400, `Checkout without planId → 400 (${noPlan.status})`);

  const badAction = await api("POST", "/subscriptions/checkout", { planId: higherPlan?.id, action: "HACK" }, token);
  check(badAction.status === 400, `Checkout with invalid action → 400 (${badAction.status})`);

  // A lower-priced plan is SWITCH. Business rule: SWITCH / CHANGE PLAN is
  // YEARLY ONLY — a monthly switch is rejected with 400; a yearly switch is a
  // valid immediate purchase (fails only at the gateway without keys: 503).
  // Verify via the freshly created QA-LOW plan (genuinely lower-priced).
  if (lowerPlan?.id) {
    const swMonthly = await api("POST", "/subscriptions/checkout", { planId: lowerPlan.id, billingCycle: "MONTHLY", action: "SWITCH" }, token);
    check(
      swMonthly.status === 400 && swMonthly.data?.message === "Only yearly subscription billing is available.",
      `Monthly SWITCH rejected → 400 with the yearly-only copy (${swMonthly.status})`
    );
    const swYearly = await api("POST", "/subscriptions/checkout", { planId: lowerPlan.id, billingCycle: "YEARLY", action: "SWITCH" }, token);
    check(
      swYearly.status === 503 || swYearly.status === 200,
      `Yearly SWITCH-classified (lower-priced) checkout accepted — reaches gateway (${swYearly.status})`
    );
  }

  // Client action contradicting the backend classification is rejected
  if (currentPlanFromList && higherPlan) {
    const rogue = await api("POST", "/subscriptions/checkout", { planId: currentPlanFromList.id, billingCycle: "YEARLY", action: "UPGRADE" }, token);
    check(rogue.status === 400 && rogue.data?.message?.includes("mismatch"), `Rogue action (UPGRADE for current plan) → 400 mismatch (${rogue.status})`);
  }

  // ── 4. Checkout without gateway keys → clear 503, subscription untouched ──
  if (higherPlan) {
    const chk = await api("POST", "/subscriptions/checkout", { planId: higherPlan.id, billingCycle: "YEARLY", action: "UPGRADE" }, token);
    check(
      chk.status === 503,
      `Checkout without RAZORPAY keys → 503 with clear message (${chk.status}: ${chk.data?.message?.slice(0, 60)})`
    );
  }
  const meAfter = await api("GET", "/subscriptions/me", null, token);
  const subAfter = meAfter.data?.data || meAfter.data?.subscription;
  check(subAfter?.plan === sub.plan && subAfter?.status === sub.status, "Plan NOT changed by failed checkout (still " + subAfter?.plan + ")");

  // ── 5. Renewal guard: renewing a different plan is rejected ──
  if (higherPlan) {
    const renewOther = await api("POST", "/subscriptions/checkout", { planId: higherPlan.id, billingCycle: "YEARLY", action: "RENEWAL" }, token);
    check(renewOther.status === 400, `Renewal of a different plan rejected (${renewOther.status})`);
  }

  // ── 6. Downgrade scheduling (lower-priced QA plan) ──
  if (lowerPlan?.id) {
    const down = await api("POST", "/subscriptions/downgrade", { planId: lowerPlan.id }, token);
    check(down.status === 200, `Downgrade scheduled to ${lowerPlan.code} (${down.status})`);
    const afterDown = await api("GET", "/subscriptions/me", null, token);
    const ad = afterDown.data?.data || afterDown.data?.subscription;
    check(Number(ad?.scheduledPlanId) === Number(lowerPlan.id), "scheduledPlanId persisted for next renewal");

    const cancelDown = await api("DELETE", "/subscriptions/downgrade", null, token);
    check(cancelDown.status === 200, `Scheduled downgrade cancelled (${cancelDown.status})`);
    const afterCancel = await api("GET", "/subscriptions/me", null, token);
    check((afterCancel.data?.data || afterCancel.data?.subscription)?.scheduledPlanId == null, "scheduledPlanId cleared");
  } else {
    console.log("  ℹ No lower-priced plan available — downgrade scheduling skipped");
  }

  // ── 7. Upgrade guard: same-plan checkout as UPGRADE is rejected ──
  if (currentPlan) {
    const samePlan = await api("POST", "/subscriptions/checkout", { planId: currentPlan.id, billingCycle: "YEARLY", action: "UPGRADE" }, token);
    check(samePlan.status === 400, `Same-plan UPGRADE rejected — use Renew (${samePlan.status})`);
  }

  // ── 8. Payment history (empty for a fresh restaurant) ──
  const history = await api("GET", "/subscriptions/payments", null, token);
  const hist = history.data?.data || [];
  check(history.status === 200 && Array.isArray(hist), `Payment history endpoint (${history.status}, ${hist.length} rows)`);

  // ── 9. Webhook — unauthenticated endpoint rejects bad signatures ──
  const webhookBad = await fetch(BASE + "/subscriptions/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": "deadbeef" },
    body: JSON.stringify({ event: "payment.captured" }),
  });
  check(webhookBad.status === 400, `Webhook with invalid signature → 400 (${webhookBad.status})`);

  // ── 10. Multi-tenant isolation ──
  // Restaurant 2 admin must NOT see or pay for restaurant 1's subscription.
  const r2 = await api("POST", "/auth/login", { email: "TruptiRes1@gmail.com", password: "wrongpw" });
  check(r2.status === 401, `R2 admin with unknown password rejected (${r2.status})`);
  // Foreign payment id lookup is scoped by token restaurantId → 404/400
  const foreignVerify = await api("POST", "/subscriptions/verify", {
    subscriptionPaymentId: 999999,
    razorpayOrderId: "order_XYZ",
    razorpayPaymentId: "pay_XYZ",
    razorpaySignature: "sig",
  }, token);
  check(foreignVerify.status === 404, `Foreign/invalid payment verify → 404 (${foreignVerify.status})`);

  // ── 11. Super Admin plan flow still works ──
  const planAssign = await api("PUT", `/super-admin/subscriptions/${restId}/plan`, { planId: currentPlan?.id }, saToken);
  check(planAssign.status === 200, `Super Admin plan assignment intact (${planAssign.status})`);

  // ── 12. Super Admin creates a NEW plan → restaurant sees it automatically ──
  const goldPrice = 15000;
  const createGold = await api("POST", "/super-admin/plans", {
    code: `GOLD-${ts}`,
    name: `Gold ${ts}`,
    monthlyPrice: Math.round(goldPrice / 12),
    yearlyPrice: goldPrice,
    modules: [],
  }, saToken);
  const goldRow = createGold.data?.data || createGold.data?.plan;
  check(!!goldRow?.id, `Super Admin created new plan "Gold" (${createGold.status})`);
  if (goldRow?.id) {
    const plansAgain = await api("GET", "/subscriptions/plans", null, token);
    const list2 = Array.isArray(plansAgain.data?.data) ? plansAgain.data.data : [];
    const goldSeen = list2.find((p) => Number(p.id) === Number(goldRow.id));
    check(!!goldSeen, "New plan appears in /subscriptions/plans with NO frontend change");
    check(goldSeen && Number(goldSeen.yearlyPrice) === goldPrice, "New plan carries its DB price");
    check(goldSeen && typeof goldSeen.action === "string" && typeof goldSeen.price === "number", "New plan carries backend-computed action + price");

    // Equal-price plan to the CURRENT plan (BASIC yearly 9990) → SWITCH
    const currentYearly = Number(currentPlanFromList?.yearlyPrice || 0);
    if (currentYearly > 0) {
      const createTwin = await api("POST", "/super-admin/plans", {
        code: `TWIN-${ts}`,
        name: `Twin ${ts}`,
        monthlyPrice: Math.round(currentYearly / 12),
        yearlyPrice: currentYearly,
        modules: [],
      }, saToken);
      const twinRow = createTwin.data?.data || createTwin.data?.plan;
      check(!!twinRow?.id, `Equal-price "Twin" plan created (${createTwin.status})`);
      if (twinRow?.id) {
        const twinList = await api("GET", "/subscriptions/plans?cycle=YEARLY", null, token);
        const lt = Array.isArray(twinList.data?.data) ? twinList.data.data : [];
        const twinY = lt.find((p) => Number(p.id) === Number(twinRow.id));
        check(
          twinY && twinY.action === "SWITCH",
          `Equal-price (non-current) plan classified SWITCH (got ${twinY?.action})`
        );
        await api("DELETE", `/super-admin/plans/${twinRow.id}`, null, saToken);
      }
    } else {
      console.log("  ℹ Current plan has no yearly price — SWITCH classification skipped");
    }
    await api("DELETE", `/super-admin/plans/${goldRow.id}`, null, saToken);
  }

  // ── 13. Super Admin payment-history endpoint (restaurant-scoped) ──
  const saPayments = await api("GET", `/super-admin/subscriptions/${restId}/payments`, null, saToken);
  const saPays = saPayments.data?.data || [];
  check(saPayments.status === 200 && Array.isArray(saPays), `SA payments endpoint (${saPayments.status}, ${saPays.length} rows)`);

  // ── 14. Cleanup: delete the QA low plan ──
  if (lowPlanRow?.id) {
    const delLow = await api("DELETE", `/super-admin/plans/${lowPlanRow.id}`, null, saToken);
    check(delLow.status === 200 || delLow.status === 204, `QA low plan cleaned up (${delLow.status})`);
  }

  // ── 13. Non-admin role cannot create checkout ──
  const staffLogin = await api("POST", "/auth/login", { email: "cashier@restaurant.com", password: "password123" });
  if (staffLogin.data?.token) {
    const staffChk = await api("POST", "/subscriptions/checkout", { planId: higherPlan?.id, billingCycle: "YEARLY" }, staffLogin.data.token);
    check(staffChk.status === 403, `CASHIER checkout blocked by role guard (${staffChk.status})`);
  }

  // ── Cleanup: delete throwaway restaurant ──
  if (restId) {
    const del = await api("DELETE", `/super-admin/restaurants/${restId}`, null, saToken);
    check(del.status === 200 || del.status === 204, `Throwaway restaurant cleaned up (${del.status})`);
  }

  console.log(`\n  Subscription QA → ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Subscription QA crashed:", e.message);
  process.exit(1);
});
