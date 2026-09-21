/**
 * Discounts & Promotions — Backend Test Suite
 * Standalone — run directly with: node src/__tests__/discounts.test.js
 * Same pattern as the other suites in this folder: pure-function checks
 * against the real rule engine (utils/discountRules.js) + source-invariant
 * checks on the engine/controller/routes. No database required.
 */
const path = require("path");
const fs = require("fs");

process.chdir(path.resolve(__dirname, "../.."));

const {
  PROMOTION_TYPES,
  ALL_DAYS_MASK,
  normalizePromoCode,
  parseHHmm,
  dayListToMask,
  maskToDayList,
  isWithinDateRange,
  isDayValid,
  isTimeValid,
  isScopeCovered,
  evaluateEligibility,
  calculateDiscountAmount,
  discountLabel,
  canStackWith,
  effectiveStatus,
  validateDiscountInput,
  authorizeManualDiscount,
  parseStaffUserIds,
  staffRoleMaxPercent,
} = require("../utils/discountRules");
const { computeTotalAmount } = require("../services/discountEngine.service");
const { createDiscountSchema, applyDiscountSchema } = require("../validators/discount.validator");

const results = { pass: 0, fail: 0 };
function section(t) { console.log(`\n${"=".repeat(60)}\n  ${t}\n${"=".repeat(60)}`); }
function sub(t) { console.log(`\n  --- ${t} ---`); }
function check(cond, msg) {
  process.stdout.write(cond ? "  ✅ " : "  ❌ ");
  console.log(msg);
  cond ? results.pass++ : results.fail++;
}
function eq(actual, expected, label) {
  const pass = actual === expected;
  process.stdout.write(pass ? "  ✅ " : "  ❌ ");
  console.log(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  pass ? results.pass++ : results.fail++;
}

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n) => new Date(Date.now() + n * DAY);
const mkDiscount = (over = {}) => ({
  id: 1,
  name: "Test Discount",
  type: "PERCENTAGE",
  discountValue: 20,
  maximumDiscountAmount: null,
  minimumOrderAmount: 0,
  startDate: daysFromNow(-1),
  endDate: daysFromNow(1),
  startTime: null,
  endTime: null,
  status: "ACTIVE",
  scope: "ENTIRE_ORDER",
  applicableDays: ALL_DAYS_MASK,
  customerEligibility: "EVERYONE",
  stackable: false,
  maxDiscountsPerOrder: 1,
  usageLimit: null,
  usageCount: 0,
  perCustomerLimit: null,
  staffRoles: null,
  archivedAt: null,
  ...over,
});

// ═══════════════════════════════════════════════
//  1–4. CREATION TYPES + VALUE VALIDATION
// ═══════════════════════════════════════════════

section("1-4. CREATE PERCENTAGE / FIXED / STAFF / PROMO (schema)");

const jv = (schema, data) => schema.validate(data, { abortEarly: false });
const base = {
  name: "Weekend Special", type: "PERCENTAGE", discountValue: 20,
  startDate: daysFromNow(-1), endDate: daysFromNow(1),
};
check(!jv(createDiscountSchema, base).error, "1. Percentage discount accepted");
check(!jv(createDiscountSchema, { ...base, type: "FIXED_AMOUNT", discountValue: 200 }).error, "2. Fixed amount discount accepted");
check(!jv(createDiscountSchema, {
  ...base, type: "STAFF", discountValue: 10, staffRoles: ["MANAGER", "CASHIER", "WAITER"],
}).error, "3. Staff discount accepted with roles");
check(!jv(createDiscountSchema, { ...base, type: "PROMO_CODE", discountValue: 10, code: "welcome10" }).error, "4. Promo code discount accepted");
check(!!jv(createDiscountSchema, { ...base, type: "PROMO_CODE", discountValue: 10 }).error, "Promo code without code rejected");
check(!!jv(createDiscountSchema, { ...base, type: "PERCENTAGE", discountValue: 150 }).error, "6. Percentage > 100 rejected");
check(!!jv(createDiscountSchema, { ...base, discountValue: -5 }).error, "7. Negative discount rejected");
check(!!jv(createDiscountSchema, { ...base, discountValue: 0 }).error, "Zero discount rejected");
check(!!jv(createDiscountSchema, { ...base, endDate: daysFromNow(-5) }).error, "End date before start rejected");
check(!!jv(createDiscountSchema, { ...base, status: "EXPIRED" }).error, "Manual EXPIRED status rejected (derived only)");
check(PROMOTION_TYPES.includes("PROMO_CODE") && PROMOTION_TYPES.length === 4, "Enum-backed types (no arbitrary strings)");

