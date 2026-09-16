/**
 * Self-serve restaurant onboarding service.
 *
 * Implements the PUBLIC registration flow:
 *   Register → Business details → Documents (≥1 valid) → Legal acceptance →
 *   Plan selection → Payment → Backend payment verification → Review or
 *   provisioning → ACTIVE.
 *
 * Tenant isolation is preserved: the owner/contact ADMIN lives in the public
 * User table (like every restaurant ADMIN), business documents / legal
 * acceptances / the subscription live in the public schema, and the tenant
 * schema (restaurant_N with staff + operational data) is created ONLY after
 * the payment has been verified server-side (or the SUPER_ADMIN has approved
 * the application in manual-review mode).
 *
 * Nothing in this file trusts the frontend: stage order is re-derived from
 * data, uploads are magic-number validated, payment success comes exclusively
 * from Razorpay signature/webhook verification, and provisioning is guarded to
 * be idempotent.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { platformPrisma: prisma } = require("../config/tenantPrisma");
const { isEmailVerified } = require("./email-verification.service");
const {
  sendApplicationReceivedEmail,
  sendNewApplicationEmail,
  sendApplicationApprovedEmail,
  sendApplicationRejectedEmail,
} = require("./email.service");
const { getEmailConfig } = require("../config/email.config");
const { getTenantClient, generateSchemaName } = require("../config/tenantPrisma");
const { createAuditLog } = require("./audit.service");
const { initializeTenantSchema } = require("../utils/tenantSchema");
const { planToSnapshot, computeExpiryDate, getRestaurantSubscription } = require("../utils/subscription");
const { FEATURE_SETTINGS_MAP } = require("../config/subscription.config");
const { isGatewayReady } = require("./gateway-config.service");
const {
  createRazorpayOrder,
  verifyPaymentSignature,
} = require("./razorpay.service");
const { normalizeEmail } = require("../utils/email");
const { resolveBusinessMode, normalizeBusinessType, assertPlanCompatibleWithBusinessType } = require("../utils/businessMode");
const {
  BUSINESS_TYPES,
  DOCUMENT_TYPES,
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
  validateDocumentBuffer,
  DOCUMENT_MAX_SIZE_BYTES,
} = require("../config/onboarding.config");

// Billing cycle offered to new applicants (matches the yearly-only purchase rule).
const ONBOARDING_BILLING_CYCLE = "YEARLY";

// Self-serve applications expire this many days after submission if the Super
// Admin has not approved them (applicant is emailed exactly once on expiry).
const APPLICATION_EXPIRY_DAYS = 30;

// A document counts as "valid" while it is uploaded, under review or verified.
const VALID_DOCUMENT_STATUSES = ["PENDING", "UNDER_REVIEW", "VERIFIED"];

function apiError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode || 400;
  return err;
}

async function getSetting(key, fallback) {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    if (row && row.value !== null && row.value !== undefined) return row.value;
  } catch (_) { /* fall back */ }
  return fallback;
}

async function setSetting(key, value) {
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

// ─── Review mode (SystemSetting-backed, default manual) ─────────────────────
async function getReviewMode() {
  const stored = await getSetting(SETTING_REVIEW_MODE, null);
  const mode = stored && stored.mode === "auto" ? "auto" : DEFAULT_REVIEW_MODE;
  return { mode, auto: mode === "auto", manual: mode === "manual" };
}

async function setReviewMode(mode) {
  const clean = mode === "auto" ? "auto" : "manual";
  await setSetting(SETTING_REVIEW_MODE, { mode: clean, updatedAt: new Date().toISOString() });
  return { mode: clean };
}

// ─── Pure stage derivation ───────────────────────────────────────────────────
/**
 * Derive the applicant's current onboarding stage from DATA (never from a
 * client-supplied status). Returns { stage, step, label }.
 *
 * @param {object} data
 *  - restaurantExists, businessComplete (boolean)
 *  - validDocuments (count), rejectedDocuments (count)
 *  - legalAccepted (boolean — all required policies accepted at current version)
 *  - planSelected (boolean — a Subscription row exists)
 *  - paymentStatus (null | CREATED | PAID | FAILED)
 *  - provisioned (boolean — restaurant.tenantSchema is set)
 *  - terminal (null | REJECTED | SUSPENDED | EXPIRED — overrides everything)
 */
// Manual-review application status → wizard page. The stored MANUAL_* status
// is authoritative once the applicant has SUBMITTED the application — it can
// never be re-derived from payment rows (manual flow has none).
// MANUAL_APPROVED surfaces as ACTIVE: the restaurant IS active at that point,
// so fresh logins / app refreshes resume straight into the POS instead of the
// wizard (the wizard only shows its Complete screen during the transition).
const MANUAL_STAGE_BY_STATUS = {
  MANUAL_PENDING: { stage: "MANUAL_PENDING", step: "pending" },
  MANUAL_PAYMENT_PENDING: { stage: "MANUAL_PAYMENT_PENDING", step: "pending" },
  MANUAL_PAYMENT_RECEIVED: { stage: "MANUAL_PAYMENT_RECEIVED", step: "pending" },
  MANUAL_APPROVED: { stage: "ACTIVE", step: "complete" },
  MANUAL_REJECTED: { stage: "MANUAL_REJECTED", step: "blocked" },
};

function deriveStage(data) {
  if (data.terminal) return { stage: data.terminal, step: "blocked" };
  // A submitted manual application is frozen at its stored status — the
  // applicant can no longer be routed back into the wizard steps.
  if (data.storedStatus && MANUAL_ONBOARDING_STAGES.includes(data.storedStatus)) {
    return MANUAL_STAGE_BY_STATUS[data.storedStatus] || { stage: data.storedStatus, step: "pending" };
  }

  // An ACTIVE restaurant IS onboarded — full stop. Its stored onboardingStatus
  // may be stale/legacy (null, PLAN_SELECTED, …) and its subscription may have
  // no PAID onboarding payment row (e.g. Super Admin-created tenants), but the
  // account must NEVER be re-derived into a wizard stage like PLAN_SELECTED:
  // that would hand normal POS users a bogus applicant payload whose only
  // effect is a 403 loop on /onboarding/status. Backend status = truth.
  if (data.restaurantExists && data.restaurantStatus === "ACTIVE") {
    return { stage: "ACTIVE", step: "complete" };
  }

  if (!data.restaurantExists) {
    return { stage: "REGISTERED", step: "business" };
  }
  if (!data.businessComplete) {
    return { stage: "ONBOARDING", step: "business" };
  }
  if (data.paymentStatus === "PAID") {
    if (data.provisioned) return { stage: "ACTIVE", step: "complete" };
    // Verified but not yet provisioned → queued for SUPER_ADMIN approval
    // (manual mode) or mid-provisioning (auto mode). Both surface as "review".
    return { stage: "UNDER_REVIEW", step: "review" };
  }
  if (data.paymentStatus === "FAILED") {
    return { stage: "PAYMENT_FAILED", step: "payment" };
  }
  if (data.paymentStatus === "CREATED") {
    return { stage: "PAYMENT_PENDING", step: "payment" };
  }
  if (data.planSelected) {
    return { stage: "PLAN_SELECTED", step: "payment" };
  }
  if (data.legalAccepted) {
    return { stage: "PLAN_PENDING", step: "plan" };
  }
  if (data.validDocuments === 0) {
    return data.rejectedDocuments > 0
      ? { stage: "DOCUMENT_REJECTED", step: "documents" }
      : { stage: "DOCUMENTS_PENDING", step: "documents" };
  }
  return { stage: "LEGAL_PENDING", step: "legal" };
}

function stageLabel(stage) {
  const map = {
    REGISTERED: "Account created",
    ONBOARDING: "Business details in progress",
    DOCUMENTS_PENDING: "Business details completed — documents pending",
    LEGAL_PENDING: "Documents uploaded — legal acceptance pending",
    PLAN_PENDING: "Legal accepted — plan selection pending",
    PLAN_SELECTED: "Plan selected — ready to submit",
    PAYMENT_PENDING: "Payment pending verification",
    PAYMENT_SUCCESS: "Payment verified",
    UNDER_REVIEW: "Under review",
    PROVISIONING: "Account setup in progress",
    ACTIVE: "Active",
    PAYMENT_FAILED: "Payment failed",
    DOCUMENT_REJECTED: "A document was rejected — replacement required",
    REJECTED: "Application rejected",
    SUSPENDED: "Account suspended",
    EXPIRED: "Application expired",
    DRAFT: "Draft",
    PENDING_DOCUMENT_REVIEW: "Documents under review",
  };
  // Manual-review stages get their own human labels.
  if (MANUAL_STATUS_LABELS[stage]) return MANUAL_STATUS_LABELS[stage];
  return map[stage] || stage;
}

// ─── Onboarding context (GET /onboarding/status + login payload) ─────────────
async function loadOnboardingData(restaurantId) {
  const restaurant = restaurantId
    ? await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        include: {
          documents: true,
          policyAgreements: true,
          subscription: true,
        },
      })
    : null;
  if (!restaurant) {
    return {
      restaurant: null,
      validDocuments: 0,
      rejectedDocuments: 0,
      legalAccepted: false,
      planSelected: false,
      paymentStatus: null,
      provisioned: false,
    };
  }

  const validDocuments = restaurant.documents.filter((d) => VALID_DOCUMENT_STATUSES.includes(d.status)).length;
  const rejectedDocuments = restaurant.documents.filter((d) => d.status === "REJECTED").length;

  // Legal acceptance requires the CURRENT version of each required policy.
  const accepted = {};
  restaurant.policyAgreements.forEach((pa) => {
    const current = POLICY_VERSIONS[pa.policyType];
    if (current && String(pa.policyVersion) === String(current)) {
      accepted[pa.policyType] = true;
    }
  });
  const legalAccepted = REQUIRED_POLICY_TYPES.every((p) => accepted[p.type]);

  let paymentStatus = null;
  if (restaurant.subscription) {
    const latest = await prisma.subscriptionPayment.findFirst({
      where: { subscriptionId: restaurant.subscription.id },
      orderBy: { createdAt: "desc" },
    });
    paymentStatus = latest ? latest.status : null;
  }

  return {
    restaurant,
    validDocuments,
    rejectedDocuments,
    legalAccepted,
    planSelected: !!restaurant.subscription,
    paymentStatus,
    provisioned: !!restaurant.tenantSchema,
  };
}

/**
 * Build the canonical onboarding payload returned by GET /onboarding/status
 * and embedded in /auth/login for in-progress self-serve accounts.
 */
