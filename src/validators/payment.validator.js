const Joi = require("joi");

// Rejects NaN / ±Infinity so garbage never reaches the database (Joi 18
// dropped the built-in .finite() number rule).
const finiteNumber = () =>
  Joi.number().custom((v, h) => {
    if (!Number.isFinite(v)) return h.error("number.base");
    return v;
  });

const paymentItemSchema = Joi.object({
  amount: Joi.number().positive().required(),
  paymentMethod: Joi.string()
    .valid("CASH", "CARD", "UPI")
    .required(),
  transactionId: Joi.string().allow("", null).optional(),
  gatewayRef: Joi.string().allow("", null).optional(),
  notes: Joi.string().allow("", null).optional(),
  // Card fields
  cardNumber: Joi.string().allow("", null).optional(),
  cardType: Joi.string().allow("", null).optional(),
  last4Digits: Joi.string().allow("", null).optional(),
  approvalCode: Joi.string().allow("", null).optional(),
  // UPI fields
  upiTransactionId: Joi.string().allow("", null).optional(),
});

const collectPaymentSchema = Joi.object({
  orderId: Joi.number().required(),
  payments: Joi.array().items(paymentItemSchema).min(1).required(),
  discount: Joi.number().default(0),
  discountType: Joi.string().valid("FLAT", "PERCENTAGE").optional(),
  // Percentage discounts are capped at 100%; flat discounts may be any
  // non-negative value (the amount is clamped to the subtotal downstream).
  // finiteNumber() rejects NaN / ±Infinity so garbage never reaches the DB.
  discountValue: finiteNumber()
    .min(0)
    .when("discountType", {
      is: "PERCENTAGE",
      then: finiteNumber().min(0).max(100),
      otherwise: finiteNumber().min(0),
    })
    .default(0),
  discountReason: Joi.string().allow("", null).optional(),
  serviceCharge: Joi.number().default(0),
  roundOff: Joi.number().default(0),
});

const createPaymentSchema = Joi.object({
  billId: Joi.number().required(),
  amount: Joi.number().positive().required(),
  paymentMethod: Joi.string()
    .valid("CASH", "CARD", "UPI")
    .required(),
  transactionId: Joi.string().allow("", null).optional(),
  notes: Joi.string().allow("", null).optional(),
  // Card fields
  cardNumber: Joi.string().allow("", null).optional(),
  cardType: Joi.string().allow("", null).optional(),
  last4Digits: Joi.string().allow("", null).optional(),
  approvalCode: Joi.string().allow("", null).optional(),
  // UPI fields
  upiTransactionId: Joi.string().allow("", null).optional(),
});

const partialPaymentSchema = Joi.object({
  billId: Joi.number().required(),
  amount: Joi.number().positive().required(),
  paymentMethod: Joi.string()
    .valid("CASH", "CARD", "UPI")
    .required(),
  transactionId: Joi.string().allow("").optional(),
  notes: Joi.string().allow("").optional(),
  // Card fields
  cardNumber: Joi.string().allow("", null).optional(),
  cardType: Joi.string().allow("", null).optional(),
  last4Digits: Joi.string().allow("", null).optional(),
  approvalCode: Joi.string().allow("", null).optional(),
  // UPI fields
  upiTransactionId: Joi.string().allow("", null).optional(),
});

const splitPaymentSchema = Joi.object({
  billId: Joi.number().required(),
  payments: Joi.array().items(paymentItemSchema).min(2).required(),
});

module.exports = {
  collectPaymentSchema,
  createPaymentSchema,
  partialPaymentSchema,
  splitPaymentSchema,
};