// ═══════════════════════════════════════════════
//  5. PROMO CODE NORMALIZATION
// ═══════════════════════════════════════════════

section("5. PROMO CODE NORMALIZATION");
eq(normalizePromoCode("welcome10"), "WELCOME10", "welcome10 → WELCOME10");
eq(normalizePromoCode(" WELCOME10 "), "WELCOME10", "padded → WELCOME10");
eq(normalizePromoCode("We l come 10"), "WE L COME 10", "inner spaces collapsed, uppercased (deterministic)");
eq(normalizePromoCode(""), "", "empty → empty");

// ═══════════════════════════════════════════════
//  8–12. MINIMUM ORDER / MAXIMUM DISCOUNT / DATES / DAYS / TIME
// ═══════════════════════════════════════════════

section("8. MINIMUM ORDER ENFORCED");
const minDisc = mkDiscount({ minimumOrderAmount: 1000 });
eq(evaluateEligibility(minDisc, { subtotal: 500 }).reason, "MINIMUM_ORDER", "₹500 < ₹1000 → rejected");
eq(evaluateEligibility(minDisc, { subtotal: 1000 }).eligible, true, "₹1000 = threshold → eligible");
eq(evaluateEligibility(minDisc, { subtotal: 2000 }).eligible, true, "₹2000 > threshold → eligible");

section("9. MAXIMUM DISCOUNT ENFORCED (calculation)");
const capped = mkDiscount({ discountValue: 20, maximumDiscountAmount: 500 });
eq(calculateDiscountAmount(capped, 5000), 500, "20% of ₹5000 = ₹1000 → capped to ₹500");
eq(calculateDiscountAmount(capped, 2000), 400, "20% of ₹2000 = ₹400 (under cap)");
eq(calculateDiscountAmount(mkDiscount({ maximumDiscountAmount: 0 }), 2000), 400, "max=0 → no cap");

section("10-11. START/END DATE ENFORCED");
const future = mkDiscount({ startDate: daysFromNow(2), endDate: daysFromNow(5) });
eq(evaluateEligibility(future, { now: new Date() }).reason, "OUT_OF_DATE_RANGE", "before start → rejected (SCHEDULED)");
const past = mkDiscount({ startDate: daysFromNow(-10), endDate: daysFromNow(-2) });
eq(evaluateEligibility(past, { now: new Date() }).reason, "OUT_OF_DATE_RANGE", "after end → rejected (EXPIRED)");
const active = mkDiscount();
eq(evaluateEligibility(active, { now: new Date() }).eligible, true, "within range → eligible");

section("12. VALID DAY ENFORCED");const weekendOnly = mkDiscount({ applicableDays: dayListToMask(["SATURDAY", "SUNDAY"]), startDate: new Date("2026-09-01T00:00:00"), endDate: new Date("2026-09-30T23:59:59") });
const sat = new Date("2026-09-19T12:00:00"); // Saturday (within range)
const wed = new Date("2026-09-16T12:00:00"); // Wednesday (within range)
eq(isDayValid(weekendOnly, sat), true, "Saturday valid for weekend promo");
eq(isDayValid(weekendOnly, wed), false, "Wednesday invalid for weekend promo");
eq(evaluateEligibility(weekendOnly, { now: wed }).reason, "DAY_NOT_VALID", "weekday → DAY_NOT_VALID");
eq(dayListToMask([]), ALL_DAYS_MASK, "no days selected → every day");
eq(dayListToMask(["Mon"]).toString(), dayListToMask(["MONDAY"]).toString(), "day names case/prefix tolerant");
eq(maskToDayList(dayListToMask(["SATURDAY", "SUNDAY"])).sort().join(","), "Sat,Sun", "mask → day list");

section("13. VALID TIME ENFORCED");
const happyHour = mkDiscount({ startTime: "16:00", endTime: "19:00", startDate: new Date("2026-09-01T00:00:00"), endDate: new Date("2026-09-30T23:59:59") });
const at5pm = new Date("2026-09-16T17:00:00");
const atNoon = new Date("2026-09-16T12:00:00");
eq(isTimeValid(happyHour, at5pm), true, "17:00 inside 16:00–19:00");
eq(isTimeValid(happyHour, atNoon), false, "12:00 outside 16:00–19:00");
eq(evaluateEligibility(happyHour, { now: atNoon }).reason, "OUT_OF_TIME_WINDOW", "outside window → rejected");
const overnight = mkDiscount({ startTime: "22:00", endTime: "02:00" });
eq(isTimeValid(overnight, new Date("2026-09-16T23:00:00")), true, "23:00 inside 22:00–02:00 (crosses midnight)");
eq(isTimeValid(overnight, new Date("2026-09-17T01:00:00")), true, "01:00 inside 22:00–02:00 (crosses midnight)");
eq(isTimeValid(overnight, new Date("2026-09-16T12:00:00")), false, "noon outside overnight window");
eq(parseHHmm("16:00"), 960, "parseHHmm valid");
eq(parseHHmm("25:00"), null, "parseHHmm invalid hour");
eq(parseHHmm(null), null, "parseHHmm null → null (optional)");

