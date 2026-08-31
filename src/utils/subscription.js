/**
 * Subscription helpers — fully database-driven.
 * Plan definitions live in the `Plan` table; nothing here is hardcoded.
 */
const prisma = require("../config/prisma");
const { DEFAULT_FEATURES } = require("../config/subscription.config");

const BILLING_CYCLES = ["MONTHLY", "YEARLY", "ONCE"];

/** Add `days` days to a date */
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Compute expiry date from a billing cycle, anchored at `startDate` */
function computeExpiryDate(startDate, billingCycle) {
  const d = new Date(startDate);
  switch (billingCycle) {
    case "YEARLY":
      d.setFullYear(d.getFullYear() + 1);
      break;
    case "ONCE":
      d.setFullYear(d.getFullYear() + 1);
      break;
    case "MONTHLY":
    default:
      d.setMonth(d.getMonth() + 1);
  }
  return d;
}

/**
 * Build the subscription snapshot from a Plan row + billing cycle.
 * Returns the fields stored on Subscription (limits, features, amount, cycle).
 */
function planToSnapshot(plan, billingCycle) {
  const cycle = billingCycle && BILLING_CYCLES.includes(billingCycle) ? billingCycle : plan.billingCycle || "MONTHLY";
  const amount = cycle === "YEARLY" ? Number(plan.yearlyPrice || 0) : Number(plan.monthlyPrice || 0);
  return {
    planId: plan.id,
    plan: plan.code,
    businessMode: plan.businessMode || "RESTAURANT",
    billingCycle: cycle,
    amount,
    autoRenew: plan.code !== "TRIAL" && cycle !== "ONCE",
    maxUsers: plan.maxUsers ?? null,
    maxTables: plan.maxTables ?? null,
    maxFloors: plan.maxFloors ?? null,
    maxMenuItems: plan.maxMenuItems ?? null,
    maxPrinters: plan.maxPrinters ?? null,
    maxBranches: plan.maxBranches ?? null,
    maxOrdersPerMonth: plan.maxOrdersPerMonth ?? null,
    storageLimitMB: plan.storageLimitMB ?? null,
    features: Array.isArray(plan.features) ? plan.features : DEFAULT_FEATURES,
  };
}

/**
 * Compute start/expiry for a (plan, cycle) assignment.
 * Trial plans use the plan's trialDays; paid plans use the billing cycle.
 */
function computeDates(plan, billingCycle, effectiveDate) {
  const startDate = effectiveDate ? new Date(effectiveDate) : new Date();
  const expiryDate =
    plan.code === "TRIAL" && Number(plan.trialDays) > 0
      ? addDays(startDate, Number(plan.trialDays))
      : computeExpiryDate(startDate, billingCycle || plan.billingCycle || "MONTHLY");
  return { startDate, expiryDate };
}

/**
 * Load a restaurant's current subscription with an auto-expiry check.
 * Returns a normalized snapshot consumed by auth, middleware and the frontend.
 */
async function getRestaurantSubscription(restaurantId) {
  const sub = await prisma.subscription.findUnique({
    where: { restaurantId: Number(restaurantId) },
    include: {
      planDef: { select: { id: true, code: true, name: true } },
      scheduledPlan: { select: { id: true, code: true, name: true } },
    },
  });
  if (!sub) return null;

  const features = Array.isArray(sub.features) ? sub.features : DEFAULT_FEATURES;
  // Backend-authoritative lifecycle (days computed from the real expiry date)
  const lc = computeLifecycle(sub, sub.planDef ? sub.planDef.name : null);
  const status = lc.status;
  const daysRemaining = lc.daysRemaining;

  return {
    id: sub.id,
    restaurantId: sub.restaurantId,
    plan: sub.plan,
    planId: sub.planId,
    planName: sub.planDef ? sub.planDef.name : sub.plan,
    businessMode: sub.businessMode || "RESTAURANT",
    status,
    lifecycle: lc.lifecycle,
    expiryMessage: lc.expiryMessage,
    startDate: sub.startDate,
    expiryDate: sub.expiryDate,
    nextRenewalDate: sub.nextRenewalDate,
    billingCycle: sub.billingCycle || "MONTHLY",
    autoRenew: sub.autoRenew,
    amount: sub.amount,
    scheduledPlanId: sub.scheduledPlanId,
    scheduledPlan: sub.scheduledPlan
      ? { id: sub.scheduledPlan.id, code: sub.scheduledPlan.code, name: sub.scheduledPlan.name }
      : null,
    limits: {
      maxUsers: sub.maxUsers,
      maxTables: sub.maxTables,
      maxFloors: sub.maxFloors,
      maxMenuItems: sub.maxMenuItems,
      maxPrinters: sub.maxPrinters,
      maxBranches: sub.maxBranches,
      maxOrdersPerMonth: sub.maxOrdersPerMonth,
      storageLimitMB: sub.storageLimitMB,
    },
    features,
    daysRemaining,
  };
}

/** True if the subscription state allows restaurant staff to use the POS */
function isSubscriptionUsable(subscription) {
  if (!subscription) return false;
  if (subscription.status === "EXPIRED" || subscription.status === "CANCELLED" || subscription.status === "SUSPENDED") {
    return false;
  }
  return true;
}

