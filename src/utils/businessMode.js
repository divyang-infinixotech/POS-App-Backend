/**
 * Centralized BusinessType → BusinessMode resolution.
 *
 * Single source of truth for which plan mode a business type is allowed to
 * purchase. Every plan-assignment path (self-serve plan selection, manual
 * application, Super Admin restaurant creation, subscription plan change and
 * final approval provisioning) MUST derive the mode through resolveBusinessMode()
 * and verify the plan through assertPlanCompatibleWithBusinessType().
 *
 * Concepts kept strictly separate (do not merge them):
 *   businessType  — WHAT the business is (RESTAURANT, CAFE, BAR, …)
 *   businessMode  — WHICH plan/POS experience it may buy (RESTAURANT, BASIC_POS)
 *   plan          — a Plan row whose businessMode must match the resolved mode
 *
 * The client may supply businessType, but NEVER the effective mode: the mode is
 * always derived server-side from the stored/validated business type.
 */

/**
 * Business types OFFERED to new applicants (order = UI order).
 * HOTEL is excluded from new selection (spec §14) — but kept in the mode map
 * and normalization only where legacy data must stay readable.
 * Retail verticals were added additively — existing stored values keep working
 * unchanged.
 */
const BUSINESS_TYPES = [
  "RESTAURANT",
  "CAFE",
  "BAR",
  "FOOD_TRUCK",
  "CLOUD_KITCHEN",
  "OTHER",
  // Additional supported verticals (existing schema values kept working).
  "BAKERY",
  "FOOD_COURT",
  // Retail verticals (additive, never replacing existing values).
  "SUPERMARKET",
  "GROCERY",
  "CLOTHING",
  "ELECTRONICS",
  "FURNITURE",
  "HARDWARE",
  "COSMETICS",
  "STATIONERY",
  "JEWELLERY",
];

/** Legacy values: valid in the DB for existing records, never offered to new applicants. */
const LEGACY_BUSINESS_TYPES = ["HOTEL"];

/**
 * Mapping: business type → plan mode (the ONE authoritative table).
 *   RESTAURANT / FOOD_COURT            → RESTAURANT (full restaurant ops)
 *   CAFE / BAR / BAKERY / FOOD_TRUCK /
 *   CLOUD_KITCHEN                      → BASIC_POS (food quick-billing)
 *   every retail vertical + OTHER      → QUICK_BILLING (retail quick-billing)
 *
 * Business type and plan mode remain SEPARATE concepts: businessType belongs
 * to the tenant, businessMode to the subscription plan. Adding a type here
 * without a mode entry falls through to QUICK_BILLING (most restrictive —
 * unknown types are never escalated to the full Restaurant mode).
 *
 * NOTE: legacy tenants stored as OTHER with a live RESTAURANT plan keep
 * working — the plan-compatibility gate (assertPlanCompatibleWithBusinessType)
 * is enforced at ASSIGNMENT time only; existing subscriptions are never
 * retroactively invalidated (spec §19/§23).
 */
const BUSINESS_TYPE_TO_MODE = {
  RESTAURANT: "RESTAURANT",
  CAFE: "BASIC_POS",
  BAR: "BASIC_POS",
  FOOD_TRUCK: "BASIC_POS",
  CLOUD_KITCHEN: "BASIC_POS",
  BAKERY: "BASIC_POS",
  FOOD_COURT: "RESTAURANT",
  // Legacy records keep resolving; new selection is blocked for HOTEL.
  HOTEL: "QUICK_BILLING",
  OTHER: "QUICK_BILLING",
  // Retail verticals → Quick Billing (products/barcode/inventory billing).
  SUPERMARKET: "QUICK_BILLING",
  GROCERY: "QUICK_BILLING",
  CLOTHING: "QUICK_BILLING",
  ELECTRONICS: "QUICK_BILLING",
  FURNITURE: "QUICK_BILLING",
  HARDWARE: "QUICK_BILLING",
  COSMETICS: "QUICK_BILLING",
  STATIONERY: "QUICK_BILLING",
  JEWELLERY: "QUICK_BILLING",
};

/** Plan modes a plan may carry (mirrors the Prisma BusinessMode enum). */
const PLAN_MODES = ["RESTAURANT", "BASIC_POS", "QUICK_BILLING"];

/**
 * Resolve the plan mode allowed for a business type.
 * Unknown/missing values fall back to QUICK_BILLING (most restrictive for a
 * Restaurant-type plan is not the concern here — unknown types must never be
 * silently escalated to the full Restaurant mode).
 */
function resolveBusinessMode(businessType) {
  return BUSINESS_TYPE_TO_MODE[businessType] || "QUICK_BILLING";
}

/**
 * Validate a client-supplied businessType. Returns the normalized value or
 * null when the value is not a known business type (callers decide whether to
 * reject or fall back).
 */
function normalizeBusinessType(value) {
  if (!value || typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  // HOTEL (and other legacy values) normalize successfully so existing records
  // keep working, but they are NOT in BUSINESS_TYPES → onboarding validators
  // reject them for NEW applications.
  if (LEGACY_BUSINESS_TYPES.indexOf(v) !== -1) return v;
  return BUSINESS_TYPES.indexOf(v) !== -1 ? v : null;
}

/**
 * Enforce plan ↔ business-type compatibility.
 * Throws a 400 with the spec'd message when the plan's mode does not match
 * the mode resolved from the business type.
 *
 * LEGACY SAME-PLAN EXCEPTION (backward compatibility, spec §11/§23): a
 * tenant that ALREADY holds a subscription on this exact plan keeps it even
 * when the mapping above has since changed. Example: tenants created as
 * OTHER/SUPERMARKET with a BASIC_POS plan before QUICK_BILLING existed must
 * keep renewing that same plan — only SWITCHING to a different plan is gated
 * by the resolved mode. Renewals/plan-changes to the SAME plan always pass.
 */
function assertPlanCompatibleWithBusinessType(businessType, plan, planMode, opts) {
  const mode = planMode || (plan && plan.businessMode);
  // Same-plan continuation (renewal / no-op change) is always allowed.
  if (opts && opts.isRenewal === true) return;
  const expected = resolveBusinessMode(businessType);
  if (mode && mode === expected) return;
  // Same-planId exception: the tenant's CURRENT subscription is on this very
  // plan — keep serving it regardless of any mapping drift since assignment.
  // Callers pass the flag via opts (isCurrentPlan); passing it directly on
  // the plan object is also supported.
  if ((opts && opts.isCurrentPlan === true) || (plan && plan.isCurrentPlan === true)) return;
  if (!mode || mode !== expected) {
    const err = new Error("Selected plan is not available for the selected business type.");
    err.statusCode = 400;
    throw err;
  }
}

module.exports = {
  BUSINESS_TYPES,
  LEGACY_BUSINESS_TYPES,
  BUSINESS_TYPE_TO_MODE,
  PLAN_MODES,
  resolveBusinessMode,
  normalizeBusinessType,
  assertPlanCompatibleWithBusinessType,
};
