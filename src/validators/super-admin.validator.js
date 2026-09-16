const Joi = require("joi");
const { EMAIL_RE } = require("../utils/email");

// Strict email format shared with every other identity path (see utils/email).
const strictEmail = () =>
  Joi.string().custom((value, helpers) => {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean) return helpers.error("any.custom", { message: "Please enter a valid email address." });
    if (!EMAIL_RE.test(clean)) return helpers.error("any.custom", { message: "Please enter a valid email address." });
    return clean; // canonical (trimmed + lowercased) value flows on to the service
  });

const createRestaurantSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  ownerName: Joi.string().min(2).max(100).required(),
  mobile: Joi.string().required(),
  email: strictEmail().allow(null, "").optional(),
  gstNumber: Joi.string().allow(null, "").optional(),
  fssaiNumber: Joi.string().allow(null, "").optional(),
  address: Joi.string().allow(null, "").optional(),
  country: Joi.string().default("India"),
  state: Joi.string().allow(null, "").optional(),
  city: Joi.string().allow(null, "").optional(),
  pincode: Joi.string().allow(null, "").optional(),
  timezone: Joi.string().default("Asia/Kolkata"),
  currency: Joi.string().default("INR"),
  language: Joi.string().default("en"),
  logo: Joi.string().allow(null, "").optional(),
  planId: Joi.number().integer().allow(null).optional(),
  // Empty string = "no plan chosen" → the service falls back to the default plan.
  subscriptionPlan: Joi.string().allow(null, "").optional(),
  trialDays: Joi.number().integer().min(1).max(365).optional(),
  maxUsers: Joi.number().integer().optional(),
  maxTables: Joi.number().integer().optional(),
  maxMenuItems: Joi.number().integer().optional(),
  status: Joi.string().valid("ACTIVE", "INACTIVE", "SUSPENDED").default("ACTIVE"),
  // Food/dietary configuration — persisted to the tenant RestaurantSetting.
  // Default VEG_AND_NON_VEG unless explicitly selected (Part 1).
  dietaryMode: Joi.string().valid("VEG_ONLY", "VEG_AND_NON_VEG").default("VEG_AND_NON_VEG"),
  adminName: Joi.string().min(2).max(100).required(),
  adminEmail: strictEmail().required().messages({
    "any.custom": "Please enter a valid email address.",
  }),
  adminPassword: Joi.string().min(6).required(),
  // NOTE: NO legal-acceptance fields here — Super Admin → Add Restaurant is a
  // PLATFORM ADMINISTRATIVE operation (the Super Admin acts for the platform,
  // not as an accepting customer). Mandatory Terms/Privacy acceptance lives
  // ONLY in the new-user self-serve registration flow (onboarding.validator
  // legalSchema + onboarding Legal step). The PolicyAgreement store remains
  // available to record acceptances through its dedicated endpoints.
});

const updateRestaurantSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  ownerName: Joi.string().min(2).max(100).optional(),
  mobile: Joi.string().optional(),
  email: strictEmail().allow(null, "").optional(),
  gstNumber: Joi.string().allow(null, "").optional(),
  fssaiNumber: Joi.string().allow(null, "").optional(),
  address: Joi.string().allow(null, "").optional(),
  country: Joi.string().optional(),
  state: Joi.string().allow(null, "").optional(),
  city: Joi.string().allow(null, "").optional(),
  pincode: Joi.string().allow(null, "").optional(),
  timezone: Joi.string().optional(),
  currency: Joi.string().optional(),
  language: Joi.string().optional(),
  logo: Joi.string().allow(null, "").optional(),
  status: Joi.string().valid("ACTIVE", "INACTIVE", "SUSPENDED").optional(),
  dietaryMode: Joi.string().valid("VEG_ONLY", "VEG_AND_NON_VEG").optional(),
}).min(1);

const createUserSchema = Joi.object({
  restaurantId: Joi.number().integer().required(),
  name: Joi.string().min(2).max(100).required(),
  email: strictEmail().required().messages({
    "any.custom": "Please enter a valid email address.",
  }),
  password: Joi.string().min(6).required(),
  role: Joi.string().valid("ADMIN", "MANAGER", "CASHIER", "WAITER", "KITCHEN").required(),
  phone: Joi.string().allow(null, "").optional(),
  avatar: Joi.string().allow(null, "").optional(),
  isActive: Joi.boolean().default(true),
});

