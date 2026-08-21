const Joi = require("joi");

const createKOTSchema = Joi.object({

    orderId: Joi.number().required(),

    notes: Joi.string().allow("", null),

    items: Joi.array().optional()

});
const updateKOTSchema = Joi.object({

    notes: Joi.string()

        .allow("")

        .optional(),

    priority: Joi.number()

        .min(0)

        .max(3)

        .optional()

});
const prioritySchema = Joi.object({

    priority: Joi.number()

        .integer()

        .min(0)

        .max(3)

        .required()

});
const cancelKOTSchema = Joi.object({

    reason: Joi.string()

        .trim()

        .min(3)

        .max(255)

        .required()

});

module.exports = {

    createKOTSchema,
    updateKOTSchema,
    prioritySchema,
    cancelKOTSchema

};