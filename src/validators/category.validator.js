const Joi = require("joi");

const createCategorySchema = Joi.object({
    name: Joi.string().trim().min(1).required(),
    image: Joi.string().allow("", null).optional(),
    color: Joi.string().allow("", null).optional(),
    icon: Joi.string().allow("", null).optional(),
    sortOrder: Joi.number().optional(),
    isActive: Joi.boolean().optional(),
});

const updateCategorySchema = Joi.object({
    name: Joi.string().trim().min(1).optional(),
    image: Joi.string().allow("", null).optional(),
    color: Joi.string().allow("", null).optional(),
    icon: Joi.string().allow("", null).optional(),
    sortOrder: Joi.number().optional(),
    isActive: Joi.boolean().optional(),
}).min(1); // at least one field must be present on update

module.exports = {
    createCategorySchema,
    updateCategorySchema
};
