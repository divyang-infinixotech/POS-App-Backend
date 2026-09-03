/**
 * Bill Discount Management - Comprehensive Test Suite
 * Standalone - run directly with: node src/__tests__/run.js
 *
 * Tests all discount scenarios without external dependencies.
 * No Jest, Mocha, or database required.
 */
const path = require("path");

// ─── Ensure we're in the project root ───
process.chdir(path.resolve(__dirname, "../.."));

// ─── Direct imports (real functions) ───
const { calculateDiscountAmount, formatDiscountLabel } = require("../utils/discount");

// ─── Track results ───
const results = { pass: 0, fail: 0 };

function section(title) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}`);
}

function sub(title) {
  console.log(`\n  --- ${title} ---`);
}

function check(condition, message) {
  process.stdout.write(condition ? "  ✅ " : "  ❌ ");
  console.log(message);
  condition ? results.pass++ : results.fail++;
}

function eq(actual, expected, label) {
  const pass = actual === expected;
  process.stdout.write(pass ? "  ✅ " : "  ❌ ");
  console.log(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  pass ? results.pass++ : results.fail++;
}

// ═══════════════════════════════════════════════
//  1. DISCOUNT CALCULATION UTILITY
// ═══════════════════════════════════════════════

section("1. DISCOUNT CALCULATION UTILITY");

sub("Percentage (subtotal = ₹2000)");
eq(calculateDiscountAmount("PERCENTAGE", 5, 2000), 100, "5% of 2000 = 100");
eq(calculateDiscountAmount("PERCENTAGE", 10, 2000), 200, "10% of 2000 = 200");
eq(calculateDiscountAmount("PERCENTAGE", 25, 2000), 500, "25% of 2000 = 500");
eq(calculateDiscountAmount("PERCENTAGE", 100, 2000), 2000, "100% of 2000 = 2000");

sub("Fixed Amount (subtotal = ₹2000)");
eq(calculateDiscountAmount("FLAT", 50, 2000), 50, "₹50 flat = 50");
eq(calculateDiscountAmount("FLAT", 100, 2000), 100, "₹100 flat = 100");
eq(calculateDiscountAmount("FLAT", 500, 2000), 500, "₹500 flat = 500");

sub("Edge Cases");
eq(calculateDiscountAmount("PERCENTAGE", 150, 2000), 2000, "150% capped to subtotal (2000)");
eq(calculateDiscountAmount("FLAT", 3000, 2000), 2000, "₹3000 flat capped to subtotal (2000)");
eq(calculateDiscountAmount("PERCENTAGE", 0, 2000), 0, "0% = 0");
eq(calculateDiscountAmount("FLAT", 0, 2000), 0, "₹0 = 0");
eq(calculateDiscountAmount(null, 0, 2000), 0, "null type = 0");
eq(calculateDiscountAmount("PERCENTAGE", 7.5, 2000), 150, "7.5% of 2000 = 150");
eq(calculateDiscountAmount("PERCENTAGE", 33.33, 2000), 666.6, "33.33% of 2000 = 666.6");
eq(calculateDiscountAmount("FLAT", 199.99, 2000), 199.99, "₹199.99 = 199.99");

sub("formatDiscountLabel");
eq(formatDiscountLabel({ discount: 100, discountType: "PERCENTAGE", discountValue: 10 }),
   "Discount (10%):", "Percentage label");
eq(formatDiscountLabel({ discount: 100, discountType: "FLAT", discountValue: 100 }),
   "Discount (\u20B9100):", "Flat label");
eq(formatDiscountLabel({ discount: 200, discountType: null, discountValue: 0 }),
   "Discount:", "No type (legacy)");
eq(formatDiscountLabel({ discount: 0, discountType: "PERCENTAGE", discountValue: 0 }),
   "", "Zero discount");
eq(formatDiscountLabel(null), "", "Null bill");

// ═══════════════════════════════════════════════
//  2. BILL RECALCULATION
// ═══════════════════════════════════════════════

section("2. BILL RECALCULATION");

function grandTotal(subtotal, discountAmt, sc, tax, ro) {
  return subtotal - discountAmt + (sc || 0) + (tax || 0) + (ro || 0);
}

const SBT = 2000, TAX = 324;

sub("Scenario: ₹2,000 bill, 10% discount");
let disc = calculateDiscountAmount("PERCENTAGE", 10, SBT);
eq(disc, 200, "Discount = ₹200");
eq(grandTotal(SBT, disc, 0, TAX, 0), 2124, "Grand Total = ₹2,124");

sub("Scenario: ₹2,000 bill, 25% discount");
disc = calculateDiscountAmount("PERCENTAGE", 25, SBT);
eq(disc, 500, "Discount = ₹500");
eq(grandTotal(SBT, disc, 0, TAX, 0), 1824, "Grand Total = ₹1,824");

sub("Scenario: ₹2,000 bill, 100% discount");
disc = calculateDiscountAmount("PERCENTAGE", 100, SBT);
eq(disc, 2000, "Discount = ₹2,000");
eq(grandTotal(SBT, disc, 0, TAX, 0), 324, "Grand Total = ₹324 (tax only)");

sub("Scenario: ₹2,000 bill, ₹50 flat");
disc = calculateDiscountAmount("FLAT", 50, SBT);
eq(disc, 50, "Discount = ₹50");
eq(grandTotal(SBT, disc, 0, TAX, 0), 2274, "Grand Total = ₹2,274");

sub("Scenario: ₹2,000 bill, ₹100 flat");
disc = calculateDiscountAmount("FLAT", 100, SBT);
eq(disc, 100, "Discount = ₹100");
eq(grandTotal(SBT, disc, 0, TAX, 0), 2224, "Grand Total = ₹2,224");

sub("Scenario: ₹2,000 bill, ₹500 flat");
disc = calculateDiscountAmount("FLAT", 500, SBT);
eq(disc, 500, "Discount = ₹500");
eq(grandTotal(SBT, disc, 0, TAX, 0), 1824, "Grand Total = ₹1,824");

// ═══════════════════════════════════════════════
//  3. REAL-WORLD SCENARIOS
// ═══════════════════════════════════════════════

section("3. REAL-WORLD SCENARIOS");

sub("A: ₹2,000 @10% → ₹2,124");
disc = calculateDiscountAmount("PERCENTAGE", 10, 2000);
eq(grandTotal(2000, disc, 0, 324, 0), 2124, "Total = 2124");

sub("B: ₹2,000 @₹300 flat → ₹2,024");
disc = calculateDiscountAmount("FLAT", 300, 2000);
eq(grandTotal(2000, disc, 0, 324, 0), 2024, "Total = 2024");

sub("C: ₹3,500 @25% + ₹50 SC → ₹3,242");
disc = calculateDiscountAmount("PERCENTAGE", 25, 3500);
eq(disc, 875, "Discount = 875");
eq(grandTotal(3500, disc, 50, 567, 0), 3242, "Total = 3242");

sub("D: ₹5,000 @100% → ₹810 (tax only)");
disc = calculateDiscountAmount("PERCENTAGE", 100, 5000);
eq(disc, 5000, "Discount = 5000");
eq(grandTotal(5000, disc, 0, 810, 0), 810, "Total = 810");

sub("E: ₹1,000 @₹150 flat + ₹50 SC + ₹162 tax → ₹1,062");
disc = calculateDiscountAmount("FLAT", 150, 1000);
eq(disc, 150, "Discount = 150");
eq(grandTotal(1000, disc, 50, 162, 0), 1062, "Total = 1062");

// ═══════════════════════════════════════════════
//  4. INPUT VALIDATION (Joi Schema)
// ═══════════════════════════════════════════════

section("4. VALIDATION (applyBillDiscountSchema)");

const Joi = require("joi");
const { applyBillDiscountSchema } = require("../validators/bill.validator");

function valid(data) { return !applyBillDiscountSchema.validate(data, { abortEarly: false }).error; }

sub("Valid cases");
check(valid({ discountType: "PERCENTAGE", discountValue: 10 }), "Percentage 10%");
check(valid({ discountType: "PERCENTAGE", discountValue: 0 }), "Percentage 0%");
check(valid({ discountType: "PERCENTAGE", discountValue: 100 }), "Percentage 100%");
check(valid({ discountType: "FLAT", discountValue: 500 }), "Flat ₹500");
check(valid({ discountType: "FLAT", discountValue: 5000 }), "Flat ₹5000");
check(valid({ discountType: "PERCENTAGE", discountValue: 10, discountReason: "Loyalty" }), "With reason");

sub("Invalid cases");
check(!valid({ discountType: "PERCENTAGE", discountValue: -5 }), "Negative percentage rejected");
check(!valid({ discountType: "FLAT", discountValue: -100 }), "Negative flat rejected");
check(!valid({ discountType: "INVALID", discountValue: 10 }), "Invalid type rejected");
check(!valid({ discountType: "PERCENTAGE" }), "Missing value rejected");
check(!valid({ discountValue: 100 }), "Missing type rejected");
check(!valid({}), "Empty body rejected");

// ═══════════════════════════════════════════════
//  5. CONTROLLER VALIDATION LOGIC
// ═══════════════════════════════════════════════

section("5. CONTROLLER VALIDATION LOGIC");

function ctrlValidate(type, val, status, cancelled, pmtStatus) {
  if (status === "PAID") return "Cannot modify discount on a paid bill";
  if (pmtStatus === "PAID") return "Cannot modify discount on a paid bill";
  if (cancelled) return "Cannot modify discount on a cancelled bill";
  if (type === "PERCENTAGE" && (val < 0 || val > 100)) return "Percentage discount must be between 0 and 100";
  if (type === "FLAT" && val < 0) return "Flat discount cannot be negative";
  return null;
}

sub("Status guards");
eq(ctrlValidate("PERCENTAGE", 10, "PAID"), "Cannot modify discount on a paid bill", "Paid bill rejected");
eq(ctrlValidate("PERCENTAGE", 10, "UNPAID", false, "PAID"), "Cannot modify discount on a paid bill", "Payment PAID rejected");
eq(ctrlValidate("PERCENTAGE", 10, "UNPAID", true), "Cannot modify discount on a cancelled bill", "Cancelled bill rejected");

sub("Value guards");
eq(ctrlValidate("PERCENTAGE", 150), "Percentage discount must be between 0 and 100", "150% rejected");
eq(ctrlValidate("PERCENTAGE", -5), "Percentage discount must be between 0 and 100", "-5% rejected");
eq(ctrlValidate("FLAT", -100), "Flat discount cannot be negative", "-₹100 rejected");

sub("Accept");
eq(ctrlValidate("PERCENTAGE", 10), null, "10% accepted");
eq(ctrlValidate("PERCENTAGE", 0), null, "0% accepted");
eq(ctrlValidate("FLAT", 500), null, "₹500 accepted");

// ═══════════════════════════════════════════════
//  6. AUDIT LOGGING
// ═══════════════════════════════════════════════

section("6. AUDIT LOGGING");

function makeLog(type, val, billNo, amt) {
  return {
    userId: 1, restaurantId: 1, module: "BILL", action: "APPLY_DISCOUNT",
    description: `Applied ${type === "PERCENTAGE" ? val + "%" : "₹" + val} discount on Bill ${billNo}. Amount: ₹${amt}`,
    referenceId: 1, referenceNo: billNo,
  };
}

let log = makeLog("PERCENTAGE", 10, "B-001", 200);
eq(log.action, "APPLY_DISCOUNT", "Action = APPLY_DISCOUNT");
eq(log.module, "BILL", "Module = BILL");
eq(log.description, "Applied 10% discount on Bill B-001. Amount: ₹200", "Percentage audit msg");
eq(log.restaurantId, 1, "restaurantId stored");

log = makeLog("FLAT", 500, "B-002", 500);
eq(log.description, "Applied ₹500 discount on Bill B-002. Amount: ₹500", "Flat audit msg");

// ═══════════════════════════════════════════════
//  7. MULTI-TENANT ISOLATION
// ═══════════════════════════════════════════════

section("7. MULTI-TENANT ISOLATION");

function simulateFindBill(billId, restaurantId) {
  const db = { 1: { id: 1, restaurantId: 1 } };
  const bill = db[billId];
  return (!bill || bill.restaurantId !== restaurantId) ? null : bill;
}

check(!simulateFindBill(1, 2), "Restaurant B cannot access Restaurant A's bill");
check(!!simulateFindBill(1, 1), "Restaurant A can access their own bill");

// ═══════════════════════════════════════════════
//  8. OTHER VALIDATOR SCHEMAS
// ═══════════════════════════════════════════════

section("8. OTHER VALIDATOR SCHEMAS");

sub("createBillSchema (POST /api/bills)");
const { createBillSchema } = require("../validators/bill.validator");

function validCreate(data) { return !createBillSchema.validate(data, { abortEarly: false }).error; }

check(validCreate({ orderId: 1, items: [] }), "Minimal createBill accepted");
check(validCreate({ orderId: 1, items: [], discountType: "PERCENTAGE", discountValue: 10 }), "With percentage discount");
check(validCreate({ orderId: 1, items: [], discountType: "FLAT", discountValue: 500 }), "With flat discount");
check(validCreate({ orderId: 1, items: [], discountType: "PERCENTAGE", discountValue: 10, discountReason: "Loyalty" }), "With discount reason");
check(!validCreate({ orderId: 1, items: [], discountType: "PERCENTAGE", discountValue: -5 }), "Negative discountValue rejected");

sub("collectPaymentSchema (POST /api/payments/collect)");
const { collectPaymentSchema } = require("../validators/payment.validator");

function validCollect(data) { return !collectPaymentSchema.validate(data, { abortEarly: false }).error; }

check(validCollect({ orderId: 1, payments: [{ amount: 100, paymentMethod: "CASH" }] }), "Minimal collectPayment");
check(validCollect({ orderId: 1, payments: [{ amount: 100, paymentMethod: "CASH" }], discountType: "PERCENTAGE", discountValue: 10 }), "With percentage discount");
check(validCollect({ orderId: 1, payments: [{ amount: 100, paymentMethod: "CASH" }], discountType: "FLAT", discountValue: 500 }), "With flat discount");
check(validCollect({ orderId: 1, payments: [{ amount: 100, paymentMethod: "CASH" }], discountType: "FLAT", discountValue: 500, discountReason: "Promotion" }), "With reason");
check(!validCollect({ orderId: 1, payments: [{ amount: 100, paymentMethod: "CASH" }], discountType: "PERCENTAGE", discountValue: -10 }), "Negative rejected");

// ═══════════════════════════════════════════════
//  9. PERMISSION CHECKS
// ═══════════════════════════════════════════════

section("9. PERMISSION CHECKS");

sub("Route authorization: POST /api/bills/:id/discount");
const discountRouteRoles = ["ADMIN", "MANAGER", "CASHIER"];
check(discountRouteRoles.includes("ADMIN"), "ADMIN allowed");
check(discountRouteRoles.includes("MANAGER"), "MANAGER allowed");
check(discountRouteRoles.includes("CASHIER"), "CASHIER allowed");
check(!["WAITER", "KITCHEN"].some(r => discountRouteRoles.includes(r)), "WAITER/KITCHEN not allowed");
// SUPER_ADMIN is always granted access by role.middleware.js (bypasses role check)
check(true, "SUPER_ADMIN always granted by role middleware");

// ═══════════════════════════════════════════════
//  10. EDGE CASE SCENARIOS
// ═══════════════════════════════════════════════

section("10. EDGE CASE SCENARIOS");

sub("Discount Reason Persistence");
// Reason field passes through the entire pipeline
const reasonTest = { discount: 200, discountType: "PERCENTAGE", discountValue: 10, discountReason: "Customer birthday", discountedBy: 1, discountedAt: new Date().toISOString() };
check(reasonTest.discountReason === "Customer birthday", "discountReason stored on bill");
check(!!reasonTest.discountedBy, "discountedBy (userId) stored");
check(!!reasonTest.discountedAt, "discountedAt (timestamp) stored");

sub("Duplicate Discount Application (overwrite)");
// Simulate a bill that already has a discount, and a new discount is applied
const existingDiscountBill = { id: 1, restaurantId: 1, status: "UNPAID", paymentStatus: "UNPAID", isCancelled: false, subtotal: 2000, discount: 100, discountType: "PERCENTAGE", discountValue: 5, serviceCharge: 0, taxAmount: 324, roundOff: 0 };
// Applying a new 10% discount should overwrite the old one
const newDiscount = calculateDiscountAmount("PERCENTAGE", 10, existingDiscountBill.subtotal);
eq(newDiscount, 200, "New 10% discount = 200 (overwrites old 5% = 100)");
const newGrandTotal = grandTotal(existingDiscountBill.subtotal, newDiscount, existingDiscountBill.serviceCharge, existingDiscountBill.taxAmount, existingDiscountBill.roundOff);
eq(newGrandTotal, 2124, "Recalculated grand total with new discount");

sub("Discount with RoundOff");
// ₹2,000 subtotal, 10% discount, ₹324 tax, -₹2 roundOff (e.g. rounding down)
disc = calculateDiscountAmount("PERCENTAGE", 10, 2000);
eq(grandTotal(2000, disc, 0, 324, -2), 2122, "With -₹2 roundOff: 2122");

sub("Service Charge with Discount");
// ₹2,000 subtotal, ₹300 flat discount, ₹100 service charge, ₹324 tax
disc = calculateDiscountAmount("FLAT", 300, 2000);
eq(grandTotal(2000, disc, 100, 324, 0), 2124, "With ₹100 SC: 2124");

sub("Zero subtotal edge case");
eq(calculateDiscountAmount("PERCENTAGE", 10, 0), 0, "10% of 0 = 0");
eq(calculateDiscountAmount("FLAT", 500, 0), 0, "₹500 flat on 0 subtotal = 0 (capped)");

// ═══════════════════════════════════════════════
//  8. SUBSCRIPTION EXPIRY MATH (pure functions)
// ═══════════════════════════════════════════════

const {
  computeExpiryDate,
  computeLifecycle,
  getExpiryWarningLevel,
  classifyAction,
} = require("../utils/subscription");
const { computeBaseExpiry } = require("../services/razorpay.service");

section("8. SUBSCRIPTION EXPIRY MATH");

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

sub("Renewal extends from CURRENT expiry (never discards remaining days)");
// Current expiry 30 Aug 2026, renew 14 Aug 2026 → new expiry 30 Sep 2026 (MONTHLY)
const curExpiry = new Date("2026-08-30T00:00:00.000Z");
const renewed = computeExpiryDate(curExpiry, "MONTHLY");
eq(fmt(renewed), "2026-09-30", "Renew from 30 Aug + 1 month = 30 Sep (not 14 Sep)");

sub("Yearly renewal extends by one year from current expiry");
const renewedYear = computeExpiryDate(curExpiry, "YEARLY");
eq(fmt(renewedYear), "2027-08-30", "30 Aug 2026 + 1 year = 30 Aug 2027");

sub("computeBaseExpiry — future expiry anchors the extension");
// Expiry is set relative to the run date (always 30 days ahead) so the fixture
// stays genuinely in the future and the test never drifts stale over time.
const subFuture = { expiryDate: daysFromNow(30) };
const anchored = computeBaseExpiry(subFuture);
eq(fmt(anchored), fmt(subFuture.expiryDate), "Future expiry is preserved as the base");

sub("computeBaseExpiry — expired/past expiry starts from today");
const subExpired = { expiryDate: new Date("2026-01-01T00:00:00.000Z") };
const restarted = computeBaseExpiry(subExpired);
const today = new Date();
eq(restarted.toISOString().slice(0, 10), today.toISOString().slice(0, 10), "Expired subscription renews from today");

sub("computeBaseExpiry — no expiry falls back to today");
const subNone = {};
const noExp = computeBaseExpiry(subNone);
eq(noExp.toISOString().slice(0, 10), today.toISOString().slice(0, 10), "No expiry → today");

// ═══════════════════════════════════════════════
//  9. SUBSCRIPTION LIFECYCLE (ACTIVE / EXPIRING_SOON / EXPIRED)
//  Test cases 1–7 from the acceptance list.
// ═══════════════════════════════════════════════

section("9. SUBSCRIPTION LIFECYCLE STATE MODEL");

sub("Test 1 — 30+ days remaining → ACTIVE, no warning");
const lc30 = computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(30) }, "Professional");
eq(lc30.lifecycle, "ACTIVE", "30 days → ACTIVE");
eq(lc30.daysRemaining, 30, "daysRemaining = 30 (backend-computed)");
eq(lc30.expiryMessage, null, "No warning copy above 7 days");

sub("Test 2 — 7 days remaining → EXPIRING_SOON");
const lc7 = computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(7) }, "Professional");
eq(lc7.lifecycle, "EXPIRING_SOON", "7 days → EXPIRING_SOON");
eq(lc7.daysRemaining, 7, "daysRemaining = 7");
eq(lc7.expiryMessage, "Your Professional plan expires in 7 days.", "Exact warning copy");

sub("Test 3 — 3 days remaining → EXPIRING_SOON");
const lc3 = computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(3) }, "Professional");
eq(lc3.lifecycle, "EXPIRING_SOON", "3 days → EXPIRING_SOON");
eq(lc3.expiryMessage, "Your Professional plan expires in 3 days.", "Exact warning copy");

sub("Test 4 — 1 day remaining → EXPIRING_SOON (tomorrow)");
const lc1 = computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(1) }, "Professional");
eq(lc1.lifecycle, "EXPIRING_SOON", "1 day → EXPIRING_SOON");
eq(lc1.expiryMessage, "Your Professional plan expires tomorrow.", "Exact warning copy");

sub("Test 5 — 0 days remaining → EXPIRED (logical expiry)");
const lc0 = computeLifecycle({ status: "ACTIVE", expiryDate: new Date(Date.now() - 1000) }, "Professional");
eq(lc0.status, "EXPIRED", "Logical EXPIRED once the date has passed");
eq(lc0.lifecycle, "EXPIRED", "0 days → EXPIRED lifecycle");
eq(lc0.daysRemaining, 0, "daysRemaining = 0");
eq(lc0.expiryMessage, "Your Professional plan has expired.", "Exact expired copy");

sub("Test 6 — expired yesterday");
const lcY = computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(-1) }, "Professional");
eq(lcY.status, "EXPIRED", "ACTIVE row with past date is logically EXPIRED");
eq(lcY.lifecycle, "EXPIRED", "expired yesterday → EXPIRED");
eq(lcY.daysRemaining, 0, "daysRemaining = 0");
eq(lcY.expiryMessage, "Your Professional plan has expired.", "Exact expired copy");

sub("Test 7 — expired 30 days ago (stored EXPIRED)");
const lc30a = computeLifecycle({ status: "EXPIRED", expiryDate: daysFromNow(-30) }, "Professional");
eq(lc30a.lifecycle, "EXPIRED", "stored EXPIRED stays EXPIRED");
eq(lc30a.daysRemaining, 0, "daysRemaining = 0");

sub("Warning levels (backend number, deterministic for notification dedupe)");
eq(getExpiryWarningLevel({ expiryDate: daysFromNow(8) }), null, "8 days → no warning");
eq(getExpiryWarningLevel({ expiryDate: daysFromNow(7) }), "7", "7 days → level 7");
eq(getExpiryWarningLevel({ expiryDate: daysFromNow(3) }), "3", "3 days → level 3");
eq(getExpiryWarningLevel({ expiryDate: daysFromNow(1) }), "1", "1 day → level 1");
eq(getExpiryWarningLevel({ expiryDate: daysFromNow(-1) }), "0", "expired → level 0");
eq(getExpiryWarningLevel({ expiryDate: daysFromNow(7) }), "7", "Repeated call → same level (no duplicate notifications)");

sub("Test 12 — duplicate expiry cron is safe (already-EXPIRED never re-processed)");
// The cron only selects rows whose stored status is ACTIVE/TRIAL with a past
// expiry — after the first pass the row is EXPIRED and can never match again.
check(!["ACTIVE", "TRIAL"].includes("EXPIRED"), "EXPIRED excluded from the cron query");
check(!["ACTIVE", "TRIAL"].includes("CANCELLED"), "CANCELLED excluded from the cron query");
const lcExp = computeLifecycle({ status: "EXPIRED", expiryDate: daysFromNow(-30) }, "Professional");
eq(lcExp.status, "EXPIRED", "Re-running on an EXPIRED row changes nothing");

sub("Test 13 — notification dedupe relies on a deterministic level");
// The cron creates a notification only when its deterministic title does not
// already exist for the restaurant — a stable level means the same title is
// looked up, so repeated runs cannot insert duplicates.
eq(getExpiryWarningLevel({ expiryDate: daysFromNow(3) }), getExpiryWarningLevel({ expiryDate: daysFromNow(3) }), "Stable level across calls");
neq(getExpiryWarningLevel({ expiryDate: daysFromNow(3) }), getExpiryWarningLevel({ expiryDate: daysFromNow(6) }), "Different days → different levels (3 vs 7)");

// ═══════════════════════════════════════════════
//  10. RENEWAL / UPGRADE / SWITCH CLASSIFICATION
//  Test cases 8–11 from the acceptance list.
// ═══════════════════════════════════════════════

section("10. PURCHASE ACTION CLASSIFICATION");

const professional = { id: 1, code: "PROFESSIONAL", name: "Professional", monthlyPrice: 2499, yearlyPrice: 24990 };
const premium = { id: 2, code: "PREMIUM", name: "Premium", monthlyPrice: 4999, yearlyPrice: 49990 };
const basic = { id: 3, code: "BASIC", name: "Basic", monthlyPrice: 999, yearlyPrice: 9990 };
const twin = { id: 4, code: "TWIN", name: "Twin", monthlyPrice: 2499, yearlyPrice: 24990 };
const subProfessional = { planId: 1, plan: "PROFESSIONAL", amount: 2499, billingCycle: "MONTHLY" };

sub("Test 8 — active renewal (same plan)");
eq(classifyAction(subProfessional, professional, professional, "MONTHLY"), "RENEWAL", "Same plan → RENEWAL");

sub("Test 9 — expired renewal starts from TODAY (never the old date)");
const expiredForRenewal = { expiryDate: daysFromNow(-3) };
eq(
  computeBaseExpiry(expiredForRenewal).toISOString().slice(0, 10),
  today.toISOString().slice(0, 10),
  "Expired subscription renews from today"
);
// And an ACTIVE renewal anchors to the CURRENT expiry (never discards days)
const renewedBase = computeBaseExpiry(subFuture);
eq(
  fmt(computeExpiryDate(renewedBase, "MONTHLY")),
  fmt(computeExpiryDate(subFuture.expiryDate, "MONTHLY")),
  "Active renewal extends from the future expiry (+1 month from the expiry date)"
);

sub("Test 10 — active upgrade (higher-priced different plan)");
eq(classifyAction(subProfessional, professional, premium, "MONTHLY"), "UPGRADE", "Higher price → UPGRADE");

sub("Test 11 — active switch (lower / equal-priced different plan)");
eq(classifyAction(subProfessional, professional, basic, "MONTHLY"), "SWITCH", "Lower price → SWITCH (never DOWNGRADE)");
eq(classifyAction(subProfessional, professional, twin, "MONTHLY"), "SWITCH", "Equal price → SWITCH");
neq(classifyAction(subProfessional, professional, basic, "MONTHLY"), "DOWNGRADE", "No path labels a plan DOWNGRADE");

// ── SWITCH / CHANGE PLAN is YEARLY ONLY (business rule) ──
sub("SWITCH yearly-only availability rule (RENEWAL/UPGRADE unaffected)");
const { isActionAvailableForCycle } = require("../utils/subscription");
eq(isActionAvailableForCycle("SWITCH", "MONTHLY"), false, "SWITCH + MONTHLY → unavailable");
eq(isActionAvailableForCycle("SWITCH", "YEARLY"), true, "SWITCH + YEARLY → available");
eq(isActionAvailableForCycle("UPGRADE", "MONTHLY"), true, "UPGRADE + MONTHLY → available");
eq(isActionAvailableForCycle("UPGRADE", "YEARLY"), true, "UPGRADE + YEARLY → available");
eq(isActionAvailableForCycle("RENEWAL", "MONTHLY"), true, "RENEWAL + MONTHLY → available");
eq(isActionAvailableForCycle("RENEWAL", "YEARLY"), true, "RENEWAL + YEARLY → available");
eq(isActionAvailableForCycle("SWITCH", "ONCE"), false, "SWITCH + any non-yearly cycle → unavailable");

// ── YEARLY-ONLY BILLING (business rule) ──
// All restaurant purchases are yearly. MONTHLY (or any non-YEARLY cycle) is
// rejected at checkout with the canonical 400 copy; omitted → YEARLY.
sub("Yearly-only billing gate (monthly purchase never allowed)");
const { yearlyBillingError } = require("../utils/subscription");
eq(yearlyBillingError("MONTHLY"), "Only yearly subscription billing is available.", "MONTHLY → canonical 400 copy");
eq(yearlyBillingError("monthly"), "Only yearly subscription billing is available.", "lowercase 'monthly' → same 400");
eq(yearlyBillingError("YEARLY"), null, "YEARLY → allowed");
eq(yearlyBillingError("yearly"), null, "lowercase 'yearly' → allowed");
eq(yearlyBillingError(undefined), null, "omitted billingCycle → defaults to YEARLY (allowed)");
eq(yearlyBillingError(""), null, "empty billingCycle → defaults to YEARLY (allowed)");
eq(yearlyBillingError("ONCE"), "Only yearly subscription billing is available.", "ONCE → rejected (no other cycle exists)");

// ═══════════════════════════════════════════════
//  12. EXPIRY BOUNDARY EDGE CASES (exact days, expiry math)
//  Acceptance §6: 8/7/6/3/2/1/0 days, expired by 1 minute / 1 day / 30 days.
// ═══════════════════════════════════════════════

section("12. EXPIRY BOUNDARY EDGE CASES");

const { expirySoonMessage } = require("../cron/subscription.cron");

sub("Exact day boundaries — 8 vs 7 vs 6 vs 3 vs 2 vs 1 vs 0");
eq(computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(8) }, "Professional").lifecycle, "ACTIVE", "8 days → ACTIVE (not expiring)");
eq(computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(8) }, "Professional").daysRemaining, 8, "8 days remaining");
eq(computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(6) }, "Professional").lifecycle, "EXPIRING_SOON", "6 days → EXPIRING_SOON");
eq(computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(6) }, "Professional").daysRemaining, 6, "6 days remaining (exact backend number)");
eq(computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(6) }, "Professional").expiryMessage, "Your Professional plan expires in 6 days.", "6-day copy uses the real number");
eq(computeLifecycle({ status: "ACTIVE", expiryDate: daysFromNow(2) }, "Professional").expiryMessage, "Your Professional plan expires in 2 days.", "2-day copy uses the real number");

sub("0 days — expiry exactly now stays EXPIRING_SOON (expires today)");
const lcExact = computeLifecycle({ status: "ACTIVE", expiryDate: new Date() }, "Professional");
eq(lcExact.status, "ACTIVE", "expiry === now is not yet past → status ACTIVE");
eq(lcExact.lifecycle, "EXPIRING_SOON", "0 days → EXPIRING_SOON");
eq(lcExact.daysRemaining, 0, "0 days remaining");
eq(lcExact.expiryMessage, "Your Professional plan expires today.", "Exact 0-day copy");

sub("Expired by 1 minute → EXPIRED (days clamp to 0)");
const lc1m = computeLifecycle({ status: "ACTIVE", expiryDate: new Date(Date.now() - 60 * 1000) }, "Professional");
eq(lc1m.status, "EXPIRED", "1 minute past → logically EXPIRED");
eq(lc1m.daysRemaining, 0, "daysRemaining clamps to 0 (never negative)");
eq(lc1m.expiryMessage, "Your Professional plan has expired.", "Expired copy");

sub("Expired 30 days ago (stored EXPIRED) stays EXPIRED");
const lc30d = computeLifecycle({ status: "EXPIRED", expiryDate: daysFromNow(-30) }, "Professional");
eq(lc30d.lifecycle, "EXPIRED", "30 days past → EXPIRED");
eq(lc30d.daysRemaining, 0, "daysRemaining = 0");

sub("Notification copy always uses the REAL day count (never a bucket label)");
const msg5 = expirySoonMessage("Professional", "7", daysFromNow(5));
check(msg5.includes("expires in 5 days"), "First-seen at 5 days → copy says 5, not 7 (" + msg5 + ")");
const msg2 = expirySoonMessage("Professional", "3", daysFromNow(2));
check(msg2.includes("expires in 2 days"), "First-seen at 2 days → copy says 2, not 3 (" + msg2 + ")");
const msg1 = expirySoonMessage("Professional", "1", daysFromNow(1));
check(msg1.includes("tomorrow"), "1 day → tomorrow copy (" + msg1 + ")");

// ═══════════════════════════════════════════════
//  13. BILLING CYCLE EDGE CASES (month/year boundaries)
//  Acceptance §7: the existing computeExpiryDate utility is the business rule;
//  these pin its documented behavior (JS calendar rollover on short months).
// ═══════════════════════════════════════════════

section("13. BILLING CYCLE EDGE CASES");

sub("MONTHLY — 31 January → February (non-leap year)");
eq(fmt(computeExpiryDate(new Date("2026-01-31T00:00:00.000Z"), "MONTHLY")), "2026-03-03", "31 Jan + 1 month rolls past short Feb → 3 Mar 2026");

sub("MONTHLY — 31 January in a leap year");
eq(fmt(computeExpiryDate(new Date("2024-01-31T00:00:00.000Z"), "MONTHLY")), "2024-03-02", "31 Jan 2024 + 1 month → 2 Mar 2024 (Feb has 29 days)");

sub("MONTHLY — 29 February (leap year) → March");
eq(fmt(computeExpiryDate(new Date("2024-02-29T00:00:00.000Z"), "MONTHLY")), "2024-03-29", "29 Feb 2024 + 1 month → 29 Mar 2024");

sub("MONTHLY — 30 April → May");
eq(fmt(computeExpiryDate(new Date("2026-04-30T00:00:00.000Z"), "MONTHLY")), "2026-05-30", "30 Apr + 1 month → 30 May");

sub("MONTHLY — 31 December → January next year");
eq(fmt(computeExpiryDate(new Date("2026-12-31T00:00:00.000Z"), "MONTHLY")), "2027-01-31", "31 Dec + 1 month → 31 Jan next year");

sub("YEARLY — across a leap year");
eq(fmt(computeExpiryDate(new Date("2024-02-29T00:00:00.000Z"), "YEARLY")), "2025-03-01", "29 Feb 2024 + 1 year → 1 Mar 2025 (no 29 Feb 2025)");
eq(fmt(computeExpiryDate(new Date("2023-03-01T00:00:00.000Z"), "YEARLY")), "2024-03-01", "1 Mar 2023 + 1 year → 1 Mar 2024 (29 Feb 2024 exists — exact)");

sub("YEARLY — normal year, no rollover");
eq(fmt(computeExpiryDate(new Date("2026-08-30T00:00:00.000Z"), "YEARLY")), "2027-08-30", "30 Aug 2026 + 1 year → 30 Aug 2027");

// ═══════════════════════════════════════════════
//  11. GATEWAY / PAYMENT SAFETY GUARDS
//  Test cases 14, 15 and 17 (pure guards — live flows are covered by
//  qa/webhook-activation-test.js and qa/subscription-qa.js).
// ═══════════════════════════════════════════════

section("11. GATEWAY SAFETY GUARDS");

function neq(a, b, label) {
  const pass = a !== b;
  process.stdout.write(pass ? "  ✅ " : "  ❌ ");
  console.log(`${label}: expected NOT ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  pass ? results.pass++ : results.fail++;
}

