const Joi = require("joi");
const { POLICY_TYPES } = require("../config/onboarding.config");
const { EMAIL_RE } = require("../utils/email");

// Strict email format — far stronger than "contains @". Joi's default email()
// is permissive in places (e.g. bare domains); this custom rule enforces the
// project-wide canonical pattern (dot-atom local part + dotted domain with an
// alphabetic TLD) shared with every other identity path.
const strictEmail = () =>
  Joi.string().custom((value, helpers) => {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean) return helpers.error("any.empty");
    if (!EMAIL_RE.test(clean)) return helpers.error("any.custom", { message: "Please enter a valid email address." });
    return clean; // canonical (trimmed + lowercased) value flows on to the service
  });

/**
 * Public self-serve registration. The account is ALWAYS created as an ADMIN
 * with no restaurantId (platform role, whitelisted fields only) — a caller can
 * never request a role or restaurant through this endpoint.
 */
const registerSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: strictEmail().required().messages({
    "any.custom": "Please enter a valid email address.",
    "any.empty": "Email is required.",
  }),
  phone: Joi.string().min(6).max(25).required(),
  password: Joi.string()
    .min(8)
    .pattern(/^(?=.*[A-Za-z])(?=.*\d)/, "password")
    .message("Password must be at least 8 characters and contain letters and numbers"),
  confirmPassword: Joi.string().valid(Joi.ref("password")).required().messages({
    "any.only": "Passwords do not match",
    "any.required": "Confirm your password",
  }),
});

/**
 * Business details (type + information). Jurisdiction-specific fields
 * (GST, registration number, …) stay optional — only the fields the flow
 * requires are mandatory.
 */
const businessSchema = Joi.object({
  businessType: Joi.string()
    // HOTEL is legacy-only: existing records stay readable, new onboarding rejects it (spec §14).
    .valid("RESTAURANT", "BAKERY", "CAFE", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "FOOD_COURT", "OTHER")
    .invalid("HOTEL")
    .required(),
  name: Joi.string().min(2).max(150).required(), // trading/business name
  legalName: Joi.string().allow(null, "").max(200).optional(),
  registrationNumber: Joi.string().allow(null, "").max(100).optional(),
  ownerName: Joi.string().min(2).max(100).allow(null, "").optional(),
  email: strictEmail().allow(null, "").optional().messages({
    "any.custom": "Please enter a valid email address.",
  }),
  phone: Joi.string().min(6).max(25).required(),
  gstNumber: Joi.string().allow(null, "").max(50).optional(),
  fssaiNumber: Joi.string().allow(null, "").max(50).optional(),
  address: Joi.string().allow(null, "").max(500).optional(),
  city: Joi.string().allow(null, "").max(100).optional(),
  state: Joi.string().allow(null, "").max(100).optional(),
  country: Joi.string().allow(null, "").max(100).default("India"),
  pincode: Joi.string().allow(null, "").max(20).optional(),
  website: Joi.string().allow(null, "").max(200).optional(),
  currency: Joi.string().allow(null, "").max(10).optional(),
  timezone: Joi.string().allow(null, "").max(60).optional(),
});

/** Legal acceptance: ALL required policies must be accepted in one payload. */
const legalSchema = Joi.object({
  acceptances: Joi.array()
    .items(
      Joi.object({
        type: Joi.string()
          .valid(
            POLICY_TYPES.TERMS_OF_SERVICE,
            POLICY_TYPES.PRIVACY_POLICY,
            POLICY_TYPES.ACCURACY_CONFIRMATION
          )
          .required(),
        version: Joi.string().required(),
      })
    )
    .min(1)
    .required()
    .custom((value, helpers) => {
      // Terms, Privacy Policy AND accuracy confirmation are all required —
      // the user must explicitly accept each one (never one generic checkbox).
      const types = new Set(value.map((a) => a.type));
      const required = [
        POLICY_TYPES.TERMS_OF_SERVICE,
        POLICY_TYPES.PRIVACY_POLICY,
        POLICY_TYPES.ACCURACY_CONFIRMATION,
      ];
      for (const t of required) {
        if (!types.has(t)) {
          return helpers.error("any.custom", { message: `${t} must be accepted before continuing` });
        }
      }
      if (types.size !== value.length) {
        return helpers.error("any.custom", { message: "Duplicate policy acceptance entries are not allowed" });
      }
      return value;
    })
    .messages({ "any.custom": "{{#message}}" }),
});

const selectPlanSchema = Joi.object({
  planId: Joi.number().integer().positive().required(),
});

const verifyPaymentSchema = Joi.object({
  subscriptionPaymentId: Joi.number().integer().positive().required(),
  razorpayOrderId: Joi.string().required(),
  razorpayPaymentId: Joi.string().required(),
  razorpaySignature: Joi.string().required(),
});

/** Manual payment application start schema */
const manualStartSchema = Joi.object({
  name: Joi.string().min(2).max(150).required(),
  businessType: Joi.string()
    .valid("RESTAURANT", "BAKERY", "CAFE", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "FOOD_COURT", "OTHER")
    .invalid("HOTEL")
    .required(),
  legalName: Joi.string().allow(null, "").max(200).optional(),
  registrationNumber: Joi.string().allow(null, "").max(100).optional(),
  ownerName: Joi.string().min(2).max(100).allow(null, "").optional(),
  email: strictEmail().allow(null, "").optional().messages({
    "any.custom": "Please enter a valid email address.",
  }),
  phone: Joi.string().min(6).max(25).required(),
  gstNumber: Joi.string().allow(null, "").max(50).optional(),
  fssaiNumber: Joi.string().allow(null, "").max(50).optional(),
  address: Joi.string().allow(null, "").max(500).optional(),
  city: Joi.string().allow(null, "").max(100).optional(),
  state: Joi.string().allow(null, "").max(100).optional(),
  country: Joi.string().allow(null, "").max(100).default("India"),
  pincode: Joi.string().allow(null, "").max(20).optional(),
  website: Joi.string().allow(null, "").max(200).optional(),
  currency: Joi.string().allow(null, "").max(10).optional(),
  timezone: Joi.string().allow(null, "").max(60).optional(),
  planId: Joi.number().integer().positive().required(),
});

/** Manual payment verification schema (Super Admin marks payment received) */
const manualPaymentSchema = Joi.object({
  restaurantId: Joi.number().integer().positive().required(),
  amount: Joi.number().positive().required(),
  transactionRef: Joi.string().max(255).optional(),
  paymentDate: Joi.date().iso().optional(),
  paymentProof: Joi.string().max(500).optional(),
});

/** OTP send request — strict email, canonical value flows to the service. */
const sendOtpSchema = Joi.object({
  email: strictEmail().required().messages({
    "any.custom": "Please enter a valid email address.",
    "any.empty": "Email is required.",
  }),
});

/** OTP verify request — email + exactly 6 digits. */
const verifyOtpSchema = Joi.object({
  email: strictEmail().required().messages({
    "any.custom": "Please enter a valid email address.",
    "any.empty": "Email is required.",
  }),
  otp: Joi.string().pattern(/^\d{6}$/).required().messages({
    "any.required": "Verification code is required.",
    "string.pattern.base": "Enter the 6-digit verification code.",
  }),
});

/** Minimal validation for application ID parameter */
const validateApplicationId = (value, helpers) => {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return helpers.error("any.invalid");
  }
  return num;
};

module.exports = {
  registerSchema,
  businessSchema,
  legalSchema,
  selectPlanSchema,
  verifyPaymentSchema,
  manualStartSchema,
  manualPaymentSchema,
  sendOtpSchema,
  verifyOtpSchema,
  validateApplicationId,
};
