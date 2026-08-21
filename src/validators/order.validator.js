const Joi = require("joi");

const createOrderSchema = Joi.object({

    orderType: Joi.string()
        .valid("DINE_IN", "TAKEAWAY", "COUNTER_SALE")
        .required(),

    tableId: Joi.number().allow(null),
    customerId: Joi.number().optional(),

    discountType: Joi.string()

        .valid("FLAT", "PERCENTAGE")

        .optional(),

    discountValue: Joi.number()

        .min(0)

        .default(0),

    serviceCharge: Joi.number().default(0),

    notes: Joi.string().allow("", null),

    items: Joi.array().items(

        Joi.object({

            menuItemId: Joi.number().required(),

            quantity: Joi.number().required(),

            notes: Joi.string().allow("", null)

        })

    ).required()

});
const cancelOrderSchema = Joi.object({

    reason: Joi.string()

        .trim()

        .required()

});
const changeTableSchema = Joi.object({

    tableId: Joi.number()

        .integer()

        .required()

});
const updateOrderSchema = Joi.object({

    discount: Joi.number().min(0).optional(),

    serviceCharge: Joi.number().min(0).optional(),

    notes: Joi.string().allow("").optional(),

    items: Joi.array().items(

        Joi.object({

            menuItemId: Joi.number().required(),

            quantity: Joi.number().min(1).required(),

            notes: Joi.string().allow("").optional()

        })

    ).min(1).required()

});
const updateDiscountSchema = Joi.object({

    discountType: Joi.string()

        .valid("FLAT", "PERCENTAGE")

        .allow(null)

        .optional(),

    discountValue: Joi.number()

        .min(0)

        .required()

});

module.exports = {

    createOrderSchema,
    cancelOrderSchema,
    changeTableSchema,
    updateOrderSchema,
    updateDiscountSchema



};