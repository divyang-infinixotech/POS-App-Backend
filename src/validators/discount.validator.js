const Joi = require("joi");

// Mirrors the pure-rule validation in utils/discountRules.js (§33: frontend
// validation is UX only; backend repeats everything important).

const hhmm = Joi.string()
  .pattern(/^([01]?\d|2[0-3]):[0-5]\d$/)
  .allow(null, "");

const createDiscountSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().trim().max(500).allow("", null),

  type: Joi.string().valid("PERCENTAGE", "FIXED_AMOUNT", "STAFF", "PROMO_CODE").required(),

  discountValue: Joi.number().greater(0).when("type", {
    is: Joi.valid("PERCENTAGE", "STAFF"),
    then: Joi.number().greater(0).max(100).required(),
    otherwise: Joi.number().greater(0).required(),
  }),

  maximumDiscountAmount: Joi.number().min(0).allow(null),
  minimumOrderAmount: Joi.number().min(0).default(0),

  startDate: Joi.date().required(),
  endDate: Joi.date().greater(Joi.ref("startDate")).required(),
  startTime: hhmm,
  endTime: hhmm,

  status: Joi.string().valid("ACTIVE", "SCHEDULED", "DISABLED").default("ACTIVE"),
  // EXPIRED is never settable — derived from the schedule (§4/§28)

  scope: Joi.string().valid("ENTIRE_ORDER", "CATEGORIES", "PRODUCTS").default("ENTIRE_ORDER"),
  categoryIds: Joi.array().items(Joi.number().integer().positive()).when("scope", {
    is: "CATEGORIES",
    then: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
  }),
  menuItemIds: Joi.array().items(Joi.number().integer().positive()).when("scope", {
    is: "PRODUCTS",
    then: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
  }),

  applicableDays: Joi.number().integer().min(0).max(127).default(127),
  customerEligibility: Joi.string().valid("EVERYONE", "REGISTERED").default("EVERYONE"),

  stackable: Joi.boolean().default(false),
  maxDiscountsPerOrder: Joi.number().integer().min(1).max(5).default(1),

  usageLimit: Joi.number().integer().min(1).allow(null),
  perCustomerLimit: Joi.number().integer().min(1).allow(null),

  staffRoles: Joi.array()
    .items(Joi.string().valid("ADMIN", "MANAGER", "CASHIER", "WAITER", "KITCHEN"))
    .when("type", { is: "STAFF", then: Joi.array().min(1).required() }),
  staffRoleMaxPercent: Joi.object()
    .pattern(
      Joi.string().valid("ADMIN", "MANAGER", "CASHIER", "WAITER", "KITCHEN"),
      Joi.number().min(0).max(100)
    )
    .allow(null),

  code: Joi.string().trim().max(40).when("type", {
    is: "PROMO_CODE",
    then: Joi.string().trim().min(1).max(40).required(),
  }),

  // PROMO_CODE grant method: percentage or fixed amount (§4)
  promoMethod: Joi.string().valid("PERCENTAGE", "FIXED_AMOUNT").when("type", {
    is: "PROMO_CODE",
    then: Joi.string().valid("PERCENTAGE", "FIXED_AMOUNT").default("FIXED_AMOUNT"),
  }),

  // STAFF specific-member targeting: real tenant User ids (§5) — every id is
  // re-validated against req.tenantDb by the controller
  staffUserIds: Joi.array()
    .items(Joi.number().integer().positive())
    .when("type", { is: "STAFF", then: Joi.array().items(Joi.number().integer().positive()) }),
});

const updateDiscountSchema = createDiscountSchema.fork(
  ["name", "type", "discountValue", "startDate", "endDate"],
  (s) => s.optional()
);

const applyDiscountSchema = Joi.object({
  discountId: Joi.number().integer().positive(),
  promoCode: Joi.string().trim().max(40),
  staffRequestedValue: Joi.number().min(0).max(100),
  // STAFF discounts: the tenant User receiving the discount (validated
  // server-side against req.tenantDb — never trusted from the frontend)
  staffUserId: Joi.number().integer().positive(),
  reason: Joi.string().trim().max(255).allow("", null),
})
  .xor("discountId", "promoCode")
  .unknown(false);

const removeDiscountSchema = Joi.object({}).unknown(false);

const listEligibleSchema = Joi.object({}).unknown(true);

module.exports = {
  createDiscountSchema,
  updateDiscountSchema,
  applyDiscountSchema,
  removeDiscountSchema,
  listEligibleSchema,
};