async function buildOnboardingPayload(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, phone: true, role: true, restaurantId: true, isActive: true },
  });
  if (!user || user.role !== "ADMIN") return null;

  const restaurantId = user.restaurantId;
  const data = await loadOnboardingData(restaurantId);
  const restaurant = data.restaurant;

  // A restaurant created by the Super Admin (or any other non-self-serve
  // channel) is NOT an onboarding application: its ADMIN is a normal POS user
  // and must never receive an applicant payload (which only produces 403s
  // when the frontend then probes /onboarding/status).
  if (restaurant && restaurant.selfServe === false) {
    return null;
  }

  const terminal =
    restaurant && TERMINAL_STAGES.includes(restaurant.onboardingStatus)
      ? restaurant.onboardingStatus
      : null;
  const stageInfo = deriveStage({
    restaurantExists: !!restaurant,
    businessComplete: !!(restaurant && restaurant.name),
    // The raw stored restaurant.status — lets deriveStage short-circuit an
    // ACTIVE (already onboarded) restaurant regardless of stale/legacy
    // onboardingStatus or a missing PAID payment row.
    restaurantStatus: restaurant ? restaurant.status : null,
    validDocuments: data.validDocuments,
    rejectedDocuments: data.rejectedDocuments,
    legalAccepted: data.legalAccepted,
    planSelected: data.planSelected,
    paymentStatus: data.paymentStatus,
    provisioned: data.provisioned,
    terminal,
    // The stored status is authoritative for submitted manual applications.
    storedStatus: restaurant ? restaurant.onboardingStatus : null,
  });

  const { mode } = await getReviewMode();

  const documents = (restaurant ? restaurant.documents : [])
    .map((d) => ({
      id: d.id,
      documentType: d.documentType,
      originalFileName: d.originalFileName,
      mimeType: d.mimeType,
      fileSize: d.fileSize,
      status: d.status,
      rejectionReason: d.rejectionReason,
      uploadedAt: d.uploadedAt,
    }))
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  const agreements = restaurant ? restaurant.policyAgreements : [];
  const agreementFor = (type) => {
    const found = agreements
      .filter((pa) => pa.policyType === type)
      .sort((a, b) => new Date(b.acceptedAt) - new Date(a.acceptedAt))[0];
    return found
      ? { version: found.policyVersion, acceptedAt: found.acceptedAt, ipAddress: found.ipAddress }
      : null;
  };

  const subscription = restaurant && restaurant.subscription ? restaurant.subscription : null;
  let selectedPlan = null;
  let payment = null;
  if (subscription) {
    const planDef = subscription.planId
      ? await prisma.plan.findUnique({ where: { id: subscription.planId }, select: { id: true, code: true, name: true, yearlyPrice: true, description: true } })
      : null;
    selectedPlan = {
      id: planDef ? planDef.id : null,
      code: subscription.plan || (planDef ? planDef.code : null),
      name: planDef ? planDef.name : subscription.plan,
      yearlyPrice: planDef ? planDef.yearlyPrice : subscription.amount,
      billingCycle: subscription.billingCycle || ONBOARDING_BILLING_CYCLE,
      amount: subscription.amount,
    };
    if (data.paymentStatus) {
      const row = await prisma.subscriptionPayment.findFirst({
        where: { subscriptionId: subscription.id },
        orderBy: { createdAt: "desc" },
      });
      payment = row
        ? {
            subscriptionPaymentId: row.id,
            status: row.status,
            amount: row.amount,
            planCode: row.planCode,
            billingCycle: row.billingCycle,
            razorpayOrderId: row.razorpayOrderId,
            razorpayPaymentId: row.razorpayPaymentId,
            errorMessage: row.errorMessage,
            paidAt: row.paidAt,
            createdAt: row.createdAt,
          }
        : null;
    }
  }

  const safeRestaurant = restaurant
    ? {
        id: restaurant.id,
        name: restaurant.name,
        legalName: restaurant.legalName,
        registrationNumber: restaurant.registrationNumber,
        selfServe: restaurant.selfServe,
        businessType: restaurant.businessType,
        ownerName: restaurant.ownerName,
        email: restaurant.email,
        phone: restaurant.phone,
        gstNumber: restaurant.gstNumber,
        fssaiNumber: restaurant.fssaiNumber,
        address: restaurant.address,
        city: restaurant.city,
        state: restaurant.state,
        country: restaurant.country,
        pincode: restaurant.pincode,
        website: restaurant.website,
        currency: restaurant.currency,
        timezone: restaurant.timezone,
        status: restaurant.status,
        onboardingStatus: restaurant.onboardingStatus,
        onboardingNote: restaurant.onboardingNote,
        tenantSchema: restaurant.tenantSchema,
      }
    : null;

  return {
    account: {
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
      status: stageInfo.stage,
      step: stageInfo.step,
      label: stageLabel(stageInfo.stage),
      restaurantId: restaurant ? restaurant.id : null,
    },
    restaurant: safeRestaurant,
    steps: {
      accountCreated: true,
      businessComplete: !!restaurant,
      documentsUploaded: data.validDocuments > 0,
      legalAccepted: data.legalAccepted,
      planSelected: data.planSelected,
      paymentVerified: data.paymentStatus === "PAID",
      provisioned: data.provisioned,
      active: stageInfo.stage === "ACTIVE",
      blocked: TERMINAL_STAGES.includes(stageInfo.stage) || stageInfo.stage === "MANUAL_REJECTED",
    },
    documents,
    legal: {
      termsOfService: agreementFor(POLICY_TYPES.TERMS_OF_SERVICE),
      privacyPolicy: agreementFor(POLICY_TYPES.PRIVACY_POLICY),
      accuracyConfirmation: agreementFor(POLICY_TYPES.ACCURACY_CONFIRMATION),
      required: REQUIRED_POLICY_TYPES.map((p) => ({ type: p.type, label: p.label, version: POLICY_VERSIONS[p.type] })),
    },
    selectedPlan,
    payment,
    review: { mode },
  };
}

// ─── Onboarding config (public GET) ──────────────────────────────────────────
async function getOnboardingConfig() {
  return {
    businessTypes: BUSINESS_TYPES,
    documentTypes: DOCUMENT_TYPES,
    policies: REQUIRED_POLICY_TYPES.map((p) => ({
      type: p.type,
      label: p.label,
      version: POLICY_VERSIONS[p.type],
    })),
    billingCycles: [{ value: "YEARLY", label: "Yearly" }],
    maxDocumentSizeBytes: DOCUMENT_MAX_SIZE_BYTES,
    allowedDocumentExtensions: [".pdf", ".jpg", ".jpeg", ".png"],
  };
}

// ─── Business details ────────────────────────────────────────────────────────
async function createOrUpdateBusiness(userId, restaurantId, data) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== "ADMIN") throw apiError("Invalid onboarding account", 403);

  // Canonical business email (trim + lowercase) — one identity per address.
  if (data.email) data.email = normalizeEmail(data.email);

  // A single email may never own two applications.
  const dupEmail = await prisma.restaurant.findFirst({
    where: { email: data.email ? data.email : "__none__", deletedAt: null, id: { not: restaurantId || -1 } },
  });
  if (dupEmail) throw apiError("A business with this email already exists", 400);
  const dupPhone = await prisma.restaurant.findFirst({
    where: { phone: data.phone, deletedAt: null, id: { not: restaurantId || -1 } },
  });
  if (dupPhone) throw apiError("A business with this phone number already exists", 400);

  const businessType = BUSINESS_TYPES.some((b) => b.value === data.businessType)
    ? data.businessType
    : "OTHER";

  let restaurant;
  if (restaurantId) {
    // Editing an in-progress application (only before activation).
    const existing = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!existing || existing.deletedAt) throw apiError("Restaurant not found", 404);
    if (!existing.selfServe) throw apiError("This restaurant cannot be edited through onboarding", 403);
    if (existing.status === "ACTIVE") throw apiError("This account is already active", 409);
    restaurant = await prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        name: data.name,
        legalName: data.legalName || null,
        registrationNumber: data.registrationNumber || null,
        ownerName: data.ownerName || existing.ownerName || user.name,
        email: data.email ? normalizeEmail(data.email) : null,
        phone: data.phone,
        businessType,
        gstNumber: data.gstNumber || null,
        fssaiNumber: data.fssaiNumber || null,
        address: data.address || null,
        city: data.city || null,
        state: data.state || null,
        country: data.country || "India",
        pincode: data.pincode || null,
        website: data.website || null,
        currency: data.currency || existing.currency || "INR",
        timezone: data.timezone || existing.timezone || "Asia/Kolkata",
      },
    });
  } else {
    restaurant = await prisma.restaurant.create({
      data: {
        name: data.name,
        legalName: data.legalName || null,
        registrationNumber: data.registrationNumber || null,
        ownerName: data.ownerName || user.name,
        email: data.email ? normalizeEmail(data.email) : null,
        phone: data.phone,
        businessType,
        gstNumber: data.gstNumber || null,
        fssaiNumber: data.fssaiNumber || null,
        address: data.address || null,
        city: data.city || null,
        state: data.state || null,
        country: data.country || "India",
        pincode: data.pincode || null,
        website: data.website || null,
        currency: data.currency || "INR",
        timezone: data.timezone || "Asia/Kolkata",
        status: "INACTIVE",
        selfServe: true,
        onboardingStatus: "DOCUMENTS_PENDING",
      },
    });
    // Link the owner (ADMIN) to the restaurant — the database relationship is
    // the ONLY source of tenant identity; never a client-supplied id.
    await prisma.user.update({ where: { id: userId }, data: { restaurantId: restaurant.id } });
  }

  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { onboardingStatus: await currentStoredStage(restaurant.id, "DOCUMENTS_PENDING") },
  });
  await createAuditLog({
    restaurantId: restaurant.id,
    userId,
    module: "USER",
    action: "CREATE",
    description: `Self-serve application business details ${restaurantId ? "updated" : "submitted"}: ${restaurant.name} (${businessType})`,
    referenceId: restaurant.id,
    referenceNo: restaurant.name,
    ipAddress: data._ip,
    userAgent: data._ua,
  });
  return buildOnboardingPayload(userId);
}

// ─── Stage persistence helpers ───────────────────────────────────────────────
/** Recompute + persist the canonical stage for a restaurant (data-driven). */
async function currentStoredStage(restaurantId, fallback) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: { documents: true, policyAgreements: true, subscription: true },
  });
  if (!restaurant) return fallback;
  if (TERMINAL_STAGES.includes(restaurant.onboardingStatus)) return restaurant.onboardingStatus;
  // Submitted manual applications are frozen — never re-derived from data.
  if (MANUAL_ONBOARDING_STAGES.includes(restaurant.onboardingStatus)) return restaurant.onboardingStatus;

  const validDocuments = restaurant.documents.filter((d) => VALID_DOCUMENT_STATUSES.includes(d.status)).length;
  const rejectedDocuments = restaurant.documents.filter((d) => d.status === "REJECTED").length;

  const accepted = {};
  restaurant.policyAgreements.forEach((pa) => {
    const current = POLICY_VERSIONS[pa.policyType];
    if (current && String(pa.policyVersion) === String(current)) accepted[pa.policyType] = true;
  });
  const legalAccepted = REQUIRED_POLICY_TYPES.every((p) => accepted[p.type]);

  let paymentStatus = null;
  if (restaurant.subscription) {
    const latest = await prisma.subscriptionPayment.findFirst({
      where: { subscriptionId: restaurant.subscription.id },
      orderBy: { createdAt: "desc" },
    });
    paymentStatus = latest ? latest.status : null;
  }

  return deriveStage({
    restaurantExists: true,
    businessComplete: !!restaurant.name,
    restaurantStatus: restaurant.status,
    validDocuments,
    rejectedDocuments,
    legalAccepted,
    planSelected: !!restaurant.subscription,
    paymentStatus,
    provisioned: !!restaurant.tenantSchema,
    terminal: null,
  }).stage;
}

