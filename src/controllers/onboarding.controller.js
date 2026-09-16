const multer = require("multer");
const service = require("../services/onboarding.service");
const emailVerification = require("../services/email-verification.service");
const { successResponse, errorResponse } = require("../utils/response");
const { DOCUMENT_MAX_SIZE_BYTES } = require("../config/onboarding.config");

// ─── Stage gates ─────────────────────────────────────────────────────────────
// Every mutating endpoint only accepts applications sitting at an allowed
// stage. The stored stage is data-derived (never client-supplied), so this is
// defense-in-depth on top of the service's own prerequisite checks.
const GATES = {
  // REGISTERED = account created, no Restaurant row yet (first business submission).
  business: ["REGISTERED", "DOCUMENTS_PENDING", "LEGAL_PENDING", "PLAN_PENDING", "PLAN_SELECTED", "PAYMENT_PENDING", "PAYMENT_FAILED", "DOCUMENT_REJECTED"],
  documents: ["DOCUMENTS_PENDING", "LEGAL_PENDING", "PLAN_PENDING", "PLAN_SELECTED", "PAYMENT_PENDING", "PAYMENT_FAILED", "DOCUMENT_REJECTED", "UNDER_REVIEW"],
  legal: ["LEGAL_PENDING", "PLAN_PENDING"],
  plan: ["PLAN_PENDING", "PLAN_SELECTED", "PAYMENT_PENDING", "PAYMENT_FAILED"],
  // Payment endpoints are NOT part of the applicant wizard anymore — they only
  // remain for legacy accounts already sitting at a payment stage. A fresh
  // PLAN_SELECTED application can never create a checkout (defense in depth:
  // the new flow is plan → review → submit → MANUAL_PENDING).
  paymentCreate: ["PAYMENT_PENDING", "PAYMENT_FAILED"],
  paymentVerify: ["PAYMENT_PENDING", "PAYMENT_FAILED", "PAYMENT_SUCCESS", "UNDER_REVIEW", "PROVISIONING"],
  // Submit is callable from any in-progress stage; the service re-validates
  // every prerequisite (business/docs/legal/plan) before freezing the
  // application at MANUAL_PENDING.
  submit: ["REGISTERED", "ONBOARDING", "DOCUMENTS_PENDING", "LEGAL_PENDING", "PLAN_PENDING", "PLAN_SELECTED", "PAYMENT_PENDING", "PAYMENT_FAILED", "DOCUMENT_REJECTED"],
};

const STAGE_MESSAGES = {
  ACTIVE: "This account is already active. Please log in to the POS.",
  REJECTED: "This application was rejected. Please contact support for next steps.",
  SUSPENDED: "This account is suspended. Please contact support.",
  EXPIRED: "This application has expired. Please contact support.",
  PROVISIONING: "Your account is being set up. Please wait a moment and refresh.",
  UNDER_REVIEW: "Your application is under review by our team.",
};

/**
 * Returns null when allowed, otherwise an error message string.
 * `softStages`: stages whose STAGE_MESSAGES blurb must NOT hard-block this
 * gate. Used by the payment-verify gate: UNDER_REVIEW / PROVISIONING already
 * mean the payment was verified, and a replayed (duplicate) callback must
 * return the current state idempotently instead of a 400 — never activating
 * twice, never forcing the client into an error state.
 */
function stageGate(req, gateKey, opts = {}) {
  const restaurant = req.onboarding && req.onboarding.restaurant;
  const stage = restaurant ? restaurant.onboardingStatus : "REGISTERED";
  const soft = (opts.softStages || []).includes(stage);
  const blocked = STAGE_MESSAGES[stage];
  if (blocked && !soft) return blocked;
  const allowed = GATES[gateKey];
  if (!allowed.includes(stage)) {
    return "This step is not available yet. Please follow the registration steps in order.";
  }
  return null;
}

const meta = (req) => ({ ipAddress: req.ip, userAgent: req.headers["user-agent"] });

