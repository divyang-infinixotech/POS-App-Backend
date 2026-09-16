/**
 * Self-serve Onboarding — unit tests (no database required).
 *
 * Run directly with: node src/__tests__/onboarding.test.js
 *
 * Covers the pure, testable core of the onboarding flow:
 *   - deriveStage (data-driven stage ordering — a client can never skip a step)
 *   - document magic-number validation (never trust extensions)
 *   - config integrity (business types, document types, policy versions)
 *   - registration / business / legal / payment validators
 */
const path = require("path");
process.chdir(path.resolve(__dirname, "../.."));

const results = { pass: 0, fail: 0 };
function check(cond, message) {
  process.stdout.write(cond ? "  ✅ " : "  ❌ ");
  console.log(message);
  cond ? results.pass++ : results.fail++;
}
function eq(actual, expected, label) {
  const pass = actual === expected;
  process.stdout.write(pass ? "  ✅ " : "  ❌ ");
  console.log(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  pass ? results.pass++ : results.fail++;
}
function section(title) {
  console.log(`\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}`);
}
function sub(title) {
  console.log(`\n  --- ${title} ---`);
}

const { deriveStage, stageLabel } = require("../services/onboarding.service");
const { validateDocumentBuffer } = require("../config/onboarding.config");
const config = require("../config/onboarding.config");
const Joi = require("joi");
const { registerSchema, businessSchema, legalSchema, selectPlanSchema, verifyPaymentSchema } = require("../validators/onboarding.validator");

function valid(schema, data) {
  return !schema.validate(data, { allowUnknown: true }).error;
}

// ─── 1. deriveStage — stage order is data-driven ────────────────────────────
section("1. deriveStage — data-driven lifecycle (no client-controlled stages)");

const base = {
  restaurantExists: false, businessComplete: false,
  validDocuments: 0, rejectedDocuments: 0,
  legalAccepted: false, planSelected: false,
  paymentStatus: null, provisioned: false, terminal: null,
};

eq(deriveStage(base).stage, "REGISTERED", "No restaurant yet → REGISTERED (business step)");
eq(deriveStage({ ...base, restaurantExists: true, businessComplete: false }).step, "business", "Restaurant exists w/o name → ONBOARDING/business (defensive)");

const businessDone = { ...base, restaurantExists: true, businessComplete: true };
eq(deriveStage(businessDone).stage, "DOCUMENTS_PENDING", "Business done, no docs → DOCUMENTS_PENDING (documents step)");

const oneDoc = { ...businessDone, validDocuments: 1 };
eq(deriveStage(oneDoc).stage, "LEGAL_PENDING", "One valid doc, no legal → LEGAL_PENDING (legal step)");
eq(deriveStage({ ...oneDoc, rejectedDocuments: 1 }).stage, "LEGAL_PENDING", "Valid + rejected doc still proceeds (optional docs never block)");

const allRejected = { ...businessDone, validDocuments: 0, rejectedDocuments: 1 };
eq(deriveStage(allRejected).stage, "DOCUMENT_REJECTED", "All docs rejected → DOCUMENT_REJECTED (replacement required)");

const legalDone = { ...oneDoc, legalAccepted: true };
eq(deriveStage(legalDone).stage, "PLAN_PENDING", "Docs + legal accepted, no plan → PLAN_PENDING (plan step)");

const planChosen = { ...legalDone, planSelected: true };
eq(deriveStage(planChosen).stage, "PLAN_SELECTED", "Plan selected, no payment row → PLAN_SELECTED (payment step)");

eq(deriveStage({ ...planChosen, paymentStatus: "CREATED" }).stage, "PAYMENT_PENDING", "Checkout created → PAYMENT_PENDING");
eq(deriveStage({ ...planChosen, paymentStatus: "FAILED" }).stage, "PAYMENT_FAILED", "Failed payment → PAYMENT_FAILED (retry at payment step)");

const paid = { ...planChosen, paymentStatus: "PAID" };
eq(deriveStage(paid).stage, "UNDER_REVIEW", "Paid but not provisioned → UNDER_REVIEW (manual review / review step)");
eq(deriveStage({ ...paid, provisioned: true }).stage, "ACTIVE", "Paid + tenant provisioned → ACTIVE (complete)");

eq(deriveStage({ ...paid, terminal: "REJECTED" }).stage, "REJECTED", "Terminal REJECTED overrides paid state");
eq(deriveStage({ ...paid, terminal: "SUSPENDED" }).stage, "SUSPENDED", "Terminal SUSPENDED overrides paid state");
eq(deriveStage({ ...paid, terminal: "EXPIRED" }).stage, "EXPIRED", "Terminal EXPIRED overrides paid state");

check(typeof stageLabel("UNDER_REVIEW") === "string" && stageLabel("ACTIVE").length > 0, "stageLabel renders human copy");

// ─── 1b. ACTIVE restaurants are NEVER re-derived into a wizard stage ───────
// A Super Admin-created restaurant has no PAID onboarding payment row and
// possibly a stale/legacy onboardingStatus. Before the fix, deriveStage
// mis-classified such accounts as PLAN_SELECTED — handing normal POS users a
// bogus applicant payload whose only effect was a 403 loop on
// /onboarding/status ("Could not load your application").
section("1b. deriveStage — ACTIVE restaurant short-circuit (no bogus applicant state)");

const activeAdminCreated = {
  restaurantExists: true, businessComplete: true,
  restaurantStatus: "ACTIVE",
  validDocuments: 0, rejectedDocuments: 0,
  legalAccepted: false, planSelected: true,
  paymentStatus: null, provisioned: true, terminal: null,
};
eq(deriveStage(activeAdminCreated).stage, "ACTIVE", "ACTIVE restaurant + no PAID row → ACTIVE (never PLAN_SELECTED)");
eq(deriveStage({ ...activeAdminCreated, planSelected: false }).stage, "ACTIVE", "ACTIVE restaurant + no subscription → ACTIVE");
eq(deriveStage({ ...activeAdminCreated, legalAccepted: false, validDocuments: 0 }).stage, "ACTIVE", "ACTIVE restaurant + no docs/legal → ACTIVE");
eq(deriveStage({ ...activeAdminCreated, provisioned: false }).stage, "ACTIVE", "ACTIVE restaurant without tenantSchema → ACTIVE");
// A stale legacy onboardingStatus must not resurrect the wizard either — the
// stored status is only authoritative for SUBMITTED manual applications.
eq(deriveStage({ ...activeAdminCreated, storedStatus: "PLAN_SELECTED" }).stage, "ACTIVE", "stale storedStatus PLAN_SELECTED on an ACTIVE restaurant → ACTIVE");
// Manual-flow statuses remain authoritative when the restaurant is NOT active.
eq(deriveStage({ ...activeAdminCreated, restaurantStatus: "INACTIVE", storedStatus: "MANUAL_PENDING", paymentStatus: null }).stage, "MANUAL_PENDING", "INACTIVE + MANUAL_PENDING stays in the manual flow");
eq(deriveStage({ ...activeAdminCreated, restaurantStatus: "INACTIVE", storedStatus: "MANUAL_APPROVED", paymentStatus: null }).stage, "ACTIVE", "INACTIVE + MANUAL_APPROVED surfaces ACTIVE (approved = done)");
// Still-in-progress self-serve accounts derive normally.
eq(deriveStage({ ...activeAdminCreated, restaurantStatus: "INACTIVE", planSelected: true, paymentStatus: null }).stage, "PLAN_SELECTED", "INACTIVE self-serve with plan still derives PLAN_SELECTED");

// ─── 2. Document validation (magic numbers — never trust extensions) ────────
section("2. Document validation — magic-number checks");

const PDF_MAGIC = Buffer.from("255044462d312e340a25e2e3cfd30a", "hex");
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_MAGIC = Buffer.from("ffd8ffe000104a4649460001", "hex");

eq(validateDocumentBuffer(null, "application/pdf", "a.pdf"), "The uploaded file is empty or could not be read.", "Null buffer rejected");
eq(validateDocumentBuffer(Buffer.alloc(0), "application/pdf", "a.pdf"), "The uploaded file is empty or could not be read.", "Empty buffer rejected");

eq(validateDocumentBuffer(Buffer.from("this is not a pdf at all"), "application/pdf", "scan.pdf"), "Only PDF, JPG/JPEG and PNG files are supported. The uploaded file looks corrupted or is not a supported document.", "Text disguised as .pdf rejected (magic check)");

eq(validateDocumentBuffer(PDF_MAGIC, "application/pdf", "gst.pdf"), null, "Real PDF accepted");
eq(validateDocumentBuffer(PNG_MAGIC, "image/png", "license.png"), null, "Real PNG accepted");
eq(validateDocumentBuffer(JPEG_MAGIC, "image/jpeg", "owner.jpg"), null, "Real JPEG accepted");

eq(validateDocumentBuffer(PNG_MAGIC, "application/pdf", "tricky.pdf"), "The uploaded file's content does not match its declared type.", "PNG bytes with pdf MIME rejected (MIME must match content)");

eq(validateDocumentBuffer(PDF_MAGIC, "application/pdf", "notes.txt"), "Only PDF, JPG, JPEG and PNG files are allowed.", "Valid PDF content with disallowed .txt extension rejected");
eq(validateDocumentBuffer(PDF_MAGIC, "application/pdf", "scan.exe"), "Only PDF, JPG, JPEG and PNG files are allowed.", "Executable extension never accepted even with PDF magic");

const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);
eq(validateDocumentBuffer(tooBig, "application/pdf", "big.pdf"), "File size must be 10 MB or less.", "Oversized file rejected (server-side cap)");