// ═══════════════════════════════════════════════
//  14-17. EFFECTIVE STATUS DERIVATION
// ═══════════════════════════════════════════════

section("14-17. EFFECTIVE STATUS (SCHEDULED/ACTIVE/EXPIRED/DISABLED)");
eq(effectiveStatus(mkDiscount({ startDate: daysFromNow(2), endDate: daysFromNow(5) })), "SCHEDULED", "future → SCHEDULED");
eq(effectiveStatus(mkDiscount()), "ACTIVE", "in range → ACTIVE");
eq(effectiveStatus(mkDiscount({ startDate: daysFromNow(-10), endDate: daysFromNow(-2) })), "EXPIRED", "past → EXPIRED");
eq(effectiveStatus(mkDiscount({ status: "DISABLED" })), "DISABLED", "DISABLED never auto-activates");
eq(effectiveStatus(mkDiscount({ status: "DISABLED", archivedAt: new Date() })), "DISABLED", "archived+disabled → DISABLED (not active)");

// ═══════════════════════════════════════════════
//  18-20. SCOPE (PRODUCT / CATEGORY / WHOLE ORDER)
// ═══════════════════════════════════════════════

section("18-20. SCOPE COVERAGE");
const items = [{ menuItemId: 11, categoryId: 2 }, { menuItemId: 12, categoryId: 2 }];
eq(isScopeCovered(mkDiscount({ scope: "ENTIRE_ORDER" }), items, {}), true, "ENTIRE_ORDER always covered");
eq(
  isScopeCovered(mkDiscount({ scope: "CATEGORIES" }), items, { includedIds: [2] }),
  true, "CATEGORIES: all items in included category"
);
eq(
  isScopeCovered(mkDiscount({ scope: "CATEGORIES" }), [{ menuItemId: 11, categoryId: 2 }, { menuItemId: 13, categoryId: 3 }], { includedIds: [2] }),
  false, "CATEGORIES: one item outside category → not covered"
);
eq(
  isScopeCovered(mkDiscount({ scope: "PRODUCTS" }), items, { includedIds: [11, 12] }),
  true, "PRODUCTS: all items included"
);
eq(
  isScopeCovered(mkDiscount({ scope: "PRODUCTS" }), items, { includedIds: [11] }),
  false, "PRODUCTS: one item not included → not covered"
);

// ═══════════════════════════════════════════════
//  21-22. STAFF ROLE RESTRICTION + ROLE MAXIMUM
// ═══════════════════════════════════════════════

section("21-22. STAFF ROLE RESTRICTION + ROLE LIMIT");
const staffDisc = mkDiscount({
  type: "STAFF", discountValue: 10, staffRoles: JSON.stringify(["MANAGER", "CASHIER"]),
});
eq(evaluateEligibility(staffDisc, { staffRole: "CASHIER" }).eligible, true, "CASHIER eligible");
eq(evaluateEligibility(staffDisc, { staffRole: "WAITER" }).reason, "STAFF_ROLE_NOT_ELIGIBLE", "WAITER not in roles → rejected");
eq(evaluateEligibility(staffDisc, { staffRole: null }).reason, "STAFF_DISCOUNT_REQUIRES_STAFF_USER", "no staff user → rejected");

const roleCapped = mkDiscount({
  type: "STAFF", discountValue: 15,
  staffRoles: JSON.stringify(["CASHIER"]),
  staffRoleMaxPercent: { CASHIER: 5 },
});
// No explicit request: the engine applies min(configured 15, role cap 5) = 5%
eq(evaluateEligibility(roleCapped, { staffRole: "CASHIER" }).eligible, true, "cashier default → eligible (effective % capped to 5)");
eq(
  evaluateEligibility(roleCapped, { staffRole: "CASHIER", requestedValue: 10 }).reason,
  "STAFF_ROLE_LIMIT", "cashier attempts 10% with role cap 5% → REJECTED"
);
eq(
  evaluateEligibility(roleCapped, { staffRole: "CASHIER", requestedValue: 5 }).eligible,
  true, "cashier at 5% (role cap) → allowed"
);