async function persistStage(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) return null;
  // Never rewrite special states: active, SA-reviewing, terminal statuses, or
  // submitted manual-review applications.
  if (["UNDER_REVIEW", "PROVISIONING", "ACTIVE", "REJECTED", "SUSPENDED", "EXPIRED"].includes(restaurant.onboardingStatus) || MANUAL_ONBOARDING_STAGES.includes(restaurant.onboardingStatus)) {
    return restaurant.onboardingStatus;
  }
  const stage = await currentStoredStage(restaurantId, null);
  if (stage) {
    await prisma.restaurant.update({ where: { id: restaurantId }, data: { onboardingStatus: stage } });
  }
  return stage;
}

// ─── Business documents ──────────────────────────────────────────────────────
/** Validate + persist an uploaded business document (magic-number checked). */
async function createDocument(userId, restaurant, file, documentType, ipAddress, userAgent) {
  if (!file || !file.buffer) throw apiError("No file uploaded", 400);
  const type = DOCUMENT_TYPES.some((d) => d.value === documentType) ? documentType : null;
  if (!type) throw apiError("documentType is not a valid document type", 400);

  const validationError = validateDocumentBuffer(file.buffer, file.mimetype, file.originalname);
  if (validationError) throw apiError(validationError, 400);

  // Secure random filename — original names are stored only as metadata.
  const ext = path.extname(String(file.originalname || "")).toLowerCase() || ".pdf";
  const safeExt = [".pdf", ".jpg", ".jpeg", ".png"].includes(ext) ? ext : ".pdf";
  const fileName = crypto.randomUUID() + safeExt;
  fs.mkdirSync(DOCUMENTS_UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCUMENTS_UPLOAD_DIR, fileName), file.buffer);

  const doc = await prisma.restaurantDocument.create({
    data: {
      restaurantId: restaurant.id,
      documentType: type,
      fileReference: `documents/${fileName}`,
      originalFileName: String(file.originalname || fileName).slice(0, 255),
      mimeType: file.mimetype || null,
      fileSize: file.buffer.length,
      // Uploaded for review immediately — never trusted until verified.
      status: "UNDER_REVIEW",
      uploadedBy: userId,
    },
  });

  await persistStage(restaurant.id);
  await createAuditLog({
    restaurantId: restaurant.id,
    userId,
    module: "USER",
    action: "CREATE",
    description: `Onboarding document uploaded: ${type}`,
    referenceId: doc.id,
    ipAddress,
    userAgent,
  });
  return doc;
}

async function listDocuments(restaurantId) {
  return prisma.restaurantDocument.findMany({
    where: { restaurantId: Number(restaurantId) },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      documentType: true,
      originalFileName: true,
      mimeType: true,
      fileSize: true,
      status: true,
      rejectionReason: true,
      uploadedAt: true,
    },
  });
}

/** Resolve the on-disk file for a document row (path-traversal safe). */
function resolveDocumentFilePath(doc) {
  const ref = String(doc.fileReference || "");
  if (!ref.startsWith("documents/")) throw apiError("Document is not stored locally", 400);
  const fileName = path.basename(ref); // strip any directory component
  const full = path.resolve(DOCUMENTS_UPLOAD_DIR, fileName);
  const root = path.resolve(DOCUMENTS_UPLOAD_DIR);
  if (!full.startsWith(root + path.sep)) throw apiError("Invalid document path", 400);
  if (!fs.existsSync(full)) throw apiError("Document file is missing on disk", 404);
  return full;
}

async function getOwnedDocument(restaurantId, documentId) {
  const doc = await prisma.restaurantDocument.findUnique({ where: { id: Number(documentId) } });
  if (!doc || doc.restaurantId !== Number(restaurantId)) throw apiError("Document not found", 404);
  return doc;
}

// ─── Legal acceptance ────────────────────────────────────────────────────────
/**
 * Record the applicant's explicit acceptance of the required policies.
 * acceptances: [{ type, version }]. The stored version MUST equal the current
 * policy version from the backend config — a client can never record consent
 * to a version that does not exist.
 */
async function acceptLegal(userId, restaurant, acceptances, ipAddress, userAgent) {
  const docs = await prisma.restaurantDocument.count({
    where: { restaurantId: restaurant.id, status: { in: VALID_DOCUMENT_STATUSES } },
  });
  if (docs < 1) {
    throw apiError("Please upload at least one valid business document before accepting the legal agreements", 400);
  }

  const incoming = Array.isArray(acceptances) ? acceptances : [];
  if (incoming.length === 0) throw apiError("At least one agreement acceptance is required", 400);

  const byType = {};
  incoming.forEach((a) => {
    if (a && a.type) byType[a.type] = a.version;
  });

  const created = [];
  for (const p of REQUIRED_POLICY_TYPES) {
    const version = byType[p.type];
    if (!version) throw apiError(`${p.label} must be accepted before continuing`, 400);
    if (String(version) !== String(POLICY_VERSIONS[p.type])) {
      throw apiError(`${p.label} version mismatch: accept version ${POLICY_VERSIONS[p.type]}`, 400);
    }
    // Acceptances are append-only audit rows — never overwrite an earlier one.
    const row = await prisma.policyAgreement.create({
      data: {
        restaurantId: restaurant.id,
        policyType: p.type,
        policyVersion: String(version),
        acceptedBy: userId,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
      },
    });
    created.push(row);
  }

  await persistStage(restaurant.id);
  await createAuditLog({
    restaurantId: restaurant.id,
    userId,
    module: "USER",
    action: "CREATE",
    description: "Self-serve legal agreements accepted (terms, privacy, accuracy)",
    referenceId: restaurant.id,
    ipAddress,
    userAgent,
  });
  return created;
}

// ─── Plans ───────────────────────────────────────────────────────────────────
async function listPublicPlans(opts = {}) {
  // Plans are filtered by the mode derived from the requested business type
  // (?businessType=RESTAURANT → Restaurant-mode plans only, anything else →
  // Basic-mode plans only). Without the param all active plans are returned
  // (backward compatible) — compatibility is still enforced at assignment.
  const where = { isActive: true, code: { not: "TRIAL" } };
  const requestedType = normalizeBusinessType(opts.businessType);
  if (requestedType) where.businessMode = resolveBusinessMode(requestedType);
  const plans = await prisma.plan.findMany({
    where,
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      description: true,
      businessMode: true,
      yearlyPrice: true,
      monthlyPrice: true,
      maxUsers: true,
      maxTables: true,
      maxMenuItems: true,
      maxOrdersPerMonth: true,
      storageLimitMB: true,
      features: true,
    },
  });
  return plans.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    businessMode: p.businessMode,
    yearlyPrice: Number(p.yearlyPrice || 0),
    billingCycle: ONBOARDING_BILLING_CYCLE,
    limits: {
      maxUsers: p.maxUsers,
      maxTables: p.maxTables,
      maxMenuItems: p.maxMenuItems,
      maxOrdersPerMonth: p.maxOrdersPerMonth,
      storageLimitMB: p.storageLimitMB,
    },
    features: p.features || [],
  }));
}

async function selectPlan(userId, restaurant, planId) {
  const plan = await prisma.plan.findUnique({ where: { id: Number(planId) } });
  if (!plan || !plan.isActive) throw apiError("Selected plan is not available", 400);
  if (plan.code === "TRIAL") throw apiError("The Trial plan cannot be purchased", 400);

  // Business-type → plan-mode compatibility is derived SERVER-SIDE from the
  // businessType already stored on the application — a client-supplied
  // businessMode is never trusted (spec §8).
  assertPlanCompatibleWithBusinessType(restaurant.businessType, plan);

  // Prerequisite gates — order is enforced by data, not by the client.
  const docs = await prisma.restaurantDocument.count({
    where: { restaurantId: restaurant.id, status: { in: VALID_DOCUMENT_STATUSES } },
  });
  if (docs < 1) throw apiError("Please upload at least one valid business document before selecting a plan", 400);
  const legal = await prisma.policyAgreement.count({
    where: {
      restaurantId: restaurant.id,
      OR: REQUIRED_POLICY_TYPES.map((p) => ({
        policyType: p.type,
        policyVersion: String(POLICY_VERSIONS[p.type]),
      })),
    },
  });
  // legal must cover ALL required policy types at the current version
  const distinct = await prisma.policyAgreement.groupBy({
    by: ["policyType"],
    where: {
      restaurantId: restaurant.id,
      OR: REQUIRED_POLICY_TYPES.map((p) => ({
        policyType: p.type,
        policyVersion: String(POLICY_VERSIONS[p.type]),
      })),
    },
  });
  if (distinct.length < REQUIRED_POLICY_TYPES.length) {
    throw apiError("Accept the Terms & Conditions, Privacy Policy and accuracy confirmation before selecting a plan", 400);
  }

  const existing = await prisma.subscription.findUnique({ where: { restaurantId: restaurant.id } });
  if (existing && existing.status === "ACTIVE") {
    throw apiError("This account is already active", 409);
  }

  const snapshot = planToSnapshot(plan, ONBOARDING_BILLING_CYCLE);
  const amount = Number(plan.yearlyPrice || 0);
  if (amount <= 0) throw apiError("This plan has no yearly price configured", 400);

  const startDate = new Date();
  const expiryDate = computeExpiryDate(startDate, ONBOARDING_BILLING_CYCLE);

  const subscription = existing
    ? await prisma.subscription.update({
        where: { restaurantId: restaurant.id },
        data: {
          planId: plan.id,
          plan: plan.code,
          status: "PENDING_PAYMENT",
          businessMode: snapshot.businessMode,
          startDate,
          expiryDate,
          nextRenewalDate: expiryDate,
          billingCycle: ONBOARDING_BILLING_CYCLE,
          autoRenew: snapshot.autoRenew,
          maxUsers: snapshot.maxUsers,
          maxTables: snapshot.maxTables,
          maxFloors: snapshot.maxFloors,
          maxMenuItems: snapshot.maxMenuItems,
          maxPrinters: snapshot.maxPrinters,
          maxBranches: snapshot.maxBranches,
          maxOrdersPerMonth: snapshot.maxOrdersPerMonth,
          storageLimitMB: snapshot.storageLimitMB,
          features: snapshot.features,
          amount,
          cancelledAt: null,
          cancelledReason: null,
        },
      })
    : await prisma.subscription.create({
        data: {
          restaurantId: restaurant.id,
          planId: plan.id,
          plan: plan.code,
          status: "PENDING_PAYMENT",
          businessMode: snapshot.businessMode,
          startDate,
          expiryDate,
          nextRenewalDate: expiryDate,
          billingCycle: ONBOARDING_BILLING_CYCLE,
          autoRenew: snapshot.autoRenew,
          maxUsers: snapshot.maxUsers,
          maxTables: snapshot.maxTables,
          maxFloors: snapshot.maxFloors,
          maxMenuItems: snapshot.maxMenuItems,
          maxPrinters: snapshot.maxPrinters,
          maxBranches: snapshot.maxBranches,
          maxOrdersPerMonth: snapshot.maxOrdersPerMonth,
          storageLimitMB: snapshot.storageLimitMB,
          features: snapshot.features,
          amount,
        },
      });

  // Chosen plan is stored against the onboarding record — mark the stage.
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { onboardingStatus: "PLAN_SELECTED" },
  });

  return {
    plan: { id: plan.id, code: plan.code, name: plan.name, description: plan.description },
    billingCycle: ONBOARDING_BILLING_CYCLE,
    amount,
    expiryDate,
    subscriptionId: subscription.id,
  };
}