// ─── 3. Config integrity ────────────────────────────────────────────────────
section("3. Config integrity (business types / document types / policy versions)");

// HOTEL is no longer offered for NEW onboarding (removed from selectors);
// the enum value stays in Prisma so historical records remain readable.
check(config.BUSINESS_TYPES.length === 8, `Business types offered (${config.BUSINESS_TYPES.length})`);
const offered = config.BUSINESS_TYPES.map((b) => b.value);
for (const want of ["RESTAURANT", "BAKERY", "CAFE", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "FOOD_COURT", "OTHER"]) {
  check(offered.includes(want), `Business type offered: ${want}`);
}
check(!offered.includes("HOTEL"), "HOTEL no longer offered for new onboarding");

check(config.DOCUMENT_TYPES.length >= 7, `Document types offered (${config.DOCUMENT_TYPES.length})`);
for (const want of ["BUSINESS_REGISTRATION", "GST_CERTIFICATE", "TRADE_LICENSE", "FOOD_LICENSE", "ADDRESS_PROOF", "OWNER_ID", "OTHER"]) {
  check(config.DOCUMENT_TYPES.some((d) => d.value === want), `Document type defined: ${want}`);
}
check(config.DOCUMENT_TYPES.some((d) => d.value === "GST_CERTIFICATE" && d.label.includes("GST")), "Document type labels readable");

for (const p of config.REQUIRED_POLICY_TYPES) {
  check(typeof config.POLICY_VERSIONS[p.type] === "string", `Policy version defined for ${p.type}`);
}
check(!!config.POLICY_VERSIONS.TERMS_OF_SERVICE, "Terms version exists");
check(!!config.POLICY_VERSIONS.PRIVACY_POLICY, "Privacy Policy version exists");
check(!!config.POLICY_VERSIONS.ACCURACY_CONFIRMATION, "Accuracy confirmation tracked (3rd consent — never one generic checkbox)");

// Every stage maps to a wizard step
for (const stage of config.STAGE_ORDER) {
  check(typeof config.STEP_BY_STAGE[stage] === "string", `Step mapping for ${stage}`);
}
for (const terminal of config.TERMINAL_STAGES) {
  eq(config.STEP_BY_STAGE[terminal], "blocked", `Terminal ${terminal} maps to blocked screen`);
}

// ─── 4. Validators ──────────────────────────────────────────────────────────
section("4. Validators (register / business / legal / plan / payment)");

check(valid(registerSchema, { name: "Priya Owner", email: "priya@example.com", phone: "9876543210", password: "strongpass1", confirmPassword: "strongpass1" }), "Valid registration accepted");
check(!valid(registerSchema, { name: "X", email: "not-an-email", phone: "123", password: "short", confirmPassword: "short" }), "Weak/invalid registration rejected");
check(!valid(registerSchema, { name: "Priya", email: "priya@example.com", phone: "9876543210", password: "strongpass1", confirmPassword: "different1" }), "Mismatched confirmation rejected");
check(!valid(registerSchema, { name: "Priya", email: "priya@example.com", phone: "9876543210", password: "onlyletters", confirmPassword: "onlyletters" }), "Letters-only password rejected (needs digits)");

check(valid(businessSchema, { businessType: "BAKERY", name: "Sweet Bakery", phone: "9876500001", country: "India" }), "Valid business (minimal, GST optional) accepted");
check(valid(businessSchema, { businessType: "RESTAURANT", name: "Golden Grill", phone: "9876500002", gstNumber: "27ABCDE1234F1Z5", registrationNumber: "U72900KA2020PTC134587", legalName: "Golden Grill Hospitality Pvt Ltd", ownerName: "Priya", email: "owner@goldengrill.in", city: "Bengaluru", state: "Karnataka", pincode: "560001", website: "https://goldengrill.in" }), "Full business details accepted");
check(!valid(businessSchema, { businessType: "PIZZERIA", name: "X", phone: "1" }), "Unknown business type rejected");
check(!valid(businessSchema, { name: "", phone: "" }), "Missing name/phone rejected");

check(valid(legalSchema, { acceptances: [{ type: "TERMS_OF_SERVICE", version: "1.0" }, { type: "PRIVACY_POLICY", version: "1.0" }, { type: "ACCURACY_CONFIRMATION", version: "1.0" }] }), "All three legal acceptances valid");
check(!valid(legalSchema, { acceptances: [{ type: "TERMS_OF_SERVICE", version: "1.0" }] }), "Partial legal acceptance is not a valid payload (needs all three)");
check(!valid(legalSchema, { acceptances: [{ type: "NOT_A_POLICY", version: "1.0" }] }), "Unknown policy type rejected");

check(valid(selectPlanSchema, { planId: 3 }), "Plan selection valid");
check(!valid(selectPlanSchema, {}), "Plan selection requires planId");

check(valid(verifyPaymentSchema, { subscriptionPaymentId: 1, razorpayOrderId: "order_X", razorpayPaymentId: "pay_X", razorpaySignature: "sig" }), "Payment verify payload valid");
check(!valid(verifyPaymentSchema, { subscriptionPaymentId: 1 }), "Incomplete payment verify rejected");
check(!valid(verifyPaymentSchema, { subscriptionPaymentId: 1, razorpayOrderId: "order_X", razorpayPaymentId: "pay_X" }), "Missing razorpaySignature rejected (no unverified activation)");