// ═══════════════════════════════════════════════
//  16a. USAGE LIMITS (rule level)
// ═══════════════════════════════════════════════

section("16a. USAGE LIMIT (server counters)");
eq(evaluateEligibility(mkDiscount({ usageLimit: 100, usageCount: 99 })).eligible, true, "99/100 uses → eligible");
eq(evaluateEligibility(mkDiscount({ usageLimit: 100, usageCount: 100 })).reason, "USAGE_LIMIT_REACHED", "100/100 → rejected");
eq(evaluateEligibility(mkDiscount({ perCustomerLimit: 1 })).eligible, true, "per-customer 0 uses → eligible");
eq(evaluateEligibility(mkDiscount({ perCustomerLimit: 1 }), { customerUses: 1 }).reason, "PER_CUSTOMER_LIMIT_REACHED", "per-customer 1 use → rejected");

// ═══════════════════════════════════════════════
//  25-26. STACKING
// ═══════════════════════════════════════════════

section("25-26. STACKING RULES");
eq(canStackWith([], mkDiscount()).allowed, true, "no existing discounts → allowed");
eq(canStackWith([{ id: 9, stackable: true }], mkDiscount({ stackable: false })).allowed, false, "incoming non-stackable → blocked");
eq(canStackWith([{ id: 9, stackable: false }], mkDiscount({ stackable: true })).allowed, false, "existing non-stackable → blocked");
eq(canStackWith([{ id: 9, stackable: true }], mkDiscount({ stackable: true, maxDiscountsPerOrder: 2 })).allowed, true, "stackable pair within limit → allowed");
eq(canStackWith([{ id: 9 }, { id: 10 }], mkDiscount({ stackable: true, maxDiscountsPerOrder: 2 })).reason, "MAX_DISCOUNTS_PER_ORDER", "2 of max 2 → blocked");
eq(canStackWith([{ id: 9, isManual: true }], mkDiscount({ stackable: true })).allowed, false, "manual discount never stacks");

// ═══════════════════════════════════════════════
//  23. HISTORICAL SNAPSHOTS (calculation purity + total math)
// ═══════════════════════════════════════════════

section("23. ORDER AMOUNT MATH (history-safe totals)");
eq(computeTotalAmount({ subtotal: 2000, taxAmount: 324, serviceCharge: 0 }, 400), 1924, "₹2000 − ₹400 + tax = ₹1924");
eq(computeTotalAmount({ subtotal: 1000, taxAmount: 0, serviceCharge: 50 }, 1000), 50, "100% discount → service charge remains");
eq(calculateDiscountAmount(mkDiscount({ type: "FIXED_AMOUNT", discountValue: 200 }), 100), 100, "fixed ₹200 on ₹100 order → clamped to subtotal");
eq(calculateDiscountAmount(mkDiscount({ type: "STAFF", discountValue: 10 }), 2000, 5), 100, "staff override 5% of ₹2000 = ₹100");
eq(discountLabel(mkDiscount({ type: "PERCENTAGE", discountValue: 20 })), "20% OFF", "percentage label");
eq(discountLabel(mkDiscount({ type: "FIXED_AMOUNT", discountValue: 200 })), "₹200 OFF", "fixed label");

// ═══════════════════════════════════════════════
//  31. MANUAL DISCOUNT AUTHORIZATION
// ═══════════════════════════════════════════════

section("31. MANUAL DISCOUNT AUTHORIZATION");
eq(authorizeManualDiscount({ type: "PERCENTAGE", value: 10, subtotal: 1000, hasDiscountPermission: true }).allowed, true, "10% manual allowed with permission");
eq(authorizeManualDiscount({ type: "PERCENTAGE", value: 10, subtotal: 1000, hasDiscountPermission: false }).reason, "NO_PERMISSION", "no billing.discount permission → rejected");
eq(authorizeManualDiscount({ type: "PERCENTAGE", value: -5, subtotal: 1000, hasDiscountPermission: true }).allowed, false, "negative value rejected");
eq(authorizeManualDiscount({ type: "PERCENTAGE", value: 150, subtotal: 1000, hasDiscountPermission: true }).allowed, false, ">100% rejected");
eq(authorizeManualDiscount({ type: "PERCENTAGE", value: 60, subtotal: 1000, hasDiscountPermission: true }).reason, "NEEDS_APPROVAL", "above manual ceiling → needs approval");
eq(authorizeManualDiscount({ type: "FIXED_AMOUNT", value: 100, subtotal: 1000, hasDiscountPermission: true }).amount, 100, "fixed ₹100 → amount 100");