// ─── Payment ─────────────────────────────────────────────────────────────────
async function createCheckout(userId, restaurant, meta) {
  const subscription = await prisma.subscription.findUnique({ where: { restaurantId: restaurant.id } });
  if (!subscription) throw apiError("Select a plan before continuing to payment", 400);
  if (subscription.status === "ACTIVE") throw apiError("This account is already active", 409);

  const paidRow = await prisma.subscriptionPayment.findFirst({
    where: { subscriptionId: subscription.id, status: "PAID" },
  });
  if (paidRow) throw apiError("Payment for this plan has already been verified", 409);

  const gatewayReady = await isGatewayReady();
  if (!gatewayReady) {
    throw apiError("Online payments are currently unavailable. Please contact support.", 503);
  }

  let order;
  try {
    order = await createRazorpayOrder({
      amount: subscription.amount,
      receipt: `ONB-${subscription.id}-${Date.now()}`,
    });
  } catch (e) {
    if (e.statusCode === 503) throw e;
    console.error("Onboarding Razorpay order creation error:", e.message);
    throw apiError("Unable to reach the payment gateway. Please try again.", 502);
  }

  const payment = await prisma.subscriptionPayment.create({
    data: {
      restaurantId: restaurant.id,
      subscriptionId: subscription.id,
      planId: subscription.planId,
      planCode: subscription.plan,
      planName: subscription.plan,
      billingCycle: subscription.billingCycle || ONBOARDING_BILLING_CYCLE,
      action: "ACTIVATION",
      amount: subscription.amount,
      status: "CREATED",
      razorpayOrderId: order.id,
      createdBy: userId,
    },
  });

  const cfg = await require("./gateway-config.service").getGatewayConfig().catch(() => null);
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { onboardingStatus: "PAYMENT_PENDING" },
  });

  return {
    subscriptionPaymentId: payment.id,
    razorpayOrderId: order.id,
    amount: payment.amount,
    currency: "INR",
    keyId: cfg ? cfg.keyId : process.env.RAZORPAY_KEY_ID,
    plan: { id: subscription.planId, code: subscription.plan },
    billingCycle: payment.billingCycle,
    expectedExpiry: subscription.expiryDate,
  };
}

/**
 * Server-side payment verification (the ONLY place the application advances
 * past PAYMENT_PENDING — a frontend "payment success" callback is never the
 * source of truth). Returns { status: 'ACTIVE'|'UNDER_REVIEW', alreadyPaid, ... }.
 */
async function verifyPayment(userId, restaurant, body, meta) {
  const { subscriptionPaymentId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = body || {};
  const payment = await prisma.subscriptionPayment.findUnique({
    where: { id: Number(subscriptionPaymentId) },
  });
  if (!payment || payment.restaurantId !== restaurant.id) throw apiError("Payment not found", 404);
  if (payment.razorpayOrderId !== razorpayOrderId) throw apiError("Payment order mismatch", 400);

  // Idempotency: a duplicate/replayed callback returns the current state
  // without touching the database again.
  const paidState = async () => {
    const fresh = await prisma.restaurant.findUnique({ where: { id: restaurant.id } });
    const { mode } = await getReviewMode();
    return {
      status: fresh && fresh.status === "ACTIVE" ? "ACTIVE" : "UNDER_REVIEW",
      alreadyPaid: true,
      mode,
    };
  };

  if (payment.status === "PAID") return paidState();

  if (!(await verifyPaymentSignature({ orderId: razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature }))) {
    await prisma.subscriptionPayment.update({
      where: { id: payment.id },
      data: { status: "FAILED", errorMessage: "Signature verification failed" },
    });
    await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { onboardingStatus: "PAYMENT_FAILED" },
    });
    throw apiError("Payment verification failed. The plan was not activated.", 400);
  }

  const claimed = await prisma.subscriptionPayment.updateMany({
    where: { id: payment.id, status: { not: "PAID" } },
    data: {
      status: "PAID",
      razorpayPaymentId,
      razorpaySignature: razorpaySignature || null,
      paidAt: new Date(),
    },
  });
  if (claimed.count !== 1) return paidState();

  return finishVerifiedPayment(restaurant, payment, userId, meta);
}

/** Shared tail after a payment is marked PAID — routes by review mode. */
async function finishVerifiedPayment(restaurant, payment, userId, meta) {
  const { mode, manual } = await getReviewMode();

  if (manual) {
    await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { onboardingStatus: "UNDER_REVIEW", onboardingNote: null },
    });
    await createAuditLog({
      restaurantId: restaurant.id,
      userId,
      module: "PAYMENT",
      action: "PAYMENT",
      description: `Payment verified (₹${payment.amount}) — application queued for review`,
      referenceId: payment.id,
      ipAddress: meta && meta.ipAddress,
      userAgent: meta && meta.userAgent,
    });
    return { status: "UNDER_REVIEW", mode, alreadyPaid: false };
  }

  // Auto mode — provision + activate immediately (document review not required).
  return provisionAndActivate(restaurant.id, userId, meta);
}

// ─── Provisioning + activation ───────────────────────────────────────────────
/**
 * Create the tenant schema, seed tenant defaults, apply the paid plan snapshot
 * and flip the restaurant/subscription to ACTIVE. Idempotent — safe to retry
 * and safe to call from the SUPER_ADMIN approve flow and the Razorpay webhook.
 */
async function provisionAndActivate(restaurantId, actorId, meta) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: Number(restaurantId) },
    include: { subscription: true },
  });
  if (!restaurant) throw apiError("Restaurant not found", 404);
  if (restaurant.status === "ACTIVE" && restaurant.tenantSchema) {
    // Already provisioned — nothing to do (approve/duplicate webhook safety).
    return { status: "ACTIVE", alreadyActive: true, restaurantId: restaurant.id };
  }

  const subscription = restaurant.subscription;
  if (!subscription) throw apiError("No subscription selected for this application", 400);
  const paid = await prisma.subscriptionPayment.findFirst({
    where: { subscriptionId: subscription.id, status: "PAID" },
  });
  if (!paid) throw apiError("Payment has not been verified. The application cannot be activated.", 400);

  const plan = await prisma.plan.findUnique({ where: { id: subscription.planId } });
  if (!plan || !plan.isActive) throw apiError("Selected plan is no longer available", 400);

  // Final approval validation (spec §17): the application's stored businessType
  // must be compatible with the plan's businessMode before a tenant/subscription
  // is created. A mismatch is a configuration error, not a soft warning.
  assertPlanCompatibleWithBusinessType(restaurant.businessType, plan);

  // Phase 1: mark provisioning (DDL below cannot run inside the DB transaction)
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { onboardingStatus: "PROVISIONING", status: "INACTIVE" },
  });

  let tenantDb = null;
  let schemaName = restaurant.tenantSchema;
  try {
    if (!schemaName) {
      // Phase 2: create the tenant schema (CREATE SCHEMA + DDL auto-commits).
      const tenantResult = await initializeTenantSchema(restaurant.id, {});
      schemaName = tenantResult.schemaName;
    }
    tenantDb = getTenantClient(schemaName);

    // Phase 3: tenant defaults + platform activation inside transactions.
    const startDate = new Date();
    const expiryDate = computeExpiryDate(startDate, ONBOARDING_BILLING_CYCLE);
    const snapshot = planToSnapshot(plan, ONBOARDING_BILLING_CYCLE);

    const activation = await prisma.$transaction(async (tx) => {
      // Tenant-plane defaults (restaurant settings for the POS experience).
      const existingSetting = await tenantDb.restaurantSetting.findUnique({
        where: { restaurantId: restaurant.id },
      });
      if (!existingSetting) {
        await tenantDb.restaurantSetting.create({
          data: {
            restaurantId: restaurant.id,
            restaurantName: restaurant.name,
            currency: restaurant.currency || "INR",
            timezone: restaurant.timezone || "Asia/Kolkata",
            language: restaurant.language || "en",
            taxPercentage: 0,
            serviceCharge: 0,
            roundOffEnabled: true,
            billPrefix: "BILL",
            invoicePrefix: "INV",
            kotPrefix: "KOT",
            receiptFooter: "Thank You! Visit Again.",
          },
        });
      }
      // Apply plan module flags + business-mode presets to the TENANT settings
      // (same semantics as the SUPER_ADMIN assignment flow).
      await applyPlanFeaturesToTenantSetting(tenantDb, restaurant.id, snapshot.features, snapshot.businessMode);

      // Platform-plane activation.
      const now = new Date();
      await tx.subscription.update({
        where: { restaurantId: restaurant.id },
        data: {
          planId: plan.id,
          plan: plan.code,
          status: "ACTIVE",
          businessMode: snapshot.businessMode,
          startDate: now,
          expiryDate,
          nextRenewalDate: expiryDate,
          billingCycle: ONBOARDING_BILLING_CYCLE,
          autoRenew: snapshot.autoRenew,
          maxUsers: snapshot.maxUsers,
          maxTables: snapshot.maxTables,
          maxFloors: snapshot.maxFloors,
          maxMenuItems: snapshot.maxMenuItems,
          maxPrinters: snapshot.maxPrinters,
          maxBranches: snapshot.maxBranches,
          maxOrdersPerMonth: snapshot.maxOrdersPerMonth,
          storageLimitMB: snapshot.storageLimitMB,
          features: snapshot.features,
          amount: snapshot.amount,
          updatedBy: actorId,
        },
      });
      await tx.restaurant.update({
        where: { id: restaurant.id },
        data: {
          status: "ACTIVE",
          onboardingStatus: "ACTIVE",
          onboardingNote: null,
          subscriptionPlan: plan.code,
        },
      });
      // The owner ADMIN was created during registration — ensure active.
      await tx.user.updateMany({
        where: { restaurantId: restaurant.id, role: "ADMIN" },
        data: { isActive: true, deletedAt: null },
      });

      await tx.subscriptionHistory.create({
        data: {
          restaurantId: restaurant.id,
          changeType: "CREATION",
          previousPlanId: null,
          newPlanId: plan.id,
          previousPlan: null,
          newPlan: plan.code,
          previousStatus: subscription.status,
          newStatus: "ACTIVE",
          billingCycle: ONBOARDING_BILLING_CYCLE,
          amount: snapshot.amount,
          expiryDate,
          changedBy: actorId,
          notes: "Self-serve onboarding activated after verified payment",
          ipAddress: meta && meta.ipAddress,
        },
      });

      // Platform-plane audit + notification.
      await createAuditLog({
        restaurantId: restaurant.id,
        userId: actorId,
        module: "USER",
        action: "CREATE",
        description: `Self-serve application activated: ${restaurant.name} on ${plan.code}`,
        referenceId: restaurant.id,
        referenceNo: restaurant.name,
        ipAddress: meta && meta.ipAddress,
        userAgent: meta && meta.userAgent,
      });
      return { expiryDate, planCode: plan.code };
    });

    // Tenant-plane audit (best-effort — the tenant is brand new).
    try {
      const { createNotification } = require("./notification.service");
      await createNotification(tenantDb, {
        restaurantId: restaurant.id,
        title: "Welcome to Nirka POS",
        message: `Your ${plan.name} plan is active until ${expiryDate.toDateString()}.`,
        type: "SYSTEM",
      });
      await createAuditLog({
        restaurantId: restaurant.id,
        userId: actorId,
        module: "USER",
        action: "CREATE",
        description: `Tenant provisioned for ${restaurant.name}`,
        referenceId: restaurant.id,
        ipAddress: meta && meta.ipAddress,
        userAgent: meta && meta.userAgent,
      }, tenantDb);
    } catch (tenantErr) {
      console.warn("[Onboarding] Tenant notification/audit failed (non-critical):", tenantErr.message);
    }

    // Auto-approve all submitted (non-rejected) documents for the record.
    await prisma.restaurantDocument.updateMany({
      where: { restaurantId: restaurant.id, status: { in: ["PENDING", "UNDER_REVIEW"] } },
      data: { status: "VERIFIED", verifiedAt: new Date() },
    });

    return {
      status: "ACTIVE",
      alreadyActive: false,
      restaurantId: restaurant.id,
      planCode: activation.planCode,
      expiryDate: activation.expiryDate,
    };
  } catch (error) {
    console.error("[Onboarding] Provisioning failed for restaurant", restaurant.id, ":", error.message);
    // Leave a retryable state: payment stays PAID, stage back to UNDER_REVIEW.
    await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { onboardingStatus: "UNDER_REVIEW", onboardingNote: "Activation failed: " + String(error.message).slice(0, 200) },
    }).catch(() => {});
    throw apiError("Account activation failed: " + error.message, 500);
  }
}