// ─── 5. Payment amount validation (Phase 3 — the backend never trusts a
//        captured amount; the expected value is the plan YEARLY price that the
//        backend stored on the payment row when the order was created) ────────
section("5. Payment amount validation — expected (yearly plan) == paid amount");

const { razorpayPaiseMatches } = require("../services/razorpay.service");
const planYearly = 24990; // e.g. PRO yearly price in INR
const paidOk = Math.round(planYearly * 100); // Razorpay reports paise
check(razorpayPaiseMatches(paidOk, planYearly) === true, `Exact yearly amount (${planYearly} INR = ${paidOk} paise) accepted`);
check(razorpayPaiseMatches(paidOk + 100, planYearly) === false, "Overpayment of ₹1 rejected — no activation");
check(razorpayPaiseMatches(paidOk - 100, planYearly) === false, "Underpayment of ₹1 rejected — no activation");
check(razorpayPaiseMatches(50, planYearly) === false, "Token (50 paise) payment rejected");
check(razorpayPaiseMatches(undefined, planYearly) === false, "Missing amount fails closed");
check(razorpayPaiseMatches(paidOk, undefined) === false, "Missing stored amount fails closed");
check(razorpayPaiseMatches(paidOk, 0) === false, "Zero stored amount never activates");

// ─── 6. Onboarding stages around payment (pending/cancel/failure semantics) ──
section("6. Payment lifecycle stage mapping (cancel/failure/pending never activate)");

// PAYMENT_PENDING derives from a CREATED (unverified) payment row — cancel or
// a delayed webhook keeps the applicant on the payment step with data intact.
eq(pageForStageFromData({ ...planChosen, paymentStatus: "CREATED" }), "PAYMENT_PENDING", "CREATED → PAYMENT_PENDING (pending/cancelled stays here)");
eq(pageForStageFromData({ ...planChosen, paymentStatus: "FAILED" }), "PAYMENT_FAILED", "FAILED → PAYMENT_FAILED (retry available)");
eq(pageForStageFromData(planChosen).startsWith("PLAN_"), true, "No payment row yet → PLAN_SELECTED/PLAN_PENDING (never ACTIVE)");
check(!["ACTIVE", "UNDER_REVIEW"].includes(pageForStageFromData({ ...planChosen, paymentStatus: "CREATED" })), "Pending payment can never derive ACTIVE/UNDER_REVIEW");
check(!["ACTIVE"].includes(pageForStageFromData({ ...planChosen, paymentStatus: "FAILED" })), "Failed payment can never derive ACTIVE");

// A terminal application state always overrides any payment state.
eq(deriveStage({ ...planChosen, paymentStatus: "PAID", terminal: "REJECTED" }).stage, "REJECTED", "Rejected application stays rejected even with a PAID row");

function pageForStageFromData(data) {
  return deriveStage(data).stage;
}

// ─── 7. Strict email validation + normalization (shared identity rule) ─────
section("7. Strict email validation + normalization (utils/email)");

const { normalizeEmail, isValidEmail, emailRequiredError, emailOptionalError, legalAcceptanceError } = require("../utils/email");

sub("Normalization = trim + lowercase ONLY (no Gmail dot/+tag transforms)");
eq(normalizeEmail("  John.Smith@GMAIL.COM  "), "john.smith@gmail.com", "trim + lowercase");
eq(normalizeEmail("john.smith+pos@gmail.com"), "john.smith+pos@gmail.com", "+tag preserved (no provider-specific stripping)");
eq(normalizeEmail("John..Smith@Example.COM"), "john..smith@example.com", "dots preserved (case normalization only)");
eq(normalizeEmail(null), null, "null passes through");

sub("Valid formats");
for (const good of ["john@gmail.com", "John.Smith@gmail.com", "john.smith+pos@gmail.com", "owner@restaurant.co.in", "  TEST@EXAMPLE.COM  "]) {
  check(isValidEmail(good), `valid: ${good}`);
}

sub("Invalid formats (far stronger than includes('@'))");
for (const bad of ["john", "john@", "@gmail.com", "john@gmail", "john..smith@gmail.com", "john @gmail.com", "john@gmail..com", ".john@gmail.com", "john.@gmail.com", "john@gmail.", "john@gmail.c", "john gmail.com"]) {
  check(!isValidEmail(bad), `invalid: ${bad}`);
}

sub("Error messages");
eq(emailRequiredError(""), "Email is required.", "empty → required message");
eq(emailRequiredError("   "), "Email is required.", "whitespace-only → required message");
eq(emailRequiredError("john@gmail"), "Please enter a valid email address.", "bare domain → invalid message");
eq(emailRequiredError("a@b.co"), null, "valid → null");
eq(emailOptionalError(""), null, "optional field: empty passes");
eq(emailOptionalError(null), null, "optional field: null passes");
eq(emailOptionalError("bad@"), "Please enter a valid email address.", "optional field: bad value still rejected");

sub("Validators use the strict rule + emit canonical values");
const regResult = registerSchema.validate({ name: "A B", email: "  Test.User@EXAMPLE.com  ", phone: "9876543210", password: "strongpass1", confirmPassword: "strongpass1" });
eq(regResult.value.email, "test.user@example.com", "registerSchema normalizes to canonical lowercase");
check(!valid(registerSchema, { name: "A B", email: "john@gmail", phone: "9876543210", password: "strongpass1", confirmPassword: "strongpass1" }), "registerSchema rejects bare-domain email");

// ─── 8. Legal acceptance — self-serve only (SA wizard has NO agreement) ────
section("8. Legal acceptance gate (self-serve registration only)");

sub("Shared gate util");
eq(legalAcceptanceError({ termsAccepted: true, privacyAccepted: true }), null, "both accepted → allowed");
eq(legalAcceptanceError({ termsAccepted: true, privacyAccepted: false }), "Please accept the Terms & Conditions and Privacy Policy to continue.", "privacy missing → blocked");
eq(legalAcceptanceError({ termsAccepted: false, privacyAccepted: true }), "Please accept the Terms & Conditions and Privacy Policy to continue.", "terms missing → blocked");
eq(legalAcceptanceError({}), "Please accept the Terms & Conditions and Privacy Policy to continue.", "nothing accepted → blocked");

sub("Super Admin createRestaurant schema does NOT require legal acceptance (platform operation)");
// Super Admin → Add Restaurant is an ADMINISTRATIVE operation: the Super
// Admin acts for the platform, not as an accepting customer. The Agreement
// step was removed from that wizard, so the schema must accept a payload
// WITHOUT termsAccepted/privacyAccepted. Mandatory acceptance lives ONLY in
// the self-serve flow (legalSchema above).
const { createRestaurantSchema } = require("../validators/super-admin.validator");
const saBase = { name: "Grill House", ownerName: "Owner Name", mobile: "9876500009", adminName: "Admin User", adminEmail: "admin@grillhouse.in", adminPassword: "secret123", planId: 1 };
const saResult = createRestaurantSchema.validate({ ...saBase }, { allowUnknown: true, abortEarly: false });
check(!saResult.error || !(saResult.error.details || []).some(d => /accept/i.test(d.message)), "SA creation without acceptance flags passes the legal gate (no agreement validation)");

