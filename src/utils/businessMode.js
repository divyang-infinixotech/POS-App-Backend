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
];

/** Legacy values: valid in the DB for existing records, never offered to new applicants. */
const LEGACY_BUSINESS_TYPES = ["HOTEL"];

/**
 * Mapping: RESTAURANT → Restaurant-mode plans; every other vertical →
 * Basic-mode plans (BASIC_POS — the enum value used by Plan.businessMode).
 */
const BUSINESS_TYPE_TO_MODE = {
  RESTAURANT: "RESTAURANT",
  CAFE: "BASIC_POS",
  BAR: "BASIC_POS",
  FOOD_TRUCK: "BASIC_POS",
  CLOUD_KITCHEN: "BASIC_POS",
  OTHER: "BASIC_POS",
  BAKERY: "BASIC_POS",
  HOTEL: "BASIC_POS", // legacy records keep resolving; new selection is blocked
  FOOD_COURT: "BASIC_POS",
};

/** Plan modes a plan may carry (mirrors the Prisma BusinessMode enum). */
const PLAN_MODES = ["RESTAURANT", "BASIC_POS"];

/**
 * Resolve the plan mode allowed for a business type.
 * Unknown/missing values fall back to BASIC_POS (most restrictive for a
 * Restaurant-type plan is not the concern here — unknown types must never be
 * silently escalated to the full Restaurant mode).
 */
function resolveBusinessMode(businessType) {
  return BUSINESS_TYPE_TO_MODE[businessType] || "BASIC_POS";
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
 */
function assertPlanCompatibleWithBusinessType(businessType, plan, planMode) {
  const mode = planMode || (plan && plan.businessMode);
  const expected = resolveBusinessMode(businessType);
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