/** Plan module flags + business-mode presets on the TENANT RestaurantSetting. */
async function applyPlanFeaturesToTenantSetting(tenantDb, restaurantId, features, businessMode) {
  const set = new Set(features || []);
  const updateData = {};
  Object.keys(FEATURE_SETTINGS_MAP).forEach((feature) => {
    FEATURE_SETTINGS_MAP[feature].forEach((key) => {
      updateData[key] = set.has(feature);
    });
  });
  const mode = businessMode || "RESTAURANT";
  const PRESETS = {
    RESTAURANT: {
      enableCounterSale: false,
      enableKitchen: true,
      enableFloorManagement: true,
      enableActiveOrders: true,
      enableMenu: true,
      enableReports: true,
      enableBilling: true,
    },
    BASIC_POS: {
      enableCounterSale: true,
      enableKitchen: false,
      enableFloorManagement: false,
      enableActiveOrders: false,
      enableMenu: true,
      enableReports: true,
      enableBilling: true,
      enablePosOrdering: true,
    },
  };
  if (PRESETS[mode]) {
    Object.keys(PRESETS[mode]).forEach((key) => {
      updateData[key] = PRESETS[mode][key];
    });
  }
  updateData.businessMode = mode === "BASIC_POS" ? "counter" : "restaurant";
  if (Object.keys(updateData).length > 0) {
    await tenantDb.restaurantSetting.updateMany({ where: { restaurantId: Number(restaurantId) }, data: updateData });
  }
}

// ─── Manual payment onboarding flow ──────────────────────────────────────────

/** Create a platform (SUPER_ADMIN-facing) notification. */
async function notifySuperAdmins(title, message, restaurantId) {
  try {
    await prisma.notification.create({
      data: {
        restaurantId,
        userId: null, // platform-wide — visible on the Super Admin notifications page
        title,
        message,
        type: "SYSTEM", // SYSTEM is in the SA platform notification filter
      },
    });
  } catch (err) {
    console.warn("[Onboarding] SA notification failed (non-critical):", err.message);
  }
}

/**
 * Submit the completed wizard application for SUPER_ADMIN review.
 *
 * The final wizard action: BUSINESS → DOCUMENTS → LEGAL → PLAN → REVIEW →
 * SUBMIT APPLICATION. Validates every prerequisite server-side (business
 * details, ≥1 valid document, all legal acceptances, selected plan), then
 * freezes the application at MANUAL_PENDING:
 *   - restaurant stays INACTIVE, subscription stays PENDING_PAYMENT
 *   - no tenant schema, no POS access, no payment collected
 *   - SUPER_ADMIN is notified and reviews → shares payment QR → verifies
 *     payment → approves (the only activation path)
 */