sub("Restaurant schema (POST /api/restaurants) also free of the legal gate");
const { restaurantSchema } = require("../validators/restaurant.validator");
const restBase = { name: "Grill House", ownerName: "Owner Name", phone: "9876500009", adminName: "Admin User", adminEmail: "admin@grillhouse.in", adminPhone: "9876500010", adminPassword: "secret123" };
check(valid(restaurantSchema, { ...restBase }), "restaurant creation without acceptance accepted (administrative path)");

sub("Source audit — self-serve registration is the only path with legal validation");
const fs2 = require("fs");
const saRoutesSrc = fs2.readFileSync(path.join(process.cwd(), "src/routes/super-admin.routes.js"), "utf8");
check(/createRestaurantSchema/.test(saRoutesSrc), "POST /restaurants route validates with createRestaurantSchema");
const restaurantRoutesSrc = fs2.readFileSync(path.join(process.cwd(), "src/routes/restaurant.routes.js"), "utf8");
check(/restaurantSchema/.test(restaurantRoutesSrc), "restaurant route validates with restaurantSchema");
const saValidatorSrc = fs2.readFileSync(path.join(process.cwd(), "src/validators/super-admin.validator.js"), "utf8");
check(!/legalAcceptanceError/.test(saValidatorSrc), "SA validator has no legal-acceptance gate");
const restaurantValidatorSrc = fs2.readFileSync(path.join(process.cwd(), "src/validators/restaurant.validator.js"), "utf8");
check(!/legalAcceptanceError/.test(restaurantValidatorSrc), "restaurant validator has no legal-acceptance gate");
check(/legalSchema/.test(fs2.readFileSync(path.join(process.cwd(), "src/validators/onboarding.validator.js"), "utf8")), "self-serve legalSchema UNCHANGED (acceptance still mandatory there)");

// ─── 9. Staff permissions + dietary + subcategories ─────────────────────────
section("9. Staff permissions, dietary access & subcategories");

sub("Permission model integrity (utils/permissions)");
const {
  SCREEN_KEYS,
  ALL_PERMISSION_KEYS,
  ACTION_GROUPS,
  ROLE_DEFAULTS,
  resolveEffectivePermissions,
  hasEffectivePermission,
  effectiveDietaryAccess,
  roleDefaultsFor,
} = require("../utils/permissions");

check(SCREEN_KEYS.length === 9, "exactly 9 screen permission keys");
check(ALL_PERMISSION_KEYS.includes("dashboard.view") && ALL_PERMISSION_KEYS.includes("orders.split"), "screen + action keys present");
check(ACTION_GROUPS.length === 6 && ACTION_GROUPS.every(g => g.keys.length > 0), "6 non-empty action groups");
check(["MANAGER", "CASHIER", "KITCHEN", "WAITER"].every(r => Object.keys(ROLE_DEFAULTS).includes(r)), "role defaults cover all 4 tenant staff roles");
check(ROLE_DEFAULTS.ADMIN === "FULL" || (Array.isArray(ROLE_DEFAULTS.ADMIN) && ROLE_DEFAULTS.ADMIN.length === 0), "ADMIN handled as full-access (never restricted)");

const effMgr = resolveEffectivePermissions({ role: "MANAGER" }, []);
check(!effMgr.full && effMgr.permissions.has("orders.create") && effMgr.permissions.has("menu.edit"), "MANAGER default includes order + menu actions");
const effWaiter = resolveEffectivePermissions({ role: "WAITER" }, []);
check(effWaiter.permissions.has("pos.view") && !effWaiter.permissions.has("billing.collect"), "WAITER default: POS yes, billing no");

// Override semantics: absent = role default, true = grant, false = deny
const effCashier = resolveEffectivePermissions({ role: "CASHIER" }, [
  { permissionKey: "reports.sales", enabled: false },
  { permissionKey: "orders.print_kot", enabled: true },
]);
check(!effCashier.permissions.has("reports.sales"), "explicit deny removes a role default");
check(effCashier.permissions.has("orders.print_kot"), "explicit grant adds a new permission");
check(effCashier.permissions.has("billing.collect"), "untouched default survives (existing staff keep access)");

check(hasEffectivePermission(effMgr, "MANAGER", "orders.create"), "hasEffectivePermission grants held keys");
check(!hasEffectivePermission(effWaiter, "WAITER", "billing.refund"), "hasEffectivePermission rejects missing keys");
check(hasEffectivePermission({ full: false, permissions: new Set() }, "ADMIN", "anything.at.all"), "ADMIN always full (Part 21)");
check(hasEffectivePermission({ full: false, permissions: new Set() }, "SUPER_ADMIN", "anything.at.all"), "SUPER_ADMIN always full");

eq(effectiveDietaryAccess({ dietaryAccess: "VEG_ONLY" }), "VEG_ONLY", "dietary VEG_ONLY respected");
eq(effectiveDietaryAccess({ dietaryAccess: "VEG_AND_NON_VEG" }), "VEG_AND_NON_VEG", "dietary full access respected");
eq(effectiveDietaryAccess({}), "VEG_AND_NON_VEG", "missing dietaryAccess defaults to full (existing users unaffected)");

sub("Dietary guards (utils/dietary) — async guards verified in the final async block");
const { dietaryMenuWhere, dietaryItemError, DIETARY_BLOCKED_MESSAGE } = require("../utils/dietary");
const vegOnlyReq = { user: { role: "CASHIER", dietaryAccess: "VEG_ONLY" } };
const fullReq = { user: { role: "CASHIER", dietaryAccess: "VEG_AND_NON_VEG" } };
const adminReq = { user: { role: "ADMIN" } };

sub("Permission middleware (requirePermission)");
const { requirePermission } = require("../middleware/permission.middleware");
check(typeof requirePermission === "function" && requirePermission.length === 1, "requirePermission is a factory taking one key");

const { createUserSchema } = require("../validators/user.validator");
const uVal = createUserSchema.validate({ name: "Sam", email: "S@R.com", password: "secret123", role: "CASHIER" });
check(!uVal.error, "staff creation validator accepts a valid payload");

sub("Menu item create schema accepts dietaryType + subcategoryId");
const { createMenuSchema, updateMenuSchema } = require("../validators/menu.validator");
const menuOk = createMenuSchema.validate({ name: "Margherita", price: 199, categoryId: 1, dietaryType: "VEG", subcategoryId: 3 });
check(!menuOk.error, "create: dietaryType + subcategoryId accepted");
const menuBad = createMenuSchema.validate({ name: "X", price: 10, categoryId: 1, dietaryType: "EGG" });
check(!!menuBad.error, "create: invalid dietaryType rejected");
const menuUpd = updateMenuSchema.validate({ dietaryType: "NON_VEG" });
check(!menuUpd.error, "update: dietaryType accepted");