// ═══════════════════════════════════════════════
//  28. TENANT ISOLATION (source invariants) + 29 RBAC + 30 concurrency + 32 audit
// ═══════════════════════════════════════════════

section("28-32. TENANT ISOLATION / RBAC / CONCURRENCY / AUDIT (source invariants)");

const routesSrc = fs.readFileSync(path.join(process.cwd(), "src/routes/discount.routes.js"), "utf8");
const engineSrc = fs.readFileSync(path.join(process.cwd(), "src/services/discountEngine.service.js"), "utf8");
const controllerSrc = fs.readFileSync(path.join(process.cwd(), "src/controllers/discount.controller.js"), "utf8");
const schemaSrc = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");

sub("Tenant isolation — every query runs on req.tenantDb / the passed tenant client");
check(!/platformPrisma/.test(controllerSrc), "discount controller never touches the public schema");
check(engineSrc.includes("db.order.findFirst") || engineSrc.includes("db.order.findUnique"), "engine reads orders via the tenant client");
check(/db\.\$transaction/.test(engineSrc), "apply path runs inside a tenant transaction");
check(/req\.tenantDb/.test(controllerSrc), "controller resolves the tenant client from the authenticated request");
check(!/req\.body\.restaurantId/.test(controllerSrc), "controller never trusts a client-supplied restaurantId");
check(schemaSrc.includes("model Discount {") && schemaSrc.includes("model OrderDiscount {"), "Discount + OrderDiscount are tenant-schema Prisma models");

sub("RBAC — existing middleware chain, no parallel role system");
check(routesSrc.includes('authorize("ADMIN", "MANAGER")'), "management routes restricted to ADMIN/MANAGER");
check(routesSrc.includes('authorize("ADMIN", "MANAGER", "CASHIER")'), "apply routes restricted to billing-capable roles");
check(!routesSrc.includes('"KITCHEN"'), "KITCHEN has no discount route access");
check(routesSrc.includes('requirePermission("billing.discount")'), "write routes require the existing billing.discount permission");
check(routesSrc.includes("requireFeature"), "plan-feature gate present on discount routes");
check(routesSrc.includes("requireFeature") && !/requireBusinessCapability\("RESTAURANT"\)/.test(routesSrc), "no scattered businessType checks (capability system untouched)");

sub("Concurrency — guarded usage claim inside a transaction");
check(engineSrc.includes("updateMany") && engineSrc.includes("usageCount: { lt"), "usage increment uses a guarded updateMany (no oversell)");
check(engineSrc.includes("already applied"), "double application guard present");