async function submitApplication(userId, meta) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, restaurantId: true, name: true },
  });
  if (!user || !user.restaurantId) throw apiError("No application found for this account", 404);

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: user.restaurantId },
    include: { subscription: true },
  });
  if (!restaurant || restaurant.deletedAt) throw apiError("Application not found", 404);
  if (!restaurant.selfServe) throw apiError("This account is not a self-serve onboarding application", 403);

  // Idempotent — already submitted / decided applications just return state.
  if (MANUAL_ONBOARDING_STAGES.includes(restaurant.onboardingStatus) || TERMINAL_STAGES.includes(restaurant.onboardingStatus)) {
    return buildOnboardingPayload(userId);
  }
  if (restaurant.status === "ACTIVE") {
    return buildOnboardingPayload(userId);
  }

  // ── Prerequisite gates (data-driven, mirror the wizard order) ──
  if (!restaurant.name) {
    throw apiError("Complete your business details before submitting your application", 400);
  }
  const docs = await prisma.restaurantDocument.count({
    where: { restaurantId: restaurant.id, status: { in: VALID_DOCUMENT_STATUSES } },
  });
  if (docs < 1) {
    throw apiError("Please upload at least one valid business document before submitting your application", 400);
  }
  const distinct = await prisma.policyAgreement.groupBy({
    by: ["policyType"],
    where: {
      restaurantId: restaurant.id,
      OR: REQUIRED_POLICY_TYPES.map((p) => ({
        policyType: p.type,
        policyVersion: String(POLICY_VERSIONS[p.type]),
      })),
    },
  });
  if (distinct.length < REQUIRED_POLICY_TYPES.length) {
    throw apiError("Accept the Terms & Conditions, Privacy Policy and accuracy confirmation before submitting your application", 400);
  }
  if (!restaurant.subscription) {
    throw apiError("Select a plan before submitting your application", 400);
  }

  // ── SERVER-SIDE email verification gate ──
  // The application email must have been verified with an OTP. The flag is
  // NEVER read from the request — the EmailVerification table is the only
  // source. Without a verified address the application is rejected here.
  const applicationEmail = restaurant.email || (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email;
  if (!applicationEmail) {
    throw apiError("A business email is required before submitting the application", 400);
  }
  const emailVerified = await isEmailVerified(applicationEmail);
  if (!emailVerified) {
    throw apiError("Please verify your email before submitting the application.", 400);
  }

  const plan = await prisma.plan.findUnique({ where: { id: restaurant.subscription.planId } }).catch(() => null);
  const planLabel = plan ? plan.name : restaurant.subscription.plan || "Selected plan";

  // ── Freeze the application for manual review (idempotent freeze) ──
  // Conditional update: only a row still sitting at a pre-submit stage can be
  // flipped to MANUAL_PENDING — a double-click/race can never run the
  // notification + email block twice.
  const freezeClaim = await prisma.restaurant.updateMany({
    where: { id: restaurant.id, onboardingStatus: { not: "MANUAL_PENDING" } },
    data: {
      onboardingStatus: "MANUAL_PENDING",
      onboardingNote: null,
      status: "INACTIVE",
      // Review window: the expiry cron flips stale applications to EXPIRED.
      applicationExpiresAt: new Date(Date.now() + APPLICATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      expiredNotificationSentAt: null,
    },
  });
  if (freezeClaim.count !== 1) {
    // Already submitted (double-click / concurrent call) — return current state.
    return buildOnboardingPayload(userId);
  }

  await createAuditLog({
    restaurantId: restaurant.id,
    userId,
    module: "USER",
    action: "CREATE",
    description: `Application submitted for review: ${restaurant.name} — Plan: ${planLabel}`,
    referenceId: restaurant.id,
    referenceNo: restaurant.name,
    ipAddress: meta && meta.ipAddress,
    userAgent: meta && meta.userAgent,
  });

  await notifySuperAdmins(
    "New Restaurant Application",
    `New application submitted: ${restaurant.name} (${restaurant.businessType || "Restaurant"}) — Plan: ${planLabel}. Review it to generate payment instructions.`,
    restaurant.id
  );

  // ── Post-submission emails (queued + retryable, NEVER fatal) ──
  // Delivery problems are recorded in the EmailLog and retried by the email
  // cron — a failed email can never fail the submission itself.
  try {
    const frontendUrl = process.env.APP_FRONTEND_URL || "http://localhost:3000";
    const submittedAt = new Date().toUTCString();
    const applicationRef = `APP-${String(restaurant.id).padStart(4, "0")}`;

    // 1. Applicant confirmation.
    sendApplicationReceivedEmail({
      to: applicationEmail,
      applicantName: restaurant.ownerName || user.name,
      restaurantName: restaurant.name,
      applicationRef,
      submittedAt,
    });

    // 2. Super Admin alert — configured recipients, else active SUPER_ADMINs.
    const emailCfg = await getEmailConfig().catch(() => null);
    let saRecipients = (emailCfg && emailCfg.superAdminNotificationEmails) || [];
    if (saRecipients.length === 0) {
      const saUsers = await prisma.user.findMany({
        where: { role: "SUPER_ADMIN", isActive: true, deletedAt: null },
        select: { email: true },
      });
      saRecipients = saUsers.map((u) => u.email);
    }
    saRecipients.forEach((to) => {
      sendNewApplicationEmail({
        to,
        applicantName: restaurant.ownerName || user.name,
        applicantEmail: applicationEmail,
        applicantPhone: restaurant.phone,
        restaurantName: restaurant.name,
        businessType: restaurant.businessType,
        city: restaurant.city,
        state: restaurant.state,
        applicationRef,
        submittedAt,
        frontendUrl,
      });
    });
  } catch (emailErr) {
    console.warn("[Onboarding] Submission email enqueue failed (non-critical):", emailErr.message);
  }

  return buildOnboardingPayload(userId);
}

/**
 * Start a new manual payment application.
 * Creates restaurant + subscription in PENDING state, no payment gateway interaction.
 */
async function startManualApplication(userId, data) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== "ADMIN") throw apiError("Invalid onboarding account", 403);
  if (user.restaurantId) throw apiError("Account already has a restaurant", 400);

  // Check for duplicate email/phone
  if (data.email) {
    data.email = normalizeEmail(data.email);
    const dupEmail = await prisma.restaurant.findFirst({
      where: { email: data.email, deletedAt: null },
    });
    if (dupEmail) throw apiError("A business with this email already exists", 400);
  }
  const dupPhone = await prisma.restaurant.findFirst({
    where: { phone: data.phone, deletedAt: null },
  });
  if (dupPhone) throw apiError("A business with this phone number already exists", 400);

  // Resolve selected plan
  const plan = await prisma.plan.findUnique({ where: { id: Number(data.planId) } });
  if (!plan || !plan.isActive) throw apiError("Selected plan is not available", 400);
  if (plan.code === "TRIAL") throw apiError("The Trial plan cannot be purchased", 400);
  const amount = Number(plan.yearlyPrice || 0);
  if (amount <= 0) throw apiError("This plan has no yearly price configured", 400);

  // Derive mode from the normalized business type and enforce compatibility
  // BEFORE creating anything (spec §8 — never trust a client businessMode).
  const businessType = BUSINESS_TYPES.some((b) => b.value === data.businessType)
    ? data.businessType
    : "OTHER";
  assertPlanCompatibleWithBusinessType(businessType, plan);

  // Create restaurant in PENDING state
  const restaurant = await prisma.restaurant.create({
    data: {
      name: data.name,
      legalName: data.legalName || null,
      registrationNumber: data.registrationNumber || null,
      ownerName: data.ownerName || user.name,
      email: data.email ? normalizeEmail(data.email) : null,
      phone: data.phone,
      businessType,
      gstNumber: data.gstNumber || null,
      fssaiNumber: data.fssaiNumber || null,
      address: data.address || null,
      city: data.city || null,
      state: data.state || null,
      country: data.country || "India",
      pincode: data.pincode || null,
      website: data.website || null,
      currency: data.currency || "INR",
      timezone: data.timezone || "Asia/Kolkata",
      status: "INACTIVE",
      selfServe: true,
      onboardingStatus: "MANUAL_PENDING",
      subscriptionPlan: plan.code,
      // Review window for the expiry cron (same policy as the wizard path).
      applicationExpiresAt: new Date(Date.now() + APPLICATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      expiredNotificationSentAt: null,
    },
  });

  // Link the owner (ADMIN) to the restaurant
  await prisma.user.update({ where: { id: userId }, data: { restaurantId: restaurant.id } });

  // Create subscription in PENDING state
  const startDate = new Date();
  const expiryDate = computeExpiryDate(startDate, ONBOARDING_BILLING_CYCLE);
  const snapshot = planToSnapshot(plan, ONBOARDING_BILLING_CYCLE);

  await prisma.subscription.create({
    data: {
      restaurantId: restaurant.id,
      planId: plan.id,
      plan: plan.code,
      status: "PENDING_PAYMENT",
      businessMode: snapshot.businessMode,
      startDate,
      expiryDate,
      nextRenewalDate: expiryDate,
      billingCycle: ONBOARDING_BILLING_CYCLE,
      autoRenew: snapshot.autoRenew,
      maxUsers: snapshot.maxUsers,
      maxTables: snapshot.maxTables,
      maxFloors: snapshot.maxFloors,
      maxMenuItems: snapshot.maxMenuItems,
      maxPrinters: snapshot.maxPrinters,
      maxBranches: snapshot.maxBranches,
      maxOrdersPerMonth: snapshot.maxOrdersPerMonth,
      storageLimitMB: snapshot.storageLimitMB,
      features: snapshot.features,
      amount,
    },
  });

  await createAuditLog({
    restaurantId: restaurant.id,
    userId,
    module: "USER",
    action: "CREATE",
    description: `Manual payment application submitted: ${restaurant.name} (${businessType}) - Plan: ${plan.code}`,
    referenceId: restaurant.id,
    referenceNo: restaurant.name,
    ipAddress: data._ip,
    userAgent: data._ua,
  });

  // ── Post-submission emails (queued, non-fatal) — same matrix as the wizard
  // submission path: applicant confirmation + Super Admin alert. ──
  try {
    const frontendUrl = process.env.APP_FRONTEND_URL || "http://localhost:3000";
    const submittedAt = new Date().toUTCString();
    const applicationRef = `APP-${String(restaurant.id).padStart(4, "0")}`;
    const recipientEmail = restaurant.email || user.email;

    if (recipientEmail) {
      // The submission email gate requires a verified address; verification is
      // enforced in submitApplication. The manual quick-start form verifies
      // best-effort: if the address was OTP-verified the emails go out, and
      // the Super Admin alert is sent regardless (platform operation).
      const verified = await isEmailVerified(recipientEmail);
      if (verified) {
        sendApplicationReceivedEmail({
          to: recipientEmail,
          applicantName: restaurant.ownerName || user.name,
          restaurantName: restaurant.name,
          applicationRef,
          submittedAt,
        });
      }

      const emailCfg = await getEmailConfig().catch(() => null);
      let saRecipients = (emailCfg && emailCfg.superAdminNotificationEmails) || [];
      if (saRecipients.length === 0) {
        const saUsers = await prisma.user.findMany({
          where: { role: "SUPER_ADMIN", isActive: true, deletedAt: null },
          select: { email: true },
        });
        saRecipients = saUsers.map((u) => u.email);
      }
      saRecipients.forEach((to) => {
        sendNewApplicationEmail({
          to,
          applicantName: restaurant.ownerName || user.name,
          applicantEmail: recipientEmail,
          applicantPhone: restaurant.phone,
          restaurantName: restaurant.name,
          businessType: restaurant.businessType,
          city: restaurant.city,
          state: restaurant.state,
          applicationRef,
          submittedAt,
          frontendUrl,
        });
      });
    }
  } catch (emailErr) {
    console.warn("[Onboarding] Manual submission email enqueue failed (non-critical):", emailErr.message);
  }

  return {
    id: restaurant.id,
    name: restaurant.name,
    status: "MANUAL_PENDING",
    plan: { id: plan.id, code: plan.code, name: plan.name, yearlyPrice: amount },
    amount,
    message: "Application submitted successfully. Please wait for payment instructions from the administrator.",
  };
}

/**
 * Mark payment as received for a manual application.
 * Validates amount matches the selected plan price.
 */
async function markPaymentReceived(restaurantId, saUserId, data) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: Number(restaurantId) },
    include: { subscription: true },
  });
  if (!restaurant || restaurant.deletedAt) throw apiError("Application not found", 404);
  if (!restaurant.selfServe) throw apiError("This restaurant was not created through self-serve onboarding", 404);
  if (restaurant.onboardingStatus !== "MANUAL_PENDING" && restaurant.onboardingStatus !== "MANUAL_PAYMENT_PENDING") {
    throw apiError("Application is not in a state to receive payment", 400);
  }
  if (restaurant.status === "ACTIVE") throw apiError("Application is already active", 400);

  const subscription = restaurant.subscription;
  if (!subscription) throw apiError("No subscription found for this application", 400);

  // Validate amount matches plan price
  const expectedAmount = subscription.amount;
  const receivedAmount = Number(data.amount || 0);
  if (receivedAmount <= 0) throw apiError("Payment amount is required", 400);
  if (Math.abs(receivedAmount - expectedAmount) > 0.01) {
    throw apiError(`Payment amount (₹${receivedAmount.toFixed(2)}) does not match plan price (₹${expectedAmount.toFixed(2)})`, 400);
  }

  const paymentRef = data.transactionRef || data.reference || data.transactionId || null;
  const paymentDate = data.paymentDate ? new Date(data.paymentDate) : new Date();
  const proofReference = data.paymentProof || null;

  // Update restaurant status
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: {
      onboardingStatus: "MANUAL_PAYMENT_RECEIVED",
      onboardingNote: null,
    },
  });

  // Record the verified manual payment as a PAID subscription-payment row.
  // Approval / provisioning gate on a PAID row, so this is what lets the
  // application be activated later — WITHOUT activating anything now
  // (restaurant stays INACTIVE until SUPER_ADMIN approval).
  const existingPaid = await prisma.subscriptionPayment.findFirst({
    where: { subscriptionId: subscription.id, status: "PAID" },
  });
  if (!existingPaid) {
    await prisma.subscriptionPayment.create({
      data: {
        restaurantId: restaurant.id,
        subscriptionId: subscription.id,
        planId: subscription.planId,
        planCode: subscription.plan || "MANUAL",
        planName: subscription.plan,
        billingCycle: subscription.billingCycle || ONBOARDING_BILLING_CYCLE,
        action: "ACTIVATION",
        amount: receivedAmount,
        status: "PAID",
        reference: paymentRef || `MANUAL-${restaurant.id}-${Date.now()}`,
        paymentMethod: "UPI", // manual QR payment verified by SUPER_ADMIN
        createdBy: saUserId,
        paidAt: paymentDate,
      },
    });
  }

  // Record payment verification
  await createAuditLog({
    restaurantId: restaurant.id,
    userId: saUserId,
    module: "PAYMENT",
    action: "PAYMENT",
    description: `Payment manually verified (₹${receivedAmount.toFixed(2)}) — application awaiting approval`,
    referenceId: subscription.id,
    referenceNo: paymentRef || "Manual Payment",
    ipAddress: data._ip,
    userAgent: data._ua,
  });

  await notifySuperAdmins(
    "Manual Payment Received",
    `Payment verified (₹${receivedAmount.toFixed(2)}) for ${restaurant.name}. The application is now awaiting approval.`,
    restaurant.id
  );

  return {
    id: restaurant.id,
    name: restaurant.name,
    status: "MANUAL_PAYMENT_RECEIVED",
    paymentStatus: "RECEIVED",
    amount: receivedAmount,
    transactionRef: paymentRef,
    paymentDate: paymentDate.toISOString(),
    message: "Payment verified. Application is now awaiting Super Admin approval.",
  };
}

/**
 * SUPER_ADMIN approval for manual payment application.
 * Validates all prerequisites before activating.
 */
