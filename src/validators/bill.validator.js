const Joi = require("joi");

// Rejects NaN / ±Infinity (Joi 18 dropped the built-in .finite() rule).
const finiteNumber = () =>
  Joi.number().custom((v, h) => {
    if (!Number.isFinite(v)) return h.error("number.base");
    return v;
  });

const createBillSchema = Joi.object({

    orderId: Joi.number().required(),

    discount: Joi.number().default(0),
    discountType: Joi.string().valid("FLAT", "PERCENTAGE").optional(),
    discountValue: finiteNumber().min(0).default(0),
    discountReason: Joi.string().allow("", null).optional(),

    serviceCharge: Joi.number().default(0),

    roundOff: Joi.number().default(0),

    // Accepted for backward compatibility with the legacy bill flow.
    // The actual order items are read from the order itself, never from here.
    items: Joi.array().optional()

});

const applyBillDiscountSchema = Joi.object({

    discountType: Joi.string()
        .valid("FLAT", "PERCENTAGE")
        .required(),

    discountValue: finiteNumber()
        .min(0)
        .when("discountType", {
            is: "PERCENTAGE",
            then: finiteNumber().min(0).max(100),
            otherwise: finiteNumber().min(0)
        })
        .required(),

    discountReason: Joi.string()
        .allow("", null)
        .optional()

});

const cancelBillSchema = Joi.object({

    reason: Joi.string()

        .trim()

        .min(5)

        .max(255)

        .required()

});


module.exports = {

    createBillSchema,
    applyBillDiscountSchema,
    cancelBillSchema

};