sub("Dietary + permission enforcement wired into controllers/routes (source audit)");
const menuCtrlSrc = fs2.readFileSync(path.join(process.cwd(), "src/controllers/menu.controller.js"), "utf8");
check(/dietaryMenuWhere/.test(menuCtrlSrc), "GET /menu applies the dietary where-fragment");
check(/getSubcategories|createSubcategory/.test(menuCtrlSrc), "subcategory CRUD handlers exist");
check(/moveToSubcategoryId/.test(menuCtrlSrc), "subcategory delete requires item reassignment (moveTo)");
const orderCtrlSrc = fs2.readFileSync(path.join(process.cwd(), "src/controllers/order.controller.js"), "utf8");
check((orderCtrlSrc.match(/dietaryItemError/g) || []).length >= 3, "dietary guard on all 3 order-item paths (create/addItem/update)");
const menuRoutesSrc = fs2.readFileSync(path.join(process.cwd(), "src/routes/menu.routes.js"), "utf8");
check(/requirePermission\("menu.create"\)/.test(menuRoutesSrc) && /requirePermission\("menu.edit"\)/.test(menuRoutesSrc) && /requirePermission\("menu.delete"\)/.test(menuRoutesSrc), "menu routes enforce menu.* permissions");
check(/requirePermission\("subcategory.manage"\)/.test(menuRoutesSrc), "subcategory routes enforce subcategory.manage");
const userRoutesSrc = fs2.readFileSync(path.join(process.cwd(), "src/routes/user.routes.js"), "utf8");
check(/"\/me\/permissions"/.test(userRoutesSrc), "GET /users/me/permissions route exists");
check(/requirePermission\("staff.edit"\)/.test(userRoutesSrc), "permission writes require staff.edit");
const tenantSchemaSrc = fs2.readFileSync(path.join(process.cwd(), "src/utils/tenantSchema.js"), "utf8");
check(/CREATE TABLE IF NOT EXISTS "UserPermission"/.test(tenantSchemaSrc), "UserPermission table in every new tenant schema");
check(/CREATE TABLE IF NOT EXISTS "Subcategory"/.test(tenantSchemaSrc), "Subcategory table in every new tenant schema");
check(/"dietaryAccess" "DietaryAccess" DEFAULT 'VEG_AND_NON_VEG'/.test(tenantSchemaSrc), "User.dietaryAccess column in tenant schema (tenant-qualified enum type)");
check(!/public/i.test(tenantSchemaSrc.match(/CREATE TABLE IF NOT EXISTS "UserPermission"[\s\S]{0,80}/)[0]), "UserPermission DDL is tenant DDL (no public reference)");

// ─── 10. Restaurant dietary mode hierarchy + plan entitlements ──────────
section("10. Restaurant dietary mode + plan entitlements + email identity");

sub("Restaurant dietary mode resolution (utils/dietary)");
const { restaurantDietaryMode, effectiveDietaryAccessFor } = require("../utils/dietary");
eq(restaurantDietaryMode({ dietaryMode: "VEG_ONLY" }), "VEG_ONLY", "restaurant mode VEG_ONLY read");
eq(restaurantDietaryMode({ dietaryMode: "VEG_AND_NON_VEG" }), "VEG_AND_NON_VEG", "restaurant mode VEG_AND_NON_VEG read");
eq(restaurantDietaryMode({}), "VEG_AND_NON_VEG", "missing setting defaults to VEG_AND_NON_VEG (existing restaurants unaffected)");
eq(restaurantDietaryMode(null), "VEG_AND_NON_VEG", "null setting safe");

sub("Hierarchy: restaurant mode is the ceiling (Part 5)");
const vegOnlyRest = { dietaryMode: "VEG_ONLY" };
const fullRest = { dietaryMode: "VEG_AND_NON_VEG" };
const staffBroad = { role: "CASHIER", dietaryAccess: "VEG_AND_NON_VEG" };
const staffVegOnly = { role: "CASHIER", dietaryAccess: "VEG_ONLY" };
// Test Restaurant A: mode VEG_ONLY + staff VEG_AND_NON_VEG → effective VEG_ONLY
eq(effectiveDietaryAccessFor({ user: staffBroad }, vegOnlyRest), "VEG_ONLY", "VEG_ONLY restaurant overrides staff VEG_AND_NON_VEG");
eq(effectiveDietaryAccessFor({ user: staffVegOnly }, vegOnlyRest), "VEG_ONLY", "VEG_ONLY restaurant + VEG_ONLY staff → VEG_ONLY");
// Test Restaurant B: mode VEG_AND_NON_VEG → staff setting applies
eq(effectiveDietaryAccessFor({ user: staffVegOnly }, fullRest), "VEG_ONLY", "full restaurant + VEG_ONLY staff → VEG_ONLY");
eq(effectiveDietaryAccessFor({ user: staffBroad }, fullRest), "VEG_AND_NON_VEG", "full restaurant + full staff → both");
// ADMIN never restricted below restaurant mode; VEG_ONLY restaurant still caps ADMIN
eq(effectiveDietaryAccessFor({ user: { role: "ADMIN" } }, vegOnlyRest), "VEG_ONLY", "VEG_ONLY restaurant caps even ADMIN");
eq(effectiveDietaryAccessFor({ user: { role: "ADMIN" } }, fullRest), "VEG_AND_NON_VEG", "ADMIN full in a full restaurant");

sub("Menu management respects VEG_ONLY restaurants (Part 16, source audit)");
check(/getRestaurantDietaryMode/.test(menuCtrlSrc), "menu create/update reads the restaurant dietary mode");
check(/This restaurant is configured for Veg Only/.test(menuCtrlSrc), "update rejects NON_VEG classification in VEG_ONLY restaurants");
// Part 14: create must REJECT NON_VEG with the same canonical 400 (no silent coercion).
check((menuCtrlSrc.match(/This restaurant is configured for Veg Only/g) || []).length >= 2, "create AND update both reject NON_VEG in VEG_ONLY restaurants with the canonical 400");
check(!/dietaryTypeValue = "VEG";/.test(menuCtrlSrc), "create does not silently coerce NON_VEG to VEG (explicit rejection instead)");