async function approveManualApplication(restaurantId, saUserId, meta) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: Number(restaurantId) },
    include: { subscription: true },
  });
  if (!restaurant || restaurant.deletedAt) throw apiError("Application not found", 404);
  if (!restaurant.selfServe) throw apiError("This restaurant was not created through self-serve onboarding", 404);

  // Must be in payment received state
  if (restaurant.onboardingStatus !== "MANUAL_PAYMENT_RECEIVED") {
    throw apiError("Application must have payment verified before approval", 400);
  }

  // Guard: restaurant not already active
  if (restaurant.status === "ACTIVE" && restaurant.tenantSchema) {
    return { status: "ACTIVE", alreadyActive: true, restaurantId: restaurant.id, message: "Application is already active" };
  }

  // Guard: subscription exists and payment verified
  if (!restaurant.subscription) throw apiError("Cannot approve: no subscription found", 400);

  // Verify payment was marked received
  const paymentReceived = restaurant.onboardingStatus === "MANUAL_PAYMENT_RECEIVED";
  if (!paymentReceived) throw apiError("Cannot approve: payment has not been verified yet", 400);

  // Verify amount matches
  const subscription = restaurant.subscription;
  if (!subscription) throw apiError("Cannot approve: no subscription found", 400);

  // Proceed with activation using existing provisionAndActivate
  const result = await provisionAndActivate(restaurant.id, saUserId, meta || {});

  // Update to MANUAL_APPROVED status
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: {
      onboardingStatus: "MANUAL_APPROVED",
      onboardingNote: null,
      applicationExpiresAt: null, // approved — expiry no longer applies
      expiredNotificationSentAt: null,
    },
  });

  // ── Approval email to the applicant (queued, non-fatal, idempotent) ──
  try {
    const owner = await prisma.user.findFirst({
      where: { restaurantId: restaurant.id, role: "ADMIN", deletedAt: null },
      select: { email: true, name: true },
    });
    if (owner && owner.email) {
      sendApplicationApprovedEmail({
        to: owner.email,
        applicantName: restaurant.ownerName || owner.name,
        restaurantName: restaurant.name,
        applicationRef: `APP-${String(restaurant.id).padStart(4, "0")}`,
        approvedAt: new Date().toUTCString(),
        planName: (restaurant.subscription && restaurant.subscription.plan) || "Selected plan",
        loginUrl: `${String(process.env.APP_FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "")}/login`,
      });
    }
  } catch (emailErr) {
    console.warn("[Onboarding] Approval email enqueue failed (non-critical):", emailErr.message);
  }

  await createAuditLog({
    restaurantId: restaurant.id,
    userId: saUserId,
    module: "USER",
    action: "UPDATE",
    description: "Manual payment application approved by Super Admin",
    referenceId: restaurant.id,
    referenceNo: restaurant.name,
    ipAddress: meta && meta.ipAddress,
    userAgent: meta && meta.userAgent,
  });

  await notifySuperAdmins(
    "Restaurant Application Approved",
    `${restaurant.name} has been approved and activated. The owner can now log in to the POS.`,
    restaurant.id
  );

  return {
    ...result,
    status: "MANUAL_APPROVED",
    message: "Application approved and activated",
  };
}

/**
 * SUPER_ADMIN rejection for manual payment application.
 */
async function rejectManualApplication(restaurantId, reason, saUserId, meta) {
  const restaurant = await prisma.restaurant.findUnique({ where: { id: Number(restaurantId) } });
  if (!restaurant || restaurant.deletedAt) throw apiError("Application not found", 404);
  if (!restaurant.selfServe) throw apiError("This restaurant was not created through self-serve onboarding", 404);
  if (!reason || !String(reason).trim()) throw apiError("A rejection reason is required", 400);

  if (restaurant.status === "ACTIVE") {
    throw apiError("Cannot reject an already active restaurant", 400);
  }

  const cleanReason = String(reason).trim().slice(0, 1000);
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: {
      onboardingStatus: "MANUAL_REJECTED",
      onboardingNote: cleanReason,
      status: "INACTIVE",
    },
  });

  await createAuditLog({
    restaurantId: restaurant.id,
    userId: saUserId,
    module: "USER",
    action: "UPDATE",
    description: `Manual payment application rejected: ${cleanReason}`,
    referenceId: restaurant.id,
    referenceNo: restaurant.name,
    ipAddress: meta && meta.ipAddress,
    userAgent: meta && meta.userAgent,
  });

  await notifySuperAdmins(
    "Restaurant Application Rejected",
    `${restaurant.name} was rejected. Reason: ${cleanReason}`,
    restaurant.id
  );

  // Notify owner
  const owner = await prisma.user.findFirst({ where: { restaurantId: restaurant.id, role: "ADMIN", deletedAt: null } });
  if (owner) {
    await prisma.notification.create({
      data: {
        restaurantId: restaurant.id,
        userId: owner.id,
        title: "Application Rejected",
        message: `Your business application was not approved. Reason: ${cleanReason}`,
        type: "SYSTEM",
      },
    }).catch(() => {});

    // Rejection email (queued, non-fatal) — same template as the classic flow.
    if (owner.email) {
      sendApplicationRejectedEmail({
        to: owner.email,
        applicantName: restaurant.ownerName || owner.name,
        restaurantName: restaurant.name,
        applicationRef: `APP-${String(restaurant.id).padStart(4, "0")}`,
        decidedAt: new Date().toUTCString(),
        reason: cleanReason,
      }).catch(() => {});
    }
  }

  return { id: restaurant.id, status: "MANUAL_REJECTED", message: "Application rejected" };
}

/**
 * Get manual application detail for Super Admin.
 * Shows only onboarding/payment information, NOT operational data.
 */
async function getManualApplicationDetail(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: Number(restaurantId) },
    include: {
      subscription: { include: { planDef: { select: { id: true, code: true, name: true, yearlyPrice: true } } } },
      users: { where: { role: "ADMIN", deletedAt: null }, select: { id: true, name: true, email: true, phone: true, isActive: true } },
    },
  });
  if (!restaurant || restaurant.deletedAt) throw apiError("Application not found", 404);
  if (!restaurant.selfServe) throw apiError("This restaurant was not created through self-serve onboarding", 404);

  // Only include manual flow applications
  if (!["MANUAL_PENDING", "MANUAL_PAYMENT_PENDING", "MANUAL_PAYMENT_RECEIVED", "MANUAL_APPROVED", "MANUAL_REJECTED"].includes(restaurant.onboardingStatus)) {
    throw apiError("This application is not a manual payment application", 404);
  }

  const owner = restaurant.users[0] || null;
  const subscription = restaurant.subscription;

  return {
    id: restaurant.id,
    name: restaurant.name,
    legalName: restaurant.legalName,
    registrationNumber: restaurant.registrationNumber,
    businessType: restaurant.businessType,
    ownerName: restaurant.ownerName,
    email: restaurant.email,
    phone: restaurant.phone,
    gstNumber: restaurant.gstNumber,
    fssaiNumber: restaurant.fssaiNumber,
    address: restaurant.address,
    city: restaurant.city,
    state: restaurant.state,
    country: restaurant.country,
    pincode: restaurant.pincode,
    website: restaurant.website,
    status: restaurant.status,
    onboardingStatus: restaurant.onboardingStatus,
    onboardingNote: restaurant.onboardingNote,
    createdAt: restaurant.createdAt,
    owner,
    subscription: subscription ? {
      plan: subscription.plan,
      planName: subscription.planDef?.name || subscription.plan,
      yearlyPrice: subscription.planDef?.yearlyPrice || subscription.amount,
      amount: subscription.amount,
      billingCycle: subscription.billingCycle,
      status: subscription.status,
      startDate: subscription.startDate,
      expiryDate: subscription.expiryDate,
    } : null,
    // Payment info (not transaction history - that's operational)
    payment: {
      amount: subscription?.amount || 0,
      status: restaurant.onboardingStatus.includes("PAYMENT") ? "RECEIVED" : "PENDING",
      receivedAt: restaurant.onboardingStatus === "MANUAL_PAYMENT_RECEIVED" ? restaurant.updatedAt : null,
    },
  };
}