/**
 * One consistent subscription lifecycle model (backend-authoritative).
 *
 * States:
 *   ACTIVE         — usable, more than 7 days until expiry (or no expiry)
 *   EXPIRING_SOON  — usable, 7 days or fewer until expiry
 *   EXPIRED        — expiry date has passed (or stored status is EXPIRED/
 *                    CANCELLED/SUSPENDED)
 *
 * The stored `Subscription.status` enum is untouched — this is a derived view
 * computed from the REAL expiry date, never from client-calculated values.
 * `daysRemaining` uses Math.ceil so the exact number matches the frontend
 * warning copy (e.g. 7 days left, 3 days left, tomorrow, expired).
 */
function computeLifecycle(subscription, planName) {
  const now = new Date();
  const storedStatus = (subscription && subscription.status) || "ACTIVE";
  let status = storedStatus;

  // Logical expiry: an ACTIVE/TRIAL row whose date has passed is EXPIRED now,
  // even before the cron persists it.
  const expiry = subscription && subscription.expiryDate ? new Date(subscription.expiryDate) : null;
  if ((status === "ACTIVE" || status === "TRIAL") && expiry && expiry < now) {
    status = "EXPIRED";
  }

  const permanentlyBlocked = status === "EXPIRED" || status === "CANCELLED" || status === "SUSPENDED";
  const daysRemaining = expiry
    ? Math.max(0, Math.ceil((expiry - now) / 86400000))
    : null;

  let lifecycle;
  if (permanentlyBlocked) lifecycle = "EXPIRED";
  else if (daysRemaining !== null && daysRemaining <= 7) lifecycle = "EXPIRING_SOON";
  else lifecycle = "ACTIVE";

  // Warning copy — the exact number always comes from the backend.
  const plan = planName || (subscription && (subscription.planName || subscription.plan)) || "Your plan";
  let expiryMessage = null;
  if (status === "EXPIRED") {
    expiryMessage = `Your ${plan} plan has expired.`;
  } else if (daysRemaining !== null && daysRemaining <= 7) {
    expiryMessage = daysRemaining === 0
      ? `Your ${plan} plan expires today.`
      : daysRemaining === 1
        ? `Your ${plan} plan expires tomorrow.`
        : `Your ${plan} plan expires in ${daysRemaining} days.`;
  }

  return { status, lifecycle, daysRemaining, expiryMessage };
}

/**
 * Expiry warning level for cron notifications.
 * Returns "7" | "3" | "1" | "0" (expired) or null when no warning applies.
 * "0" is returned for an already-passed expiry so callers can route it to the
 * EXPIRED branch instead of a future-countdown branch.
 */
function getExpiryWarningLevel(subscription, now) {
  const ref = now || new Date();
  if (!subscription || !subscription.expiryDate) return null;
  const diff = Math.ceil((new Date(subscription.expiryDate) - ref) / 86400000);
  if (diff <= 0) return "0";
  if (diff === 1) return "1";
  if (diff <= 3) return "3";
  if (diff <= 7) return "7";
  return null;
}

/** Price for a billing cycle (INR) — never trusts a stored amount. */
function planPrice(plan, cycle) {
  const c = cycle === "YEARLY" ? "YEARLY" : "MONTHLY";
  return c === "YEARLY" ? Number(plan.yearlyPrice || 0) : Number(plan.monthlyPrice || 0);
}

/**
 * Backend-authoritative purchase action for selecting `plan` given the current
 * subscription. Same-cycle price comparison — the client never decides
 * UPGRADE/RENEWAL/SWITCH itself.
 *   same plan                 → RENEWAL
 *   different, higher price   → UPGRADE
 *   different, equal/lower    → SWITCH  (never DOWNGRADE)
 */
function classifyAction(subscription, currentPlan, plan, cycle) {
  if (!subscription || !plan) return "RENEWAL";
  if (Number(plan.id) === Number(subscription.planId)) return "RENEWAL";
  const newPrice = planPrice(plan, cycle);
  const currentPrice = currentPlan ? planPrice(currentPlan, cycle) : Number(subscription.amount || 0);
  return newPrice > currentPrice ? "UPGRADE" : "SWITCH";
}

/**
 * Purchase availability rule (backend-authoritative) — YEARLY ONLY billing.
 *   RENEWAL = Yearly only
 *   UPGRADE = Yearly only
 *   SWITCH / CHANGE PLAN = Yearly only
 * Monthly is no longer offered anywhere in the restaurant purchase flow. The
 * client can never bypass into a monthly purchase — this gate is applied in
 * GET /subscriptions/plans (returns yearly pricing/actions) AND in
 * POST /subscriptions/checkout (rejects MONTHLY with a clean 400 before any
 * gateway work). Activation itself is untouched: payment rows can only be
 * created through checkout, which already enforces the rule.
 */
function isActionAvailableForCycle(action, billingCycle) {
  const cycle = billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY";
  if (action === "SWITCH" && cycle !== "YEARLY") return false;
  return true;
}

/**
 * Yearly-only billing gate. Returns the canonical 400 error message when the
 * requested cycle is not YEARLY (including explicit MONTHLY); returns null
 * when YEARLY or omitted (defaults to YEARLY). Kept as a pure function so the
 * rule is unit-testable and the controller stays a one-liner.
 */
function yearlyBillingError(billingCycle) {
  const c = String(billingCycle || "YEARLY").toUpperCase();
  return c === "YEARLY" ? null : "Only yearly subscription billing is available.";
}

module.exports = {
  BILLING_CYCLES,
  addDays,
  computeExpiryDate,
  planToSnapshot,
  computeDates,
  getRestaurantSubscription,
  isSubscriptionUsable,
  computeLifecycle,
  getExpiryWarningLevel,
  planPrice,
  classifyAction,
  isActionAvailableForCycle,
  yearlyBillingError,
};
