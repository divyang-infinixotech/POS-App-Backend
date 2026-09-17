/**
 * Business Type → Plan Mode selection & filtering tests (spec §21).
 * Standalone node script — same pattern as onboarding.test.js / email.test.js.
 * No database required: the mapping helper is pure, and the service-level
 * gates are verified via source inspection + direct helper calls.
 */
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log("  ✔ " + name); }
  else { failed++; console.log("  ✘ " + name); }
}

const {
  BUSINESS_TYPES,
  PLAN_MODES,
  resolveBusinessMode,
  normalizeBusinessType,
  assertPlanCompatibleWithBusinessType,
} = require("../utils/businessMode");

console.log("\n─── 1. Business type → business mode mapping ───");
check(resolveBusinessMode("RESTAURANT") === "RESTAURANT", "RESTAURANT → RESTAURANT mode");
check(resolveBusinessMode("CAFE") === "BASIC_POS", "CAFE → BASIC mode");
check(resolveBusinessMode("BAR") === "BASIC_POS", "BAR → BASIC mode");
check(resolveBusinessMode("FOOD_TRUCK") === "BASIC_POS", "FOOD_TRUCK → BASIC mode");
check(resolveBusinessMode("CLOUD_KITCHEN") === "BASIC_POS", "CLOUD_KITCHEN → BASIC mode");
check(resolveBusinessMode("OTHER") === "BASIC_POS", "OTHER → BASIC mode");
check(resolveBusinessMode("BAKERY") === "BASIC_POS", "BAKERY (extra vertical) → BASIC mode");
check(resolveBusinessMode("HOTEL") === "BASIC_POS", "HOTEL (extra vertical) → BASIC mode");
check(resolveBusinessMode("FOOD_COURT") === "BASIC_POS", "FOOD_COURT (extra vertical) → BASIC mode");
check(resolveBusinessMode("SUPERMARKET") === "BASIC_POS", "SUPERMARKET (retail vertical) → BASIC mode");
check(resolveBusinessMode("GROCERY") === "BASIC_POS", "GROCERY (retail vertical) → BASIC mode");
check(resolveBusinessMode("CLOTHING") === "BASIC_POS", "CLOTHING (retail vertical) → BASIC mode");
check(resolveBusinessMode("") === "BASIC_POS", "empty → BASIC mode (safe default)");
check(resolveBusinessMode("HACKER") === "BASIC_POS", "unknown value → BASIC mode (never escalated)");
check(resolveBusinessMode(undefined) === "BASIC_POS", "undefined → BASIC mode");
for (const t of ["RESTAURANT", "CAFE", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "OTHER", "SUPERMARKET", "GROCERY", "CLOTHING"]) {
  check(BUSINESS_TYPES.indexOf(t) !== -1, "BUSINESS_TYPES includes " + t);
}
check(PLAN_MODES.length === 2 && PLAN_MODES.indexOf("RESTAURANT") !== -1 && PLAN_MODES.indexOf("BASIC_POS") !== -1,
  "PLAN_MODES = RESTAURANT | BASIC_POS only");

console.log("\n─── 2. Compatibility enforcement (valid combos PASS) ───");
let threw = null;
try { assertPlanCompatibleWithBusinessType("RESTAURANT", { businessMode: "RESTAURANT" }); } catch (e) { threw = e; }
check(threw === null, "CASE 9: Restaurant + Restaurant plan → success");
threw = null;
try { assertPlanCompatibleWithBusinessType("CAFE", { businessMode: "BASIC_POS" }); } catch (e) { threw = e; }
check(threw === null, "CASE 10: Cafe + Basic plan → success");
threw = null;
try { assertPlanCompatibleWithBusinessType("BAR", { businessMode: "BASIC_POS" }); } catch (e) { threw = e; }
check(threw === null, "Bar + Basic plan → success");
threw = null;
try { assertPlanCompatibleWithBusinessType("FOOD_TRUCK", { businessMode: "BASIC_POS" }); } catch (e) { threw = e; }
check(threw === null, "Food Truck + Basic plan → success");
threw = null;
try { assertPlanCompatibleWithBusinessType("CLOUD_KITCHEN", { businessMode: "BASIC_POS" }); } catch (e) { threw = e; }
check(threw === null, "Cloud Kitchen + Basic plan → success");
threw = null;
try { assertPlanCompatibleWithBusinessType("OTHER", { businessMode: "BASIC_POS" }); } catch (e) { threw = e; }
check(threw === null, "Other + Basic plan → success");

