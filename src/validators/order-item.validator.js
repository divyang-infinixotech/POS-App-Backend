const Joi = require("joi");

const addOrderItemSchema = Joi.object({

    menuItemId: Joi.number()

        .integer()

        .required(),

    quantity: Joi.number()

        .integer()

        .min(1)

        .required(),

    notes: Joi.string()

        .allow("")

        .max(255)

        .optional()

});

const updateOrderItemSchema = Joi.object({

    quantity: Joi.number()

        .integer()

        .min(1)

        .required(),

    notes: Joi.string()

        .allow("")

        .max(255)

        .optional()

});

module.exports = {

    addOrderItemSchema,

    updateOrderItemSchema

};