/**
 * Self-serve onboarding configuration — the single source of truth for the
 * public registration → plan-selection flow.
 *
 * Everything a new-restaurant applicant can choose (business types, document
 * types, policy versions) is listed here so the flow stays data-driven: adding
 * a new business type or document type is a config change, not a code rewrite.
 * Business types map onto the `BusinessType` enum on Restaurant; unknown /
 * future types can be added by extending the enum (additive) and this list.
 */
const path = require("path");

// ─── Business types offered to new applicants ────────────────────────────────
// { value: BusinessType enum value, label, group }
// Offered verticals. HOTEL is deliberately NOT offered for new selection
// (spec §14) — the BusinessType enum value stays valid so existing HOTEL
// records remain readable; only new onboarding rejects it.
// RESTAURANT → Restaurant-mode plans; the rest → Basic-mode plans via
// utils/businessMode.resolveBusinessMode (single source of truth — this list
// only carries display metadata).
const BUSINESS_TYPES = [
  // Food service (group 1)
  { value: "RESTAURANT", label: "Restaurant", group: "Food Service" },
  { value: "CAFE", label: "Café", group: "Food Service" },
  { value: "BAKERY", label: "Bakery", group: "Food Service" },
  { value: "BAR", label: "Bar / Pub", group: "Food Service" },
  { value: "FOOD_TRUCK", label: "Food Truck / Quick Service", group: "Food Service" },
  { value: "CLOUD_KITCHEN", label: "Cloud Kitchen", group: "Food Service" },
  { value: "FOOD_COURT", label: "Food Court", group: "Food Service" },
  // Retail (group 2)
  { value: "SUPERMARKET", label: "Supermarket / Grocery", group: "Retail" },
  { value: "GROCERY", label: "Grocery Store", group: "Retail" },
  { value: "CLOTHING", label: "Retail / Clothing", group: "Retail" },
  { value: "OTHER", label: "Other", group: "Retail" },
];

// Kept for backward compatibility with existing imports: all former legacy
// types are now first-class offered options (see list above).
const LEGACY_BUSINESS_TYPES = [];

// ─── Business document types ─────────────────────────────────────────────────
// No individual type is mandatory — the applicant must upload at least ONE
// valid document before continuing (enforced server-side at every gate).
const DOCUMENT_TYPES = [
  { value: "BUSINESS_REGISTRATION", label: "Business Registration Certificate" },
  { value: "GST_CERTIFICATE", label: "GST / Tax Registration" },
  { value: "TRADE_LICENSE", label: "Trade License" },
  { value: "FOOD_LICENSE", label: "Food License / FSSAI" },
  { value: "ADDRESS_PROOF", label: "Business Address Proof" },
  { value: "OWNER_ID", label: "Owner / Authorized Person ID" },
  { value: "OTHER", label: "Other Supporting Document" },
];

// Allowed file kinds for business documents. Extensions alone are never
// trusted — a magic-number check (validateDocumentBuffer) runs on the bytes.
const DOCUMENT_FILE_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];
const DOCUMENT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// MIME type → extension used when a document has a deceptive extension.
const DOCUMENT_MIME_EXTENSIONS = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/**
 * Magic-number validation — verifies the first bytes of a document match its
 * declared kind. Never trust the file extension or the client-provided MIME.
 * Returns null when the buffer looks valid, otherwise an error message.
 */
function validateDocumentBuffer(buffer, mimeType, originalName) {
  if (!buffer || buffer.length === 0) {
    return "The uploaded file is empty or could not be read.";
  }
  if (buffer.length > DOCUMENT_MAX_SIZE_BYTES) {
    return "File size must be 10 MB or less.";
  }

  const magic = (hex) => {
    const b = Buffer.from(hex, "hex");
    return buffer.length >= b.length && b.equals(buffer.subarray(0, b.length));
  };

  let detectedExt = null;
  if (magic("25504446")) detectedExt = "pdf"; // %PDF
  else if (magic("ffd8ff")) detectedExt = "jpg"; // JPEG SOI
  else if (magic("89504e470d0a1a0a")) detectedExt = "png"; // PNG

  if (!detectedExt) {
    return "Only PDF, JPG/JPEG and PNG files are supported. The uploaded file looks corrupted or is not a supported document.";
  }

  const expectedExt = DOCUMENT_MIME_EXTENSIONS[String(mimeType || "").toLowerCase()];
  // When the client MIME is present it must agree with the detected format.
  if (mimeType && expectedExt && expectedExt !== detectedExt) {
    return "The uploaded file's content does not match its declared type.";
  }

  const originalExt = path.extname(String(originalName || "")).toLowerCase();
  if (originalExt && ![".pdf", ".jpg", ".jpeg", ".png"].includes(originalExt)) {
    return "Only PDF, JPG, JPEG and PNG files are allowed.";
  }
  return null;
}