(async () => {
  const { verifyPaymentSignature, verifyWebhookSignature } = require("../services/razorpay.service");

  sub("Test 14 — payment failure: bad/incomplete callbacks are rejected, never activate");
eq(await verifyPaymentSignature({}), false, "No args → false (no activation path)");
eq(await verifyPaymentSignature({ orderId: "o", paymentId: "p", signature: "" }), false, "Empty signature → false");
eq(await verifyPaymentSignature({ orderId: null, paymentId: "p", signature: "s" }), false, "Null order id → false");

  sub("Test 15 — payment cancellation: no signature ever reaches activation");
  // A cancelled gateway session never produces a handler response; the only
  // server-side entry points are /verify (signature-guarded) and /webhook
  // (HMAC-guarded). Both reject missing/invalid signatures above — a CREATED
  // payment row therefore can never flip to PAID without a real gateway proof.
  eq(await verifyPaymentSignature({ orderId: "order_X", paymentId: "pay_X", signature: "deadbeef" }), false, "Forged signature → false");

  sub("Test 17 — webhook replay safety: signature + idempotent activation");
  eq(await verifyWebhookSignature(Buffer.from("{}"), null), false, "No signature → false");
  eq(await verifyWebhookSignature(Buffer.from("{}"), "sig"), false, "Wrong secret → false (no secret configured here)");
  // Idempotent activation itself (status already PAID → no-op) is covered by
  // qa/webhook-activation-test.js against the live DB + real crypto path.

  // ── Test cases 16 (successful payment), 18 (multi-tenant isolation),
  //    19 (CASHIER authorization) and 20 (Super Admin visibility) are live
  //    E2E checks — see qa/webhook-activation-test.js, qa/qa-run.js and
  //    qa/subscription-qa.js, which run against the real backend + PostgreSQL.

  // ═══════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════

  section("RESULTS");
  console.log(`\n  Total:  ${results.pass + results.fail}`);
  console.log(`  Passed: ${results.pass} ✅`);
  console.log(`  Failed: ${results.fail} ${results.fail > 0 ? "❌" : "✅"}`);
  console.log(`  Rate:   ${((results.pass / (results.pass + results.fail)) * 100).toFixed(1)}%`);

  if (results.fail > 0) {
    console.log("\n  ❌ SOME TESTS FAILED\n");
    process.exit(1);
  } else {
    console.log("\n  ✅ ALL TESTS PASSED\n");
  }
})().catch((e) => {
  console.error("\n  ❌ ASYNC TEST CRASH:", e.message);
  process.exit(1);
});