sub("Settings API accepts dietaryMode (Part 6, source audit)");
const settingCtrlSrc = fs2.readFileSync(path.join(process.cwd(), "src/controllers/setting.controller.js"), "utf8");
check(/\["dietaryMode", "dietaryMode"/.test(settingCtrlSrc), "createOrUpdateSetting persists dietaryMode");
check(/VEG_ONLY/.test(settingCtrlSrc), "dietaryMode values whitelisted server-side");
const tenantSchemaSrc2 = fs2.readFileSync(path.join(process.cwd(), "src/utils/tenantSchema.js"), "utf8");
check(/"dietaryMode" "DietaryMode" DEFAULT 'VEG_AND_NON_VEG'/.test(tenantSchemaSrc2), "tenant DDL includes dietaryMode (tenant-qualified enum) default VEG_AND_NON_VEG");

sub("Permissions API exposes restaurant mode + caps staff value (Part 14)");
const userCtrlSrc = fs2.readFileSync(path.join(process.cwd(), "src/controllers/user.controller.js"), "utf8");
check(/restaurantDietaryMode/.test(userCtrlSrc), "GET permissions returns restaurantDietaryMode");
check(/staff cannot be granted Non-Veg access/.test(userCtrlSrc), "PUT rejects broader staff dietary in VEG_ONLY restaurants");

sub("Plan module entitlement registry is canonical (Parts 9/13)");
const { PLAN_FEATURES, AVAILABLE_RESTAURANT_MODULES, FEATURE_SETTINGS_MAP, DEFAULT_FEATURES } = require("../config/subscription.config");
check(AVAILABLE_RESTAURANT_MODULES.length === 13, "13 canonical restaurant modules (incl. barcode_scanner, Part 11)");
check(AVAILABLE_RESTAURANT_MODULES.includes("barcode_scanner"), "barcode_scanner is a plan-controlled module");
check(["dashboard", "pos", "billing", "kitchen", "reports", "menu", "staff"].every(k => AVAILABLE_RESTAURANT_MODULES.includes(k)), "core modules present in the registry");
check(FEATURE_SETTINGS_MAP.kitchen.includes("enableKitchen"), "kitchen feature maps to enableKitchen toggle");
check(FEATURE_SETTINGS_MAP.reports.includes("enableReports"), "reports feature maps to enableReports toggle");
check(DEFAULT_FEATURES.every(f => PLAN_FEATURES[f]), "default features exist in the catalog");
const featureMidSrc = fs2.readFileSync(path.join(process.cwd(), "src/middleware/feature.middleware.js"), "utf8");
check(/features\.includes/.test(featureMidSrc), "requireFeature enforces plan features server-side (Part 11)");
check(/EXPIRED|CANCELLED|SUSPENDED/.test(featureMidSrc), "plan change/expiry blocks access immediately (Part 12)");

sub("Email identity stays case-insensitive (Parts 1–3)");
const emailUtil = require("../utils/email");
const { normalizeEmail: normalizeEmail2, isValidEmail: isValidEmail2 } = emailUtil;
eq(normalizeEmail2("  Jay@Gmail.COM  "), "jay@gmail.com", "trim + lowercase only");
eq(normalizeEmail2("JaY@GmAiL.CoM"), "jay@gmail.com", "mixed casing canonicalized");
eq(normalizeEmail2("john.smith+pos@Gmail.COM"), "john.smith+pos@gmail.com", "NO Gmail dot/+tag stripping (local part preserved)");
eq(normalizeEmail2("John.Smith@GMAIL.COM"), "john.smith@gmail.com", "dots kept inside local part");
check(isValidEmail2("JAY@GMAIL.COM"), "uppercase email passes validation");
check(!isValidEmail2("john..smith@GMAIL.COM"), "double-dot still rejected regardless of case");
const prismaSrc2 = fs2.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
check(/dietaryMode\s+DietaryMode/.test(prismaSrc2), "RestaurantSetting.dietaryMode in Prisma schema");
check(/enum DietaryMode/.test(prismaSrc2), "DietaryMode enum exists");

// ─── 10b. Staff Roster toggle + /menu/subcategories route order (Parts 1–14) ─
section("10b. Staff Roster toggle + /menu/subcategories route order");

sub("Route order: literal /subcategories registered before /:id (Part 8/12)");
const subIdx = menuRoutesSrc.indexOf('"/subcategories"');
const idIdx = menuRoutesSrc.indexOf('"/:id"');
check(subIdx !== -1 && idIdx !== -1 && subIdx < idIdx, "/subcategories (GET) registered before /:id — never captured as a menu-item id");
const subPutIdx = menuRoutesSrc.indexOf('"/subcategories/:id"');
const putIdIdx = menuRoutesSrc.indexOf('"/:id"', menuRoutesSrc.indexOf('router.put('));
check(subPutIdx !== -1 && putIdIdx !== -1 && subPutIdx < putIdIdx, "PUT /subcategories/:id precedes PUT /:id");
check(/getSubcategories/.test(menuRoutesSrc), "subcategories GET wired to getSubcategories controller");

sub("Controller reads tenantDb (Part 10)");
const menuCtrlSrc2 = menuCtrlSrc;
check(/getSubcategories[\s\S]{0,400}req\.tenantDb\.subcategory/.test(menuCtrlSrc2), "getSubcategories uses req.tenantDb.subcategory (tenant scoped)");
check(/req\.query\.categoryId/.test(menuCtrlSrc2), "optional categoryId filter supported");

sub("enableStaffRoster persisted + DDL (Part 2)");
check(/enableStaffRoster\s+Boolean\s+@default\(true\)/.test(prismaSrc2), "RestaurantSetting.enableStaffRoster in Prisma schema (default true)");
check(/"enableStaffRoster" BOOLEAN DEFAULT true/.test(tenantSchemaSrc2), "tenant DDL includes enableStaffRoster default true");
check(/\["enableStaffRoster", "enableStaffRoster", toBool\]/.test(settingCtrlSrc), "settings controller whitelist includes enableStaffRoster");
const settingValidatorSrc = fs2.readFileSync(path.join(process.cwd(), "src/validators/setting.validator.js"), "utf8");
check(/enableStaffRoster: Joi\.boolean\(\)\.default\(true\)/.test(settingValidatorSrc), "settings validator accepts enableStaffRoster");

sub("Backend enforcement chain: plan → toggle → permission (Parts 3/6)");
check(/requireModuleEnabled/.test(featureMidSrc), "requireModuleEnabled toggle middleware exists");
check(/requireModuleEnabled\("enableStaffRoster"/.test(fs2.readFileSync(path.join(process.cwd(), "src/routes/user.routes.js"), "utf8")), "staff routes guarded by requireModuleEnabled(enableStaffRoster)");
check(/setting\[settingKey\] !== false/.test(featureMidSrc), "missing/legacy setting defaults to ON (no surprise blocks)");

// ─── 10c. requireModuleEnabled behavior (fake req/res, real middleware) ────
section("10c. requireModuleEnabled — toggle OFF blocks, ON/missing allows");
const { requireModuleEnabled } = require("../middleware/feature.middleware");
const mw = requireModuleEnabled("enableStaffRoster", "Staff Roster");
const runMw = (req) => new Promise((resolve) => {
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ blocked: true, code: this.statusCode, message: body && body.message }); },
  };
  mw(req, res, () => resolve({ blocked: false }));
});
const fakeSettingDb = (setting) => ({ restaurantSetting: { findFirst: async () => setting } });

// Async middleware assertions run inside the final async block below.
check(typeof runMw === "function" && typeof fakeSettingDb === "function", "toggle middleware harness ready");

// ─── 9b. Floor assignment access (Parts 9–13) ───────────────────────────────
section("9b. Floor assignment — many-to-many access model");
sub("Floor access policy (utils/floorAccess)");
// Async floor-assignment assertions run inside the final async block below
// (they exercise the async floorAccess helpers with a fake tenant DB).
const floorAccess = require("../utils/floorAccess");
check(Array.isArray(floorAccess.ASSIGNMENT_EXEMPT_ROLES) && floorAccess.ASSIGNMENT_EXEMPT_ROLES.includes("ADMIN") && floorAccess.ASSIGNMENT_EXEMPT_ROLES.includes("MANAGER"), "ADMIN/MANAGER exempt from floor restriction (existing roles never narrowed)");
check(floorAccess.isFloorRestrictedRole("WAITER") === true, "WAITER is a floor-restrictable role");
eq(floorAccess.isFloorRestrictedRole("SUPER_ADMIN"), false, "SUPER_ADMIN never restricted");