// ─── Legal policy versions ───────────────────────────────────────────────────
// The EXACT version the applicant accepted is stored on PolicyAgreement rows.
// When a policy is updated, bump its version here — existing acceptances stay
// on record with their old version and re-consent is required for the new one.
const POLICY_TYPES = {
  TERMS_OF_SERVICE: "TERMS_OF_SERVICE",
  PRIVACY_POLICY: "PRIVACY_POLICY",
  ACCURACY_CONFIRMATION: "ACCURACY_CONFIRMATION", // "information & documents are accurate"
};

const POLICY_VERSIONS = {
  TERMS_OF_SERVICE: "1.0",
  PRIVACY_POLICY: "1.0",
  ACCURACY_CONFIRMATION: "1.0",
};

// All policies the applicant must accept before plan selection, in display order.
const REQUIRED_POLICY_TYPES = [
  { type: POLICY_TYPES.TERMS_OF_SERVICE, label: "Terms & Conditions" },
  { type: POLICY_TYPES.PRIVACY_POLICY, label: "Privacy Policy" },
  { type: POLICY_TYPES.ACCURACY_CONFIRMATION, label: "Accuracy Confirmation" },
];

// ─── Onboarding stage model ──────────────────────────────────────────────────
// Canonical order of the self-serve stages. Statuses are stored on
// Restaurant.onboardingStatus after each successful milestone; the current
// stage is always re-derived from the DATA (see deriveStage in the service)
// so an applicant can never skip ahead by tampering with a status.
const STAGE_ORDER = [
  "REGISTERED", // account created, business details pending
  "ONBOARDING", // business details in progress
  "DOCUMENTS_PENDING", // business details done, documents pending
  "LEGAL_PENDING", // at least one document uploaded, legal pending
  "PLAN_PENDING", // legal accepted, plan not selected yet
  "PLAN_SELECTED", // plan selected, checkout not created
  "PAYMENT_PENDING", // checkout created, awaiting verified payment
  "PAYMENT_SUCCESS", // payment verified
  "UNDER_REVIEW", // payment verified — awaiting SUPER_ADMIN review (manual mode)
  "PROVISIONING", // tenant provisioning in progress
  "ACTIVE", // provisioned and activated
];

const TERMINAL_STAGES = ["REJECTED", "SUSPENDED", "EXPIRED"];

// Payment state constants shared by the flow (SubscriptionPayment.status values)
const PAYMENT_ROW_STATUS = {
  CREATED: "CREATED",
  PAID: "PAID",
  FAILED: "FAILED",
};

// ─── SystemSetting keys ──────────────────────────────────────────────────────
// Document review mode: { mode: "manual" | "auto" }
//   manual — payment verified → UNDER_REVIEW → SUPER_ADMIN approves → provision
//   auto   — payment verified → provision + activate immediately
const SETTING_REVIEW_MODE = "onboarding_review_mode";
const DEFAULT_REVIEW_MODE = "manual";