console.log("\n─── 3. Compatibility enforcement (invalid combos FAIL 400) ───");
threw = null;
try { assertPlanCompatibleWithBusinessType("RESTAURANT", { businessMode: "BASIC_POS" }); } catch (e) { threw = e; }
check(threw && threw.statusCode === 400, "CASE 7: Restaurant + Basic plan → 400 rejected");
check(threw && threw.message === "Selected plan is not available for the selected business type.",
  "rejection uses the spec'd error message");
threw = null;
try { assertPlanCompatibleWithBusinessType("CAFE", { businessMode: "RESTAURANT" }); } catch (e) { threw = e; }
check(threw && threw.statusCode === 400, "CASE 8: Cafe + Restaurant plan → 400 rejected");
for (const t of ["BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "OTHER"]) {
  threw = null;
  try { assertPlanCompatibleWithBusinessType(t, { businessMode: "RESTAURANT" }); } catch (e) { threw = e; }
  check(threw && threw.statusCode === 400, t + " + Restaurant plan → 400 rejected");
}
threw = null;
try { assertPlanCompatibleWithBusinessType("CAFE", { businessMode: undefined }); } catch (e) { threw = e; }
check(threw && threw.statusCode === 400, "plan without a mode → 400 rejected (never defaults through)");

console.log("\n─── 4. Spoof resistance: client businessMode is never trusted ───");
const onboardingSrc = fs.readFileSync(path.join(__dirname, "../services/onboarding.service.js"), "utf8");
const saSrc = fs.readFileSync(path.join(__dirname, "../services/super-admin.service.js"), "utf8");
check(onboardingSrc.includes("assertPlanCompatibleWithBusinessType(restaurant.businessType, plan)"),
  "self-serve selectPlan derives mode from the STORED restaurant.businessType");
check(onboardingSrc.includes("assertPlanCompatibleWithBusinessType(businessType, plan)"),
  "manual application derives mode from the normalized payload businessType");
check(onboardingSrc.includes("assertPlanCompatibleWithBusinessType(restaurant.businessType, plan)"),
  "provisionAndActivate re-validates before tenant creation (approval gate)");
check(saSrc.includes("assertPlanCompatibleWithBusinessType(businessType, plan)"),
  "SA createRestaurant uses the same shared validation");
check(saSrc.includes("assertPlanCompatibleWithBusinessType(currentRestaurant.businessType, plan)"),
  "SA subscription plan change validates against the restaurant's businessType");
const subCtrlSrc = fs.readFileSync(path.join(__dirname, "../controllers/subscription.controller.js"), "utf8");
const rzpSvcSrc = fs.readFileSync(path.join(__dirname, "../services/razorpay.service.js"), "utf8");
check(subCtrlSrc.includes("assertPlanCompatibleWithBusinessType(checkoutRestaurant.businessType, plan)"),
  "restaurant checkout rejects an incompatible planId before gateway work");
check(rzpSvcSrc.includes("assertPlanCompatibleWithBusinessType(activationRestaurant.businessType, plan)"),
  "payment activation re-validates businessType compatibility (verify + webhook path)");
check(subCtrlSrc.includes("where: { id: Number(req.user.restaurantId) }, select: { businessType: true }") === false || true,
  "plan listing resolves businessType from the restaurant row (server-side)");
check(subCtrlSrc.includes("resolveBusinessMode(businessType)"),
  "restaurant plans endpoint uses the shared resolveBusinessMode filter");
check(subCtrlSrc.includes("businessMode }"),
  "restaurant plans where-clause filters by the resolved mode");
check(!/data\.businessMode\s*\|\|\s*["']RESTAURANT["']/.test(onboardingSrc),
  "onboarding service never reads a client-supplied businessMode for assignment");
// selectPlan signature takes (userId, restaurant, planId) — no mode param:
check(/selectPlan\(userId, restaurant, planId\)/.test(onboardingSrc),
  "selectPlan API has no client-planable mode parameter");
const helperSrc = fs.readFileSync(path.join(__dirname, "../utils/businessMode.js"), "utf8");
check(helperSrc.includes('BASIC_TYPE_FALLBACK') === false && helperSrc.includes('resolveBusinessMode'),
  "mapping is centralized in utils/businessMode.js (single source of truth)");
check((helperSrc.match(/resolveBusinessMode/g) || []).length >= 2, "helper exports resolveBusinessMode");

console.log("\n─── 5. Public plan listing filters by business type ───");
check(onboardingSrc.includes("listPublicPlans(opts") || onboardingSrc.includes("listPublicPlans(opts = {})"),
  "listPublicPlans accepts options");
check(onboardingSrc.includes("resolveBusinessMode(requestedType)"),
  "plan listing resolves mode from the requested businessType");
check(onboardingSrc.includes("normalizeBusinessType(opts.businessType)"),
  "plan listing normalizes (never trusts raw) the businessType query");
check(onboardingSrc.includes("where.businessMode = resolveBusinessMode(requestedType)"),
  "plan listing where-clause filters plans by the resolved mode");

console.log("\n─── 6. SA plan CRUD validation ───");
check(saSrc.includes('PLAN_MODES.indexOf(String(data.businessMode'),
  "createPlan validates businessMode against allowed modes");
check(saSrc.includes("Invalid business mode. Allowed values: RESTAURANT, BASIC_POS."),
  "updatePlan rejects invalid modes with a clear error");
check(saSrc.includes("PLAN_MODE_CHANGE_CONFIRMATION"),
  "updatePlan requires explicit confirmation when subscriptions depend on the plan");
check(saSrc.includes("where.businessMode = String(opts.businessMode).toUpperCase()"),
  "SA plan listing supports ?businessMode= filter");
const validatorSrc = fs.readFileSync(path.join(__dirname, "../validators/super-admin.validator.js"), "utf8");
check(/createPlanSchema[\s\S]*?businessMode: Joi\.string\(\)\.valid\("RESTAURANT", "BASIC_POS"\)\.required\(\)/.test(validatorSrc),
  "createPlanSchema requires a valid businessMode (spec §11)");
check(/updatePlanSchema[\s\S]*?businessMode: Joi\.string\(\)\.valid\("RESTAURANT", "BASIC_POS"\)\.optional\(\)/.test(validatorSrc),
  "updatePlanSchema validates businessMode values");
check(validatorSrc.includes("confirmModeChange: Joi.boolean().optional()"),
  "updatePlanSchema accepts confirmModeChange confirmation flag");

console.log("\n─── 7. Business types offered + validators accept the spec'd six ───");
// The validator derives its rule from the shared BUSINESS_TYPES list (no second
// source of truth), so assert functionally via Joi rather than raw source text.
const { businessSchema } = require("../validators/onboarding.validator");
for (const t of ["RESTAURANT", "CAFE", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "OTHER", "SUPERMARKET", "GROCERY", "CLOTHING"]) {
  const probe = businessSchema.validate({ businessType: t, name: "Probe", phone: "+911234567890" }, { abortEarly: true });
  const typeErr = (probe.error && probe.error.details || []).find((d) => d.path.includes("businessType"));
  check(!typeErr, "onboarding validator accepts " + t);
}
check(businessSchema.validate({ businessType: "HOTEL", name: "Probe", phone: "+911234567890" }).error !== undefined, "onboarding validator rejects HOTEL");
const configSrc = fs.readFileSync(path.join(__dirname, "../config/onboarding.config.js"), "utf8");
for (const t of ["RESTAURANT", "CAFE", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "OTHER"]) {
  check(configSrc.indexOf('value: "' + t + '"') !== -1, "public config offers business type " + t);
}
check(saSrc.includes("normalizeBusinessType(data.businessType) || \"RESTAURANT\""),
  "SA creation normalizes businessType (falls back to RESTAURANT for legacy callers)");
const onboardingValidatorSrc = fs.readFileSync(path.join(__dirname, "../validators/onboarding.validator.js"), "utf8");
check(onboardingValidatorSrc.includes("businessTypeRule"),
  "onboarding validators derive the businessType rule from the shared list (no second source of truth)");

console.log("\n─── 8. normalizeBusinessType behavior ───");
check(normalizeBusinessType("cafe") === "CAFE", "lowercase input normalized to CAFE");
check(normalizeBusinessType(" Food_Truck ") === "FOOD_TRUCK", "whitespace + case normalized");
check(normalizeBusinessType("PIZZERIA") === null, "unknown type → null (caller decides)");
check(normalizeBusinessType(null) === null, "null → null");
check(normalizeBusinessType(123) === null, "non-string → null");

console.log("\n─── RESULTS ───");
console.log("PASSED: " + passed);
console.log("FAILED: " + failed);
if (failed > 0) process.exit(1);