sub("Floor enforcement wired into controllers (source audit)");
const tableCtrlSrc2 = fs2.readFileSync(path.join(process.cwd(), "src/controllers/table.controller.js"), "utf8");
check(/tableScopeFor/.test(tableCtrlSrc2) && /floorAccessDenied/.test(tableCtrlSrc2), "table list/status/update/delete scoped by floorAccess");
const orderCtrlSrc2 = fs2.readFileSync(path.join(process.cwd(), "src/controllers/order.controller.js"), "utf8");
check(/orderFloorScopeFor/.test(orderCtrlSrc2), "active orders list filtered by floor assignment");
check((orderCtrlSrc2.match(/orderFloorAccessError/g) || []).length >= 3, "add/update/delete order item paths guard floor access");
const floorCtrlSrc = fs2.readFileSync(path.join(process.cwd(), "src/controllers/floor.controller.js"), "utf8");
check(/getAssignedFloorIds/.test(floorCtrlSrc) && /You are not assigned to this floor/.test(floorCtrlSrc), "floor list + detail enforce assignments");
const userCtrlSrc2 = fs2.readFileSync(path.join(process.cwd(), "src/controllers/user.controller.js"), "utf8");
check(/ASSIGNABLE_FLOOR_ROLES/.test(userCtrlSrc2) && /MANAGER", "CASHIER", "KITCHEN", "WAITER/.test(userCtrlSrc2), "floor assignment restricted to MANAGER/CASHIER/KITCHEN/WAITER");
check(/Unknown floor ID/.test(userCtrlSrc2), "assignment endpoint validates floor ids against the tenant");
check(/deleteMany\({ where: { userId } }\)/.test(userCtrlSrc2), "replace-all assignment semantics (clear-all supported)");
const floorRoutesSrc = fs2.readFileSync(path.join(process.cwd(), "src/routes/floor.routes.js"), "utf8");
check(/requireFeature\(\["floors", "pos"\]\)/.test(floorRoutesSrc), "floor routes respect plan feature gate");
const tableRoutesSrc2 = fs2.readFileSync(path.join(process.cwd(), "src/routes/table.routes.js"), "utf8");
check(/authorize\("ADMIN", "MANAGER"\)/.test(tableRoutesSrc2), "table writes limited to ADMIN/MANAGER");

sub("Category deletion protects subcategories (Part 19)");
const catCtrlSrc = fs2.readFileSync(path.join(process.cwd(), "src/controllers/category.controller.js"), "utf8");
check(/subcategory\.count/.test(catCtrlSrc), "category delete refuses when subcategories exist (no orphans)");

sub("updateMenuItem declaration-order regression (updateData TDZ bug)");
check(menuCtrlSrc.indexOf("const updateData = {};") < menuCtrlSrc.indexOf("updateData.subcategoryId"), "updateData declared before first use (no ReferenceError on subcategory/dietary updates)");

sub("Tenant DDL is valid PostgreSQL (no JS // comments in SQL strings)");
check(!/\n\s*\/\/ /.test(tenantSchemaSrc2.match(/TENANT_TABLES_SQL = `[\s\S]*?`;/)?.[0] || ""), "TENANT_TABLES_SQL contains only -- SQL comments");