// ─── Manual payment onboarding flow constants ────────────────────────────────
// New simplified flow: register → submit application → PENDING →
// Super Admin reviews → manual payment via QR → Super Admin verifies →
// approve/reject
const MANUAL_PAYMENT_STATUS = {
  PENDING: "PENDING",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

// Stages for manual payment onboarding (stored on Restaurant.onboardingStatus)
const MANUAL_ONBOARDING_STAGES = [
  "MANUAL_PENDING",       // Application submitted, awaiting review
  "MANUAL_PAYMENT_PENDING", // Payment QR shown, awaiting payment
  "MANUAL_PAYMENT_RECEIVED", // Payment verified by Super Admin
  "MANUAL_APPROVED",       // Application approved, being provisioned
  "MANUAL_REJECTED",       // Application rejected
];

// Terminal stages for manual flow
const MANUAL_TERMINAL_STAGES = ["MANUAL_REJECTED", "MANUAL_APPROVED"];

// Map manual onboarding status to display labels
const MANUAL_STATUS_LABELS = {
  MANUAL_PENDING: "Application Submitted",
  MANUAL_PAYMENT_PENDING: "Payment Pending",
  MANUAL_PAYMENT_RECEIVED: "Payment Received",
  MANUAL_APPROVED: "Approved",
  MANUAL_REJECTED: "Rejected",
};

// Human-readable messages for each stage
const MANUAL_STATUS_MESSAGES = {
  MANUAL_PENDING: "Your application is pending review by Super Admin.",
  MANUAL_PAYMENT_PENDING: "Your application is awaiting payment verification.",
  MANUAL_PAYMENT_RECEIVED: "Payment received. Your application is awaiting Super Admin approval.",
  MANUAL_APPROVED: "Your application has been approved. You can now log in to the POS.",
  MANUAL_REJECTED: "Your application has been rejected.",
};

// ─── Self-serve application markers ──────────────────────────────────────────
// Statuses an account can hold while it is still going through (or stuck in)
// the self-serve onboarding flow — including the manual-review stages the
// applicant reaches after SUBMIT APPLICATION. Anything else is a normal
// restaurant. Login treats every one of these as an applicant (resume wizard
// / APPLICATION_PENDING), never as a POS session.
const SELF_SERVE_IN_PROGRESS = [
  "REGISTERED",
  "ONBOARDING",
  "DOCUMENTS_PENDING",
  "LEGAL_PENDING",
  "PLAN_PENDING",
  "PLAN_SELECTED",
  "PAYMENT_PENDING",
  "PAYMENT_SUCCESS",
  "UNDER_REVIEW",
  "PROVISIONING",
  "PAYMENT_FAILED",
  "DOCUMENT_REJECTED",
  "REJECTED",
  "SUSPENDED",
  "EXPIRED",
  ...MANUAL_ONBOARDING_STAGES,
];

// Stage keys the frontend wizard uses to render the right step. There is NO
// payment step in the applicant wizard: after plan selection the applicant
// reviews their application and submits it (review), then waits on the
// pending screen until SUPER_ADMIN approval.
const STEP_BY_STAGE = {
  REGISTERED: "business",
  ONBOARDING: "business",
  DOCUMENTS_PENDING: "documents",
  LEGAL_PENDING: "legal",
  PLAN_PENDING: "plan",
  PLAN_SELECTED: "review",
  PAYMENT_PENDING: "review",
  PAYMENT_SUCCESS: "review",
  UNDER_REVIEW: "under_review",
  PROVISIONING: "provisioning",
  ACTIVE: "complete",
  PAYMENT_FAILED: "review",
  DOCUMENT_REJECTED: "documents",
  REJECTED: "blocked",
  SUSPENDED: "blocked",
  EXPIRED: "blocked",
  // Manual-review application stages (SUBMIT APPLICATION onward).
  MANUAL_PENDING: "pending",
  MANUAL_PAYMENT_PENDING: "pending",
  MANUAL_PAYMENT_RECEIVED: "pending",
  MANUAL_APPROVED: "complete",
  MANUAL_REJECTED: "blocked",
};

// ─── Private document storage ────────────────────────────────────────────────
// Business documents live under uploads/documents, which is NOT exposed by the
// public static file server (see app.js). They are reachable only through the
// authorized download endpoints (owner + SUPER_ADMIN).
const DOCUMENTS_UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads", "documents");
const DOCUMENT_FILE_REFERENCE_PREFIX = "documents/"; // matches fileReference format of the SA flow

module.exports = {
  BUSINESS_TYPES,
  LEGACY_BUSINESS_TYPES,
  DOCUMENT_TYPES,
  DOCUMENT_FILE_EXTENSIONS,
  DOCUMENT_MAX_SIZE_BYTES,
  DOCUMENT_MIME_EXTENSIONS,
  validateDocumentBuffer,
  POLICY_TYPES,
  POLICY_VERSIONS,
  REQUIRED_POLICY_TYPES,
  STAGE_ORDER,
  TERMINAL_STAGES,
  PAYMENT_ROW_STATUS,
  SETTING_REVIEW_MODE,
  DEFAULT_REVIEW_MODE,
  MANUAL_PAYMENT_STATUS,
  MANUAL_ONBOARDING_STAGES,
  MANUAL_TERMINAL_STAGES,
  MANUAL_STATUS_LABELS,
  MANUAL_STATUS_MESSAGES,
  SELF_SERVE_IN_PROGRESS,
  STEP_BY_STAGE,
  DOCUMENTS_UPLOAD_DIR,
  DOCUMENT_FILE_REFERENCE_PREFIX,
};