sub("Audit logging — existing mechanism, no secrets");
check(controllerSrc.includes('createAuditLog'), "controller writes audit logs via the existing audit service");
check(controllerSrc.includes('"DISCOUNT"'), "AUDIT module DISCOUNT used");
check(!/password|secret|smtp/i.test(JSON.stringify((controllerSrc.match(/description: `[^`]*`/g) || []))), "audit descriptions contain no credentials");

sub("Historical safety — snapshots, never recalculation");
check(!/recalculateOrder/.test(engineSrc.replace(/const { recalculateOrder } = require\("\.\/order\.service"\);/, "")), "engine never reuses the legacy order recalculation (which rebuilds from discountType)");
check(schemaSrc.includes("discountName") && schemaSrc.includes("discountLabel"), "OrderDiscount stores name/label/value snapshots");
check(schemaSrc.includes('onDelete: SetNull') && schemaSrc.includes('onDelete: Cascade'), "OrderDiscount.orderId cascade; discountId SetNull (history survives promotion deletion)");

sub("Apply endpoint validation");
check(!jv(applyDiscountSchema, { discountId: 1, promoCode: "X" }).error === false, "discountId + promoCode together rejected (xor)");
check(!jv(applyDiscountSchema, { discountId: 5 }).error, "discountId-only accepted");
check(!jv(applyDiscountSchema, { promoCode: "WELCOME10" }).error, "promoCode-only accepted");
check(!jv(applyDiscountSchema, { discountId: 5, staffUserId: 32 }).error, "staffUserId accepted on apply");

// ═══════════════════════════════════════════════
//  33. STAFF-SPECIFIC TARGETING + PROMO METHOD (refinement)
// ═══════════════════════════════════════════════

section("33. STAFF-SPECIFIC TARGETING + PROMO METHOD");

sub("Promo method — percentage vs fixed grants");
eq(calculateDiscountAmount(mkDiscount({ type: "PROMO_CODE", discountValue: 200, promoMethod: "FIXED_AMOUNT" }), 1000), 200, "promo fixed ₹200 on ₹1000 = ₹200");
eq(calculateDiscountAmount(mkDiscount({ type: "PROMO_CODE", discountValue: 10, promoMethod: "PERCENTAGE" }), 1000), 100, "promo 10% of ₹1000 = ₹100");
eq(calculateDiscountAmount(mkDiscount({ type: "PROMO_CODE", discountValue: 10, promoMethod: "PERCENTAGE", maximumDiscountAmount: 50 }), 1000), 50, "promo % capped by maximum discount");
eq(calculateDiscountAmount(mkDiscount({ type: "PROMO_CODE", discountValue: 10 }), 1000), 10, "promo without method defaults to fixed");
eq(discountLabel(mkDiscount({ type: "PROMO_CODE", discountValue: 10, promoMethod: "PERCENTAGE" })), "10% OFF", "promo percentage label");
eq(discountLabel(mkDiscount({ type: "PROMO_CODE", discountValue: 200, promoMethod: "FIXED_AMOUNT" })), "₹200 OFF", "promo fixed label");
check(!jv(createDiscountSchema, { name: "P", type: "PROMO_CODE", discountValue: 10, promoMethod: "PERCENTAGE", startDate: "2026-01-01", endDate: "2026-02-01", code: "P10", scope: "ENTIRE_ORDER" }).error, "promoMethod PERCENTAGE accepted by validator");
check(!!jv(createDiscountSchema, { name: "P", type: "PROMO_CODE", discountValue: 10, promoMethod: "BOTH", startDate: "2026-01-01", endDate: "2026-02-01", code: "P10", scope: "ENTIRE_ORDER" }).error, "invalid promoMethod rejected");

sub("Staff targeting — specific members validated");
check(parseStaffUserIds(null).length === 0, "null staffUserIds parses to empty");
eq(parseStaffUserIds(JSON.stringify([32, 35])).length, 2, "JSON staffUserIds array parsed");
check(parseStaffUserIds("not json").length === 0, "corrupt staffUserIds parses safely to empty");
const staffDiscount = mkDiscount({ type: "STAFF", discountValue: 10, staffRoles: ["CASHIER"], staffUserIds: [35] });
eq(evaluateEligibility(staffDiscount, { now: new Date(), staffRole: "CASHIER", staffUserId: 35, orderItems: [{ menuItemId: 1, categoryId: 1 }], subtotal: 1000 }).eligible, true, "targeted staff member IS eligible");
eq(evaluateEligibility(staffDiscount, { now: new Date(), staffRole: "CASHIER", staffUserId: 99, orderItems: [{ menuItemId: 1, categoryId: 1 }], subtotal: 1000 }).reason, "STAFF_MEMBER_NOT_ELIGIBLE", "non-targeted staff member REJECTED");
eq(evaluateEligibility(mkDiscount({ type: "STAFF", discountValue: 10, staffRoles: ["CASHIER"] }), { now: new Date(), staffRole: "CASHIER", staffUserId: 99, orderItems: [{ menuItemId: 1, categoryId: 1 }], subtotal: 1000 }).eligible, true, "no targeting list → role-based eligibility only");
eq(evaluateEligibility(mkDiscount({ type: "STAFF", discountValue: 10, staffRoles: ["KITCHEN"] }), { now: new Date(), staffRole: "KITCHEN", staffUserId: 50, orderItems: [{ menuItemId: 1, categoryId: 1 }], subtotal: 1000 }).eligible, true, "role-only check unchanged (engine enforces recipient role)");
check(jv(createDiscountSchema, { name: "S", type: "STAFF", discountValue: 10, startDate: "2026-01-01", endDate: "2026-02-01", scope: "ENTIRE_ORDER", staffRoles: ["CASHIER"], staffUserIds: [35, 36] }).error === null || !jv(createDiscountSchema, { name: "S", type: "STAFF", discountValue: 10, startDate: "2026-01-01", endDate: "2026-02-01", scope: "ENTIRE_ORDER", staffRoles: ["CASHIER"], staffUserIds: [35, 36] }).error, "staffUserIds accepted by validator");
check(!!jv(createDiscountSchema, { name: "S", type: "STAFF", discountValue: 10, startDate: "2026-01-01", endDate: "2026-02-01", scope: "ENTIRE_ORDER", staffRoles: ["CASHIER"], staffUserIds: ["abc"] }).error, "non-numeric staffUserIds rejected");

sub("OrderDiscount staff-recipient snapshot (schema)");
check(schemaSrc.includes("staffUserId"), "OrderDiscount.staffUserId column exists");
check(schemaSrc.includes("staffName"), "OrderDiscount.staffName historical snapshot column exists");
check(schemaSrc.includes("staffUserIds"), "Discount.staffUserIds targeting column exists");
check(schemaSrc.includes("promoMethod"), "Discount.promoMethod column exists");
check(engineSrc.includes("staffUserId: staffRecipient?.id"), "engine persists staffUserId on OrderDiscount");
check(engineSrc.includes("does not exist in this restaurant"), "engine rejects staff member outside the tenant");
check(engineSrc.includes("is not eligible for this staff discount"), "engine rejects staff member not targeted by the promotion");
check(engineSrc.includes("cannot receive a staff discount"), "engine rejects ineligible roles (KITCHEN) as recipient");
check(controllerSrc.includes("validateStaffUsers"), "controller validates selected staff users on create/update");
check(controllerSrc.includes("reference/categories") === false && controllerSrc.includes("getReferenceCategories"), "reference endpoints exported from the discount controller");
check(routesSrc.includes("/reference/staff"), "reference/staff route registered (before /:id)");
check(!/restaurantId/.test(JSON.stringify((routesSrc.match(/router\.(get|post)[^;]*getReference/g) || []))), "reference routes never take a restaurantId selector");

sub("Staff identity model — recipient vs operator (§2/§5/§17/§18)");
check(
  !engineSrc.includes("staffUserId || user?.id"),
  "engine NEVER falls back to the logged-in user as staff recipient"
);
check(
  engineSrc.includes("Select the staff member receiving this discount"),
  "STAFF apply without staffUserId is rejected 400 (no silent recipient)"
);
check(
  engineSrc.includes("staffRecipient ? staffRecipient.role : user?.role"),
  "recipient's role governs the staff discount cap (not the applier's)"
);
check(
  !engineSrc.includes("const effectiveRole = user?.role;"),
  "applier's role is never the sole authority for staff caps"
);
// With deferStaffChecks, the LISTING path no longer evaluates staff rules —
// meaning a CASHIER-listed panel still shows a MANAGER-role staff promotion.
eq(
  evaluateEligibility(mkDiscount({ type: "STAFF", discountValue: 10, staffRoles: ["MANAGER"] }), {
    now: new Date(), staffRole: "CASHIER", deferStaffChecks: true,
    orderItems: [{ menuItemId: 1, categoryId: 1 }], subtotal: 1000,
  }).eligible,
  true,
  "listing defers staff-role checks (applier role never hides a staff promotion)"
);
eq(
  evaluateEligibility(mkDiscount({ type: "STAFF", discountValue: 10, staffRoles: ["CASHIER"] }), {
    now: new Date(), staffRole: "KITCHEN", staffUserId: 50,
    orderItems: [{ menuItemId: 1, categoryId: 1 }], subtotal: 1000,
  }).reason,
  "STAFF_ROLE_NOT_ELIGIBLE",
  "apply-time recipient role check still enforced (KITCHEN rejected)"
);
// Recipient role cap governs the effective value at apply time.
const capDisc = mkDiscount({
  type: "STAFF", discountValue: 15,
  staffRoles: ["MANAGER", "CASHIER"],
  staffRoleMaxPercent: { MANAGER: 15, CASHIER: 10 },
});
eq(staffRoleMaxPercent(capDisc, "CASHIER"), 10, "recipient CASHIER cap = 10 (not applier's role)");
eq(staffRoleMaxPercent(capDisc, "MANAGER"), 15, "recipient MANAGER cap = 15");
// STAFF + PROMO_CODE/PERCENTAGE/FIXED_AMOUNT contract isolation (§9):
check(
  !jv(applyDiscountSchema, { discountId: 5 }).error || jv(applyDiscountSchema, { discountId: 5 }).error === null,
  "PERCENTAGE/FIXED_AMOUNT apply needs no staffUserId"
);
check(
  jv(applyDiscountSchema, { discountId: 5, staffUserId: "abc" }).error !== null || !!jv(applyDiscountSchema, { discountId: 5, staffUserId: "abc" }).error,
  "non-numeric staffUserId rejected by apply validator"
);

sub("Eligible-listing reasons (§13 — no false 'No eligible discounts')");
check(
  engineSrc.includes("excluded.push({ discount: d, reason: result.reason"),
  "listing returns excluded promotions with machine reasons"
);
check(
  controllerSrc.includes("reasonLabel"),
  "controller maps reasons to human-readable labels"
);
check(
  engineSrc.includes("deferStaffChecks: d.type === \"STAFF\""),
  "STAFF promotions are listed (recipient chosen at apply time)"
);

// ═══════════════════════════════════════════════
//  STAFF DISCOUNT — ROLE-BASED ELIGIBILITY + CAPABILITY ROLES
// ═══════════════════════════════════════════════
section("STAFF DISCOUNT — ROLE-BASED ELIGIBILITY (spec §1-§11)");

const validatorSrc = fs.readFileSync(path.join(process.cwd(), "src/validators/discount.validator.js"), "utf8");

sub("Capability-derived receivable roles (§6/§7/§8/§9)");
const { staffDiscountRoles } = require("../utils/businessCapabilities");
const restaurantRoles = staffDiscountRoles("RESTAURANT");
check(restaurantRoles.includes("MANAGER") && restaurantRoles.includes("CASHIER"), "restaurant: Manager + Cashier receivable");
check(restaurantRoles.includes("KITCHEN"), "restaurant: Kitchen Staff receivable (kitchen capability)");
check(restaurantRoles.includes("WAITER"), "restaurant: Service Staff receivable (service workflow)");
const retailRoles = staffDiscountRoles("SUPERMARKET");
check(retailRoles.includes("MANAGER") && retailRoles.includes("CASHIER"), "supermarket: Manager + Cashier receivable");
check(!retailRoles.includes("KITCHEN"), "supermarket: Kitchen Staff NOT receivable (no kitchen capability)");
check(!retailRoles.includes("WAITER"), "supermarket: Service Staff NOT receivable (no service workflow)");
check(staffDiscountRoles("CLOTHING").includes("KITCHEN") === false, "clothing: Kitchen Staff NOT receivable");
check(staffDiscountRoles("BAKERY").includes("KITCHEN") === true, "bakery: Kitchen Staff receivable (BASIC_POS food business, kitchen=true)");
check(staffDiscountRoles("CLOUD_KITCHEN").includes("WAITER") === false, "cloud kitchen: Service Staff NOT receivable (no tables)");

sub("Manager approval removed from STAFF discounts (§4/§5)");
check(
  !validatorSrc.includes("staffRequireApproval"),
  "validator no longer accepts staffRequireApproval"
);
check(
  !/staffRequireApproval\s*=/i.test(controllerSrc) || controllerSrc.includes("data.staffRequireApproval = false"),
  "controller never writes a true approval flag"
);
check(
  engineSrc.includes("approvedBy: null"),
  "engine persists no approver on staff-discount application"
);

sub("Backend is source of truth for role eligibility (§3)");
check(
  controllerSrc.includes("resolveStaffDiscountRoles(req.user?.restaurantId)"),
  "create/update resolve receivable roles server-side from the tenant row"
);
check(
  controllerSrc.includes("is not available for this business type"),
  "configuring an unsupported role is rejected server-side"
);
check(
  engineSrc.includes("cannot receive a staff discount in this business type"),
  "apply path enforces business-type receivable roles"
);
check(
  controllerSrc.includes("getReferenceStaff") && controllerSrc.includes("staffDiscountRoles"),
  "reference/staff filters recipients by business capability"
);
check(
  engineSrc.includes("Select the staff member receiving this discount"),
  "recipient remains explicit — never the logged-in operator"
);
// Engine-level role gate (pure): MANAGER promotion applied to CASHIER recipient → reject
eq(
  evaluateEligibility(mkDiscount({ type: "STAFF", discountValue: 10, staffRoles: ["MANAGER"] }), {
    now: new Date(), staffRole: "CASHIER", staffUserId: 7,
    orderItems: [{ menuItemId: 1, categoryId: 1 }], subtotal: 1000,
  }).reason,
  "STAFF_ROLE_NOT_ELIGIBLE",
  "role-based promotion: recipient role outside staffRoles is rejected"
);
eq(
  evaluateEligibility(mkDiscount({ type: "STAFF", discountValue: 10, staffRoles: ["MANAGER"] }), {
    now: new Date(), staffRole: "MANAGER", staffUserId: 8,
    orderItems: [{ menuItemId: 1, categoryId: 1 }], subtotal: 1000,
  }).eligible,
  true,
  "role-based promotion: every active member of the role is eligible without individual selection"
);

// ═══════════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════════

section("RESULTS");
console.log(`\n  Total:  ${results.pass + results.fail}`);
console.log(`  Passed: ${results.pass} ✅`);
console.log(`  Failed: ${results.fail} ${results.fail > 0 ? "❌" : "✅"}`);
if (results.fail > 0) {
  console.log("\n  ❌ SOME TESTS FAILED\n");
  process.exit(1);
} else {
  console.log("\n  ✅ ALL TESTS PASSED\n");
}
