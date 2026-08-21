const Joi = require("joi");

const checkoutSchema = Joi.object({
  planId: Joi.number().integer().positive().required(),
  billingCycle: Joi.string().valid("MONTHLY", "YEARLY").default("MONTHLY"),
  action: Joi.string().valid("UPGRADE", "RENEWAL", "SWITCH").default("UPGRADE"),
});

const verifyPaymentSchema = Joi.object({
  subscriptionPaymentId: Joi.number().integer().positive().required(),
  razorpayOrderId: Joi.string().required(),
  razorpayPaymentId: Joi.string().required(),
  razorpaySignature: Joi.string().required(),
});

const scheduleDowngradeSchema = Joi.object({
  planId: Joi.number().integer().positive().required(),
});

module.exports = {
  checkoutSchema,
  verifyPaymentSchema,
  scheduleDowngradeSchema,
};