const createPlanSchema = Joi.object({
  code: Joi.string().min(2).max(50).required(),
  name: Joi.string().min(2).max(100).required(),
  description: Joi.string().allow(null, "").max(500).optional(),
  // Business/plan mode is REQUIRED at creation (spec §11) — only the two
  // supported modes are accepted.
  businessMode: Joi.string().valid("RESTAURANT", "BASIC_POS").required(),
  monthlyPrice: Joi.number().min(0).allow(null).optional(),
  yearlyPrice: Joi.number().min(0).allow(null).optional(),
  billingCycle: Joi.string().valid("MONTHLY", "YEARLY", "ONCE").default("MONTHLY"),
  trialDays: Joi.number().integer().min(0).max(3650).default(0),
  maxUsers: Joi.number().integer().min(0).allow(null).optional(),
  maxTables: Joi.number().integer().min(0).allow(null).optional(),
  maxFloors: Joi.number().integer().min(0).allow(null).optional(),
  maxMenuItems: Joi.number().integer().min(0).allow(null).optional(),
  maxPrinters: Joi.number().integer().min(0).allow(null).optional(),
  maxBranches: Joi.number().integer().min(0).allow(null).optional(),
  maxOrdersPerMonth: Joi.number().integer().min(0).allow(null).optional(),
  storageLimitMB: Joi.number().integer().min(0).allow(null).optional(),
  features: Joi.array().items(Joi.string()).optional(),
  modules: Joi.array().items(Joi.object({ moduleKey: Joi.string().required(), enabled: Joi.boolean().default(true) })).optional(),
  isActive: Joi.boolean().default(true),
  isDefault: Joi.boolean().default(false),
  sortOrder: Joi.number().integer().default(0),
});

const updatePlanSchema = Joi.object({
  code: Joi.string().min(2).max(50).optional(),
  name: Joi.string().min(2).max(100).optional(),
  description: Joi.string().allow(null, "").max(500).optional(),
  // Mode changes are allowed but guarded (service throws 409 requiring
  // confirmModeChange=true when subscriptions exist on the plan).
  businessMode: Joi.string().valid("RESTAURANT", "BASIC_POS").optional(),
  confirmModeChange: Joi.boolean().optional(),
  monthlyPrice: Joi.number().min(0).allow(null).optional(),
  yearlyPrice: Joi.number().min(0).allow(null).optional(),
  billingCycle: Joi.string().valid("MONTHLY", "YEARLY", "ONCE").optional(),
  trialDays: Joi.number().integer().min(0).max(3650).optional(),
  maxUsers: Joi.number().integer().min(0).allow(null).optional(),
  maxTables: Joi.number().integer().min(0).allow(null).optional(),
  maxFloors: Joi.number().integer().min(0).allow(null).optional(),
  maxMenuItems: Joi.number().integer().min(0).allow(null).optional(),
  maxPrinters: Joi.number().integer().min(0).allow(null).optional(),
  maxBranches: Joi.number().integer().min(0).allow(null).optional(),
  maxOrdersPerMonth: Joi.number().integer().min(0).allow(null).optional(),
  storageLimitMB: Joi.number().integer().min(0).allow(null).optional(),
  features: Joi.array().items(Joi.string()).optional(),
  modules: Joi.array().items(Joi.object({ moduleKey: Joi.string().required(), enabled: Joi.boolean().default(true) })).optional(),
  isActive: Joi.boolean().optional(),
  isDefault: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().optional(),
}).min(1);

// Plan-mode change confirmation fields (see updatePlanSchema service guard)
// businessMode/confirmModeChange are validated as part of updatePlanSchema:

const changePlanSchema = Joi.object({
  planId: Joi.number().integer().required(),
  action: Joi.string().valid("upgrade", "downgrade", "change").optional(),
  billingCycle: Joi.string().valid("MONTHLY", "YEARLY", "ONCE").optional(),
  effectiveDate: Joi.date().optional(),
  notes: Joi.string().allow(null, "").max(500).optional(),
});

module.exports = {
  createRestaurantSchema,
  updateRestaurantSchema,
  createUserSchema,
  createPlanSchema,
  updatePlanSchema,
  changePlanSchema,
};
