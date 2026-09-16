const express = require("express");
const router = express.Router();

const onboardingAuth = require("../middleware/onboardingAuth.middleware");
const validate = require("../middleware/validate.middleware");
const { loginLimiter, otpLimiter } = require("../middleware/rate-limit.middleware");
const {
  getOnboardingConfig,
  listPublicPlans,
  getStatus,
  submitBusiness,
  uploadDocumentFile,
  uploadDocument,
  listDocuments,
  downloadDocument,
  acceptLegal,
  selectPlan,
  submitApplication,
  createCheckout,
  verifyPayment,
  // Email verification (OTP)
  sendEmailOtp,
  verifyEmailOtp,
  getEmailVerificationStatus,
  // Manual payment flow
  startManualApplication,
  markPaymentReceived,
  getManualApplicationDetail,
} = require("../controllers/onboarding.controller");
const {
  businessSchema,
  legalSchema,
  selectPlanSchema,
  verifyPaymentSchema,
  manualApplicationSchema,
  manualPaymentSchema,
  manualStartSchema,
  sendOtpSchema,
  verifyOtpSchema,
} = require("../validators/onboarding.validator");

// ─── Email verification (OTP) ───────────────────────────────────────────────
// Server-side email ownership proof: the application CANNOT be submitted
// until the entered address was verified with a 6-digit OTP. The verification
// record lives in the PUBLIC schema (no tenant exists yet) and the verified
// flag is decided server-side only — a client-provided emailVerified value is
// always ignored.
router.post("/email/send-otp", otpLimiter, validate(sendOtpSchema), sendEmailOtp);
router.post("/email/verify-otp", otpLimiter, validate(verifyOtpSchema), verifyEmailOtp);
router.get("/email/verification-status", getEmailVerificationStatus);

// ─── Public (no auth) ────────────────────────────────────────────────────────
// Static flow configuration — business types, document types, policy versions.
router.get("/config", getOnboardingConfig);

// Active purchasable plans for the plan-selection step (yearly billing).
router.get("/plans", listPublicPlans);

// ─── Applicant endpoints (onboarding auth only — never POS access) ─────────
router.use(onboardingAuth);

// Current application state — used by "Continue Setup" resume + status polling.
router.get("/status", getStatus);

// Business details (creates the Restaurant row on first submission).
router.post("/business", validate(businessSchema), submitBusiness);

// Business documents (private storage — authorized download only).
router.post("/documents", uploadDocumentFile, uploadDocument);
router.get("/documents", listDocuments);
router.get("/documents/:documentId/download", downloadDocument);

// Legal acceptance (Terms, Privacy Policy, accuracy confirmation — versioned).
router.post("/legal", validate(legalSchema), acceptLegal);

// Plan selection.
router.post("/plan", validate(selectPlanSchema), selectPlan);

// Final submission — REVIEW → SUBMIT APPLICATION. Validates all prerequisites
// server-side, freezes the application at MANUAL_PENDING and notifies the
// Super Admin. No payment is collected here.
router.post("/submit", submitApplication);

// Payment: create Razorpay checkout + verify (server-side signature check).
// Kept only for legacy accounts already at a payment stage — the applicant
// wizard never reaches these.
router.post("/payments/create", createCheckout);
router.post("/payments/verify", loginLimiter, validate(verifyPaymentSchema), verifyPayment);

// ─── Manual payment flow (new simplified onboarding) ─────────────────────────
// These endpoints are for the new manual QR-based payment flow where:
// 1. Applicant submits application without payment
// 2. Super Admin reviews and generates payment QR
// 3. Applicant pays manually via QR
// 4. Super Admin verifies payment and approves/rejects

// Start a new manual payment application (replaces the multi-step flow)
router.post("/manual/start", validate(manualStartSchema), startManualApplication);

// NOTE: GET /manual/qr/:applicationId and GET /manual/qr-config were removed —
// the onboarding flow must not expose QR generation. Payment is verified
// manually by the Super Admin (mark-payment) before approval.

// Mark payment as received (Super Admin)
router.post("/manual/payment/receive", validate(manualPaymentSchema), loginLimiter, markPaymentReceived);

// Get manual application detail
router.get("/manual/application/:id", getManualApplicationDetail);

module.exports = router;