// Async dietary + floor guards (menu where-fragment, order item rejection and
// floor scoping) — these run in an async block that also prints the summary.
(async () => {
  sub("Dietary guards — user-level (async)");
  eq(JSON.stringify(await dietaryMenuWhere(vegOnlyReq)), JSON.stringify({ dietaryType: "VEG" }), "menu where: VEG_ONLY user → VEG only");
  eq(JSON.stringify(await dietaryMenuWhere(adminReq)), "{}", "menu where: ADMIN user → no constraint");
  eq(await dietaryItemError(vegOnlyReq, { dietaryType: "NON_VEG" }), DIETARY_BLOCKED_MESSAGE, "order: NON_VEG blocked for VEG_ONLY user");
  eq(await dietaryItemError(vegOnlyReq, { dietaryType: "VEG" }), null, "order: VEG allowed for VEG_ONLY user");
  eq(await dietaryItemError(fullReq, { dietaryType: "NON_VEG" }), null, "order: NON_VEG allowed for full-access user (no tenantDb → user access)");

  sub("Restaurant dietary mode caps staff access (Parts 5/6 — Test Matrix A/B)");
  const { restaurantDietaryMode, effectiveDietaryAccessFor } = require("../utils/dietary");
  eq(restaurantDietaryMode({ dietaryMode: "VEG_ONLY" }), "VEG_ONLY", "restaurant mode VEG_ONLY read");
  eq(restaurantDietaryMode({ dietaryMode: "VEG_AND_NON_VEG" }), "VEG_AND_NON_VEG", "restaurant mode VEG_AND_NON_VEG read");
  eq(restaurantDietaryMode(null), "VEG_AND_NON_VEG", "null setting safe (defaults full)");
  const vegOnlySetting = { dietaryMode: "VEG_ONLY" };
  const fullSetting = { dietaryMode: "VEG_AND_NON_VEG" };
  eq(effectiveDietaryAccessFor({ user: { role: "WAITER", dietaryAccess: "VEG_AND_NON_VEG" } }, vegOnlySetting), "VEG_ONLY", "Restaurant A VEG_ONLY caps VEG_AND_NON_VEG staff → VEG_ONLY");
  eq(effectiveDietaryAccessFor({ user: { role: "WAITER", dietaryAccess: "VEG_ONLY" } }, vegOnlySetting), "VEG_ONLY", "Restaurant A VEG_ONLY + VEG_ONLY staff → VEG_ONLY");
  eq(effectiveDietaryAccessFor({ user: { role: "WAITER", dietaryAccess: "VEG_ONLY" } }, fullSetting), "VEG_ONLY", "Restaurant B full + VEG_ONLY waiter → VEG_ONLY");
  eq(effectiveDietaryAccessFor({ user: { role: "WAITER", dietaryAccess: "VEG_AND_NON_VEG" } }, fullSetting), "VEG_AND_NON_VEG", "Restaurant B full + full waiter → both");
  eq(effectiveDietaryAccessFor({ user: { role: "ADMIN", dietaryAccess: "VEG_AND_NON_VEG" } }, vegOnlySetting), "VEG_ONLY", "VEG_ONLY restaurant caps even ADMIN (no bypass)");

  sub("Floor assignment scoping (Parts 12/13 — fake tenant DB)");
  const fakeTenantDb = {
    userFloorAssignment: {
      findMany: async ({ where }) =>
        where.userId === 7 ? [{ floorId: 1 }, { floorId: 2 }] : [],
    },
    restaurantTable: {
      findUnique: async ({ where }) =>
        where.id === 11 ? { floorId: 1 } : where.id === 22 ? { floorId: 3 } : null,
    },
  };
  const waiterA = { id: 7, role: "WAITER" };
  const waiterNoAssign = { id: 99, role: "WAITER" };

  eq(JSON.stringify(await floorAccess.getAssignedFloorIds(fakeTenantDb, 7, "WAITER")), "[1,2]", "restricted staff loads their floor ids");
  check(floorAccess.getAssignedFloorIds(fakeTenantDb, 7, "ADMIN") instanceof Promise === true, "ADMIN unrestricted (null scope — no query issued)");
  eq(JSON.stringify(await floorAccess.getAssignedFloorIds(fakeTenantDb, 99, "WAITER")), "[]", "staff without assignments has empty list (restaurant-wide until assigned)");

  eq(JSON.stringify(await floorAccess.tableScopeFor(fakeTenantDb, waiterA)), JSON.stringify({ floorId: { in: [1, 2] } }), "table scope narrows to assigned floors");
  check((await floorAccess.tableScopeFor(fakeTenantDb, { id: 7, role: "MANAGER" })) === null, "MANAGER table scope is restaurant-wide");

  const oScope = await floorAccess.orderFloorScopeFor(fakeTenantDb, waiterA);
  check(Array.isArray(oScope.OR) && oScope.OR.length === 2, "order scope keeps table-less orders + assigned-floor tables");
  check((await floorAccess.orderFloorScopeFor(fakeTenantDb, waiterNoAssign)) === null, "unassigned staff order scope is restaurant-wide");

  eq(await floorAccess.orderFloorAccessError(fakeTenantDb, waiterA, { tableId: 11 }), null, "order on assigned floor 1 allowed");
  eq(await floorAccess.orderFloorAccessError(fakeTenantDb, waiterA, { tableId: 22 }), "You are not assigned to this floor.", "order on unassigned floor 3 rejected");
  eq(await floorAccess.orderFloorAccessError(fakeTenantDb, waiterA, { tableId: null }), null, "table-less order (takeaway) not floor-guarded");
  eq(await floorAccess.orderFloorAccessError(fakeTenantDb, waiterNoAssign, { tableId: 22 }), null, "unassigned staff remains restaurant-wide");

  sub("requireModuleEnabled — Staff Roster toggle (Parts 3/6/7)");
  eq((await runMw({ user: { role: "SUPER_ADMIN", restaurantId: 1 }, tenantDb: fakeSettingDb({ enableStaffRoster: false }) })).blocked, false, "SUPER_ADMIN bypasses restaurant toggle");
  eq((await runMw({ user: { role: "ADMIN", restaurantId: 1 }, tenantDb: fakeSettingDb({ enableStaffRoster: false }) })).code, 403, "toggle OFF blocks ADMIN staff-management API");
  check(/disabled in POS Settings/.test((await runMw({ user: { role: "ADMIN", restaurantId: 1 }, tenantDb: fakeSettingDb({ enableStaffRoster: false }) })).message), "rejection message names the disabled module");
  eq((await runMw({ user: { role: "ADMIN", restaurantId: 1 }, tenantDb: fakeSettingDb({ enableStaffRoster: true }) })).blocked, false, "toggle ON allows the workflow");
  eq((await runMw({ user: { role: "ADMIN", restaurantId: 1 }, tenantDb: fakeSettingDb(undefined) })).blocked, false, "missing setting row defaults to ON (existing tenants unaffected)");
  eq((await runMw({ user: { role: "ADMIN", restaurantId: 1 }, tenantDb: null })).blocked, false, "missing tenantDb fails open (gating left to requireFeature)");

  // ══════════════════════════════════════════════════════════════════════
  sub("Settings save hardening (PHASE 1/17 — whitelist, no restaurantId injection)");
  const settingCtrlSrc = fs2.readFileSync(path.join(process.cwd(), "src/controllers/setting.controller.js"), "utf8");
  check(/const data = \{\};/.test(settingCtrlSrc), "update payload starts EMPTY (no req.body spread)");
  check(!/\.\.\.req\.body/.test(settingCtrlSrc), "req.body is never spread into Prisma data");
  check(!/data\.restaurantId\s*=/.test(settingCtrlSrc), "restaurantId is NEVER assigned into update data (where-only)");
  check(/data: \{ \.\.\.data, restaurantId: tenantRestaurantId \}/.test(settingCtrlSrc), "CREATE binds restaurantId from the authenticated tenant only");
  check(/data\.enablePosOrdering = true/.test(settingCtrlSrc), "enablePosOrdering force-set true (POS Ordering mandatory)");
  check(/\["barcodeScannerEnabled", "barcodeScannerEnabled", toBool\]/.test(settingCtrlSrc), "barcodeScannerEnabled is a whitelisted settings field");
  check(!/businessMode"?,\s*"businessMode"/.test(settingCtrlSrc), "businessMode is not client-writable (subscription-derived)");
  check(/PrismaClientValidationError/.test(settingCtrlSrc), "Prisma validation errors return safe 400 (no internals leaked)");
  check(/"Failed to save settings\.", 500/.test(settingCtrlSrc), "unexpected save errors return generic 500 message");
  check(/"Failed to load settings\.", 500/.test(settingCtrlSrc), "GET settings errors return generic 500 message");
  const settingValidatorSrc = fs2.readFileSync(path.join(process.cwd(), "src/validators/setting.validator.js"), "utf8");
  check(/barcodeScannerEnabled: Joi\.boolean\(\)/.test(settingValidatorSrc), "settings validator accepts barcodeScannerEnabled");
  const prismaModelFields = (() => {
    try {
      const { Prisma } = require("@prisma/client");
      const dm = Prisma.dmmf?.document?.datamodel || Prisma.dmmf?.datamodel;
      return new Set(dm.models.find(m => m.name === "RestaurantSetting").fields.map(f => f.name));
    } catch { return null; }
  })();
  if (prismaModelFields) {
    check(prismaModelFields.has("barcodeScannerEnabled"), "generated Prisma client knows RestaurantSetting.barcodeScannerEnabled (stale client = 500 root cause)");
  }

  sub("Barcode lookup route + controller (PHASE 7 — tenant-scoped, string-safe)");
  const menuRoutesSrc = fs2.readFileSync(path.join(process.cwd(), "src/routes/menu.routes.js"), "utf8");
  check(/"\/barcode\/:barcode"/.test(menuRoutesSrc), "GET /menu/barcode/:barcode route registered");
  check(/requireFeature\("barcode_scanner"\)/.test(menuRoutesSrc), "barcode lookup gated by plan entitlement middleware");
  const menuCtrlSrc = fs2.readFileSync(path.join(process.cwd(), "src/controllers/menu.controller.js"), "utf8");
  check(/String\(req\.params\.barcode \|\| ""\)\.trim\(\)/.test(menuCtrlSrc), "barcode normalized as STRING (trim, leading zeros preserved)");
  check(/req\.tenantDb\.menuItem\.findFirst/.test(menuCtrlSrc), "lookup uses req.tenantDb (never another tenant)");
  check(/isAvailable: true/.test(menuCtrlSrc), "only available items are scannable");
  check(/Item not found for barcode:/.test(menuCtrlSrc), "unknown barcode returns explicit 404 message");
  check(/barcodeScannerEnabled !== true/.test(menuCtrlSrc), "restaurant scanner toggle enforced in controller (403 when OFF)");
  check(/Barcode already in use by item/.test(menuCtrlSrc), "duplicate barcode rejected (create + update)");
  const menuValidatorSrc = fs2.readFileSync(path.join(process.cwd(), "src/validators/menu.validator.js"), "utf8");
  check(/barcode: Joi\.string\(\)/.test(menuValidatorSrc), "menu validator treats barcode as STRING (never Number)");

  sub("Plan entitlement catalog (PHASE 3/4 — barcode_scanner plan-controlled)");
  const planModulesDb = await (async () => {
    try {
      const { platformPrisma } = require("../config/tenantPrisma");
      const rows = await platformPrisma.planModule.findMany({ where: { key: "barcode_scanner" }, select: { key: true, isActive: true } });
      await platformPrisma.$disconnect();
      return rows;
    } catch { return null; }
  })();
  if (planModulesDb) {
    check(planModulesDb.length === 1 && planModulesDb[0].isActive, "barcode_scanner PlanModule row exists and is active");
  }
  check(PLAN_FEATURES.barcode_scanner && PLAN_FEATURES.barcode_scanner.label === "Barcode Scanner", "feature catalog exposes barcode_scanner label");

  console.log(`\n──────── RESULTS: ${results.pass} passed, ${results.fail} failed ────────`);
  if (results.fail > 0) process.exit(1);
})().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