const getOnboardingConfig = async (req, res) => {
  try {
    const data = await service.getOnboardingConfig();
    return successResponse(res, data, "Onboarding configuration");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const listPublicPlans = async (req, res) => {
  try {
    const data = await service.listPublicPlans({ businessType: req.query.businessType });
    return successResponse(res, data, "Plans loaded");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const getStatus = async (req, res) => {
  try {
    const userId = (req.onboarding && req.onboarding.user.id) || req.user?.id;
    const data = await service.buildOnboardingPayload(userId);
    if (!data) {
      // Controlled completion response (defense in depth): this account is a
      // normal POS user (not a self-serve application), so onboarding is —
      // by definition — not applicable. The authorized caller gets a safe,
      // minimal "nothing to see" payload instead of an error: the frontend
      // treats any such payload as "no application" and never routes a POS
      // user into the wizard, so an accidental call cannot become a 403 loop.
      // No application data is exposed (there is none), and the 403 gate in
      // onboardingAuth for unrelated users stays exactly as strict as before.
      return successResponse(
        res,
        {
          account: { status: "ACTIVE", step: "complete", label: "Active", user: { id: userId } },
          restaurant: null,
          steps: { active: true, blocked: false },
          onboardingComplete: true,
        },
        "No self-serve application for this account"
      );
    }
    return successResponse(res, data, "Onboarding status");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const submitBusiness = async (req, res) => {
  try {
    const blocked = stageGate(req, "business");
    if (blocked) return errorResponse(res, blocked, 400);
    const { user, restaurant } = req.onboarding;
    const data = await service.createOrUpdateBusiness(user.id, restaurant ? restaurant.id : null, { ...req.body, _ip: req.ip, _ua: req.headers["user-agent"] });
    return successResponse(res, data, restaurant ? "Business details updated" : "Business details submitted", 200);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const uploadDocument = async (req, res) => {
  try {
    const blocked = stageGate(req, "documents");
    if (blocked) return errorResponse(res, blocked, 400);
    if (!req.file) return errorResponse(res, "No file uploaded", 400);
    const documentType = req.body.documentType || req.query.documentType;
    if (!documentType) return errorResponse(res, "documentType is required", 400);

    const { user, restaurant } = req.onboarding;
    const doc = await service.createDocument(
      user.id,
      restaurant,
      {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
      },
      documentType,
      req.ip,
      req.headers["user-agent"]
    );
    return successResponse(res, doc, "Document uploaded successfully", 201);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const listDocuments = async (req, res) => {
  try {
    const data = await service.listDocuments(req.onboarding.restaurant.id);
    return successResponse(res, data, "Documents fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const downloadDocument = async (req, res) => {
  try {
    // Owner-scoped: only documents belonging to the applicant's own restaurant.
    const doc = await service.getOwnedDocument(req.onboarding.restaurant.id, req.params.documentId);
    const filePath = service.resolveDocumentFilePath(doc);
    const safeName = String(doc.originalFileName || "document").replace(/[^\w.\- ]+/g, "").slice(0, 100);
    res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName || "document"}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(filePath);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const acceptLegal = async (req, res) => {
  try {
    const blocked = stageGate(req, "legal");
    if (blocked) return errorResponse(res, blocked, 400);
    const { user, restaurant } = req.onboarding;
    const data = await service.acceptLegal(user.id, restaurant, req.body.acceptances, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Legal agreements accepted", 201);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const selectPlan = async (req, res) => {
  try {
    const blocked = stageGate(req, "plan");
    if (blocked) return errorResponse(res, blocked, 400);
    const { user, restaurant } = req.onboarding;
    const data = await service.selectPlan(user.id, restaurant, req.body.planId);
    return successResponse(res, data, "Plan selected — review and submit your application", 200);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const submitApplication = async (req, res) => {
  try {
    const blocked = stageGate(req, "submit");
    if (blocked) return errorResponse(res, blocked, 400);
    const userId = (req.onboarding && req.onboarding.user.id) || (req.user && req.user.id);
    const data = await service.submitApplication(userId, meta(req));
    return successResponse(res, data, "Application submitted successfully", 201);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const createCheckout = async (req, res) => {
  try {
    const blocked = stageGate(req, "paymentCreate");
    if (blocked) return errorResponse(res, blocked, 400);
    const { user, restaurant } = req.onboarding;
    const data = await service.createCheckout(user.id, restaurant, meta(req));
    return successResponse(res, data, "Checkout created — complete the payment to activate", 201);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const verifyPayment = async (req, res) => {
  try {
    // UNDER_REVIEW / PROVISIONING are valid stages for a (re)verification
    // call — the payment is already verified, so a duplicate callback returns
    // the current state instead of being blocked.
    const blocked = stageGate(req, "paymentVerify", { softStages: ["UNDER_REVIEW", "PROVISIONING"] });
    if (blocked) return errorResponse(res, blocked, 400);
    const { user, restaurant } = req.onboarding;
    const data = await service.verifyPayment(user.id, restaurant, req.body, meta(req));
    const activated = data.status === "ACTIVE";
    return successResponse(
      res,
      data,
      activated ? "Payment verified — your account is now active" : "Payment verified — your application is under review",
      activated ? 200 : 200
    );
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

// ─── Email verification (OTP) controllers ──────────────────────────────────

/** POST /onboarding/email/send-otp — start/refresh verification for an email. */
const sendEmailOtp = async (req, res) => {
  try {
    const data = await emailVerification.sendVerificationOtp(req.body?.email, { ipAddress: req.ip });
    return successResponse(res, data, data.message);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** POST /onboarding/email/verify-otp — verify the 6-digit code server-side. */
const verifyEmailOtp = async (req, res) => {
  try {
    const data = await emailVerification.verifyOtp(req.body?.email, req.body?.otp);
    return successResponse(res, data, data.message || "Email verified successfully.");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** GET /onboarding/email/verification-status?email= — UI state (no secrets). */
const getEmailVerificationStatus = async (req, res) => {
  try {
    const data = await emailVerification.verificationStatus(req.query.email);
    return successResponse(res, data, "Verification status");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

// ─── Manual payment flow controllers ─────────────────────────────────────────

const startManualApplication = async (req, res) => {
  try {
    // onboardingAuth attaches req.onboarding.user (NOT req.user) — use the
    // same resolution pattern as the other applicant handlers above.
    const userId = (req.onboarding && req.onboarding.user && req.onboarding.user.id) || (req.user && req.user.id);
    const data = await service.startManualApplication(userId, { ...req.body, _ip: req.ip, _ua: req.headers["user-agent"] });
    return successResponse(res, data, "Application submitted successfully", 201);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

// getManualPaymentQR / generatePaymentQR handlers REMOVED — the onboarding
// flow never exposes QR generation; payment verification is a manual Super
// Admin action (mark-payment → approve).

const markPaymentReceived = async (req, res) => {
  try {
    const data = await service.markPaymentReceived(
      req.body.restaurantId,
      req.user.id,
      { ...req.body, _ip: req.ip, _ua: req.headers["user-agent"] }
    );
    return successResponse(res, data, "Payment verified successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const getManualApplicationDetail = async (req, res) => {
  try {
    const data = await service.getManualApplicationDetail(req.params.id);
    const review = await service.getReviewMode();
    return successResponse(res, { ...data, reviewMode: review.mode }, "Manual application fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

// ─── Multer (in-memory so magic-number validation runs on the real bytes) ───
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOCUMENT_MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = (String(file.originalname).match(/\.[^.]+$/) || [""])[0].toLowerCase();
    if ([".pdf", ".jpg", ".jpeg", ".png"].includes(ext)) return cb(null, true);
    return cb(new Error("Only PDF, JPG, JPEG and PNG files are allowed"));
  },
});

/** Middleware wrapping multer so size/filter errors return clean 400s. */
const uploadDocumentFile = (req, res, next) => {
  docUpload.single("file")(req, res, (err) => {
    if (err) {
      const message = err.code === "LIMIT_FILE_SIZE"
        ? "File size must be 10 MB or less"
        : `File upload error: ${err.message}`;
      return res.status(400).json({ success: false, message });
    }
    next();
  });
};

module.exports = {
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
  // Manual payment flow (QR generation removed — manual verification only)
  startManualApplication,
  markPaymentReceived,
  getManualApplicationDetail,
};