// ─── Manual payment applications listing ─────────────────────────────────────
async function listManualApplications(opts = {}) {
  const where = { deletedAt: null, selfServe: true };
  // Only include manual payment flow applications
  where.onboardingStatus = { in: ["MANUAL_PENDING", "MANUAL_PAYMENT_PENDING", "MANUAL_PAYMENT_RECEIVED", "MANUAL_APPROVED", "MANUAL_REJECTED"] };
  
  if (opts.status) {
    const statusFilter = String(opts.status).toUpperCase();
    if (statusFilter === "PENDING") {
      where.onboardingStatus = "MANUAL_PENDING";
    } else if (statusFilter === "PAYMENT_PENDING") {
      where.onboardingStatus = "MANUAL_PAYMENT_PENDING";
    } else if (statusFilter === "PAYMENT_RECEIVED") {
      where.onboardingStatus = "MANUAL_PAYMENT_RECEIVED";
    } else if (statusFilter === "APPROVED") {
      where.onboardingStatus = "MANUAL_APPROVED";
    } else if (statusFilter === "REJECTED") {
      where.onboardingStatus = "MANUAL_REJECTED";
    } else {
      where.onboardingStatus = statusFilter;
    }
  }
  
  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: "insensitive" } },
      { ownerName: { contains: opts.search, mode: "insensitive" } },
      { email: { contains: opts.search, mode: "insensitive" } },
      { phone: { contains: opts.search, mode: "insensitive" } },
    ];
  }
  
  const page = Math.max(1, Number(opts.page || 1));
  const limit = Math.min(100, Math.max(1, Number(opts.limit || 15)));
  const [rows, total] = await Promise.all([
    prisma.restaurant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        businessType: true,
        ownerName: true,
        email: true,
        phone: true,
        city: true,
        country: true,
        status: true,
        onboardingStatus: true,
        onboardingNote: true,
        createdAt: true,
        updatedAt: true,
        subscription: { include: { planDef: { select: { id: true, code: true, name: true, yearlyPrice: true } } } },
      },
    }),
    prisma.restaurant.count({ where }),
  ]);
  
  return {
    applications: rows.map((r) => {
      const sub = r.subscription;
      return {
        id: r.id,
        name: r.name,
        businessType: r.businessType,
        ownerName: r.ownerName,
        email: r.email,
        phone: r.phone,
        city: r.city,
        country: r.country,
        status: r.status,
        onboardingStatus: r.onboardingStatus,
        displayStatus: MANUAL_STATUS_LABELS[r.onboardingStatus] || r.onboardingStatus,
        note: r.onboardingNote,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        subscription: sub ? {
          plan: sub.plan,
          planName: sub.planDef?.name || sub.plan,
          yearlyPrice: sub.planDef?.yearlyPrice || sub.amount,
          amount: sub.amount,
          billingCycle: sub.billingCycle,
          status: sub.status,
        } : null,
      };
    }),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ─── SUPER_ADMIN business applications ───────────────────────────────────────
async function listApplications(opts = {}) {
  const where = { deletedAt: null, selfServe: true };
  if (opts.status) {
    if (opts.status === "in_progress") {
      where.onboardingStatus = { in: SELF_SERVE_IN_PROGRESS.filter((s) => !["REJECTED", "SUSPENDED", "EXPIRED", "ACTIVE"].includes(s)) };
    } else {
      where.onboardingStatus = String(opts.status).toUpperCase();
    }
  }
  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: "insensitive" } },
      { ownerName: { contains: opts.search, mode: "insensitive" } },
      { email: { contains: opts.search, mode: "insensitive" } },
      { phone: { contains: opts.search, mode: "insensitive" } },
    ];
  }
  const page = Math.max(1, Number(opts.page || 1));
  const limit = Math.min(100, Math.max(1, Number(opts.limit || 15)));
  const [rows, total] = await Promise.all([
    prisma.restaurant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        businessType: true,
        ownerName: true,
        email: true,
        phone: true,
        city: true,
        state: true,
        country: true,
        status: true,
        onboardingStatus: true,
        onboardingNote: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { documents: true } },
      },
    }),
    prisma.restaurant.count({ where }),
  ]);
  return {
    applications: rows.map((r) => {
      return {
        id: r.id,
        name: r.name,
        businessType: r.businessType,
        ownerName: r.ownerName,
        email: r.email,
        phone: r.phone,
        city: r.city,
        country: r.country,
        status: r.onboardingStatus, // raw stored stage (also the SA filter value)
        displayStatus: stageLabel(r.onboardingStatus),
        step: STEP_BY_STAGE[r.onboardingStatus] || "blocked",
        restaurantStatus: r.status,
        note: r.onboardingNote,
        documentCount: r._count.documents,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function applicationDetail(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: Number(restaurantId) },
    include: {
      documents: {
        include: {
          uploader: { select: { id: true, name: true, email: true } },
          verifier: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      policyAgreements: {
        include: { accepter: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
      },
      subscription: { include: { planDef: { select: { id: true, code: true, name: true } } } },
      users: { where: { role: "ADMIN", deletedAt: null }, select: { id: true, name: true, email: true, phone: true, isActive: true } },
    },
  });
  if (!restaurant || restaurant.deletedAt) throw apiError("Application not found", 404);
  if (!restaurant.selfServe) throw apiError("This restaurant was not created through self-serve onboarding", 404);

  const payments = await prisma.subscriptionPayment.findMany({
    where: { restaurantId: restaurant.id },
    orderBy: { createdAt: "desc" },
  });

  return {
    id: restaurant.id,
    name: restaurant.name,
    legalName: restaurant.legalName,
    registrationNumber: restaurant.registrationNumber,
    businessType: restaurant.businessType,
    ownerName: restaurant.ownerName,
    email: restaurant.email,
    phone: restaurant.phone,
    gstNumber: restaurant.gstNumber,
    fssaiNumber: restaurant.fssaiNumber,
    address: restaurant.address,
    city: restaurant.city,
    state: restaurant.state,
    country: restaurant.country,
    pincode: restaurant.pincode,
    website: restaurant.website,
    status: restaurant.status,
    onboardingStatus: restaurant.onboardingStatus,
    onboardingNote: restaurant.onboardingNote,
    createdAt: restaurant.createdAt,
    owner: restaurant.users[0] || null,
    documents: restaurant.documents,
    policyAgreements: restaurant.policyAgreements,
    subscription: restaurant.subscription,
    payments: payments.map((p) => ({
      id: p.id,
      planCode: p.planCode,
      amount: p.amount,
      status: p.status,
      billingCycle: p.billingCycle,
      action: p.action,
      razorpayOrderId: p.razorpayOrderId,
      razorpayPaymentId: p.razorpayPaymentId,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      errorMessage: p.errorMessage,
    })),
  };
}

/** SUPER_ADMIN approval → provisioning + activation (idempotent). */
async function approveApplication(restaurantId, saUserId, meta) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: Number(restaurantId) },
    include: { subscription: true },
  });
  if (!restaurant || restaurant.deletedAt) throw apiError("Application not found", 404);
  if (!restaurant.selfServe) throw apiError("This restaurant was not created through self-serve onboarding", 404);

  if (restaurant.status === "ACTIVE" && restaurant.tenantSchema) {
    return { status: "ACTIVE", alreadyActive: true, restaurantId: restaurant.id, message: "Application is already active" };
  }

  // Approval guards: ≥1 valid document + verified payment.
  const validDocs = await prisma.restaurantDocument.count({
    where: { restaurantId: restaurant.id, status: { in: VALID_DOCUMENT_STATUSES } },
  });
  if (validDocs < 1) {
    throw apiError("Cannot approve: no valid business document on file. Missing optional documents are fine, but at least one valid document is required.", 400);
  }
  if (!restaurant.subscription) throw apiError("Cannot approve: the applicant has not selected a plan", 400);

  // Manual-review applications: payment must have been marked received BEFORE
  // approval. Payment received ≠ approved — this is the authoritative gate.
  if (MANUAL_ONBOARDING_STAGES.includes(restaurant.onboardingStatus) && restaurant.onboardingStatus !== "MANUAL_PAYMENT_RECEIVED") {
    throw apiError("Cannot approve: payment has not been verified yet. Mark the payment as received before approving.", 400);
  }

  const paid = await prisma.subscriptionPayment.findFirst({
    where: { subscriptionId: restaurant.subscription.id, status: "PAID" },
  });
  if (!paid) throw apiError("Cannot approve: payment has not been verified yet", 400);

  const result = await provisionAndActivate(restaurant.id, saUserId, meta || {});
  await createAuditLog({
    restaurantId: restaurant.id,
    userId: saUserId,
    module: "USER",
    action: "UPDATE",
    description: "Business application approved by Super Admin",
    referenceId: restaurant.id,
    referenceNo: restaurant.name,
    ipAddress: meta && meta.ipAddress,
    userAgent: meta && meta.userAgent,
  });

  // ── Approval email to the applicant (queued, non-fatal, idempotent) ──
  try {
    const owner = await prisma.user.findFirst({
      where: { restaurantId: restaurant.id, role: "ADMIN", deletedAt: null },
      select: { email: true, name: true },
    });
    if (owner && owner.email) {
      const plan = await prisma.plan.findUnique({ where: { id: restaurant.subscription.planId }, select: { name: true } }).catch(() => null);
      sendApplicationApprovedEmail({
        to: owner.email,
        applicantName: restaurant.ownerName || owner.name,
        restaurantName: restaurant.name,
        applicationRef: `APP-${String(restaurant.id).padStart(4, "0")}`,
        approvedAt: new Date().toUTCString(),
        planName: (plan && plan.name) || restaurant.subscription.plan,
        loginUrl: `${String(process.env.APP_FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "")}/login`,
      });
    }
  } catch (emailErr) {
    console.warn("[Onboarding] Approval email enqueue failed (non-critical):", emailErr.message);
  }

  return { ...result, message: "Application approved and activated" };
}

/** SUPER_ADMIN rejection — reason is mandatory and stored on the application. */
async function rejectApplication(restaurantId, reason, saUserId, meta) {
  const restaurant = await prisma.restaurant.findUnique({ where: { id: Number(restaurantId) } });
  if (!restaurant || restaurant.deletedAt) throw apiError("Application not found", 404);
  if (!restaurant.selfServe) throw apiError("This restaurant was not created through self-serve onboarding", 404);
  if (!reason || !String(reason).trim()) throw apiError("A rejection reason is required", 400);

  if (restaurant.status === "ACTIVE") {
    throw apiError("Cannot reject an already active restaurant", 400);
  }

  const cleanReason = String(reason).trim().slice(0, 1000);
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { onboardingStatus: "REJECTED", onboardingNote: cleanReason, status: "INACTIVE" },
  });

  await createAuditLog({
    restaurantId: restaurant.id,
    userId: saUserId,
    module: "USER",
    action: "UPDATE",
    description: `Business application rejected: ${cleanReason}`,
    referenceId: restaurant.id,
    referenceNo: restaurant.name,
    ipAddress: meta && meta.ipAddress,
    userAgent: meta && meta.userAgent,
  });

  // Personal notification for the owner ADMIN (public plane).
  const owner = await prisma.user.findFirst({ where: { restaurantId: restaurant.id, role: "ADMIN", deletedAt: null } });
  if (owner) {
    await prisma.notification.create({
      data: {
        restaurantId: restaurant.id,
        userId: owner.id,
        title: "Application Rejected",
        message: `Your business application was not approved. Reason: ${cleanReason}`,
        type: "SYSTEM",
      },
    }).catch(() => {});

    // ── Rejection email to the applicant (queued, non-fatal, idempotent) ──
    if (owner.email) {
      sendApplicationRejectedEmail({
        to: owner.email,
        applicantName: restaurant.ownerName || owner.name,
        restaurantName: restaurant.name,
        applicationRef: `APP-${String(restaurant.id).padStart(4, "0")}`,
        decidedAt: new Date().toUTCString(),
        reason: cleanReason,
      }).catch(() => {});
    }
  }
  return { id: restaurant.id, status: "REJECTED", message: "Application rejected" };
}

/** Recompute the application stage after the SA verifies/rejects a document. */
async function refreshStageAfterDocumentReview(restaurantId) {
  const restaurant = await prisma.restaurant.findUnique({ where: { id: Number(restaurantId) } });
  if (!restaurant || !restaurant.selfServe) return;
  if (restaurant.status === "ACTIVE") return;
  if (TERMINAL_STAGES.includes(restaurant.onboardingStatus)) return;
  if (restaurant.onboardingStatus === "UNDER_REVIEW") return; // waiting on the SA decision
  await persistStage(restaurant.id);
}

module.exports = {
  ONBOARDING_BILLING_CYCLE,
  APPLICATION_EXPIRY_DAYS,
  VALID_DOCUMENT_STATUSES,
  deriveStage,
  stageLabel,
  getSetting,
  setSetting,
  getReviewMode,
  setReviewMode,
  getOnboardingConfig,
  buildOnboardingPayload,
  createOrUpdateBusiness,
  createDocument,
  listDocuments,
  getOwnedDocument,
  resolveDocumentFilePath,
  acceptLegal,
  listPublicPlans,
  selectPlan,
  createCheckout,
  verifyPayment,
  finishVerifiedPayment,
  provisionAndActivate,
  approveApplication,
  rejectApplication,
  listApplications,
  applicationDetail,
  refreshStageAfterDocumentReview,
  persistStage,
  // Manual payment flow
  submitApplication,
  startManualApplication,
  markPaymentReceived,
  approveManualApplication,
  rejectManualApplication,
  getManualApplicationDetail,
  listManualApplications,
  MANUAL_PAYMENT_STATUS,
  MANUAL_ONBOARDING_STAGES,
  MANUAL_TERMINAL_STAGES,
  MANUAL_STATUS_LABELS,
  MANUAL_STATUS_MESSAGES,
};
