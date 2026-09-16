const Joi = require("joi");

const createMenuSchema = Joi.object({

    name: Joi.string().required(),

    shortName: Joi.string().allow("", null),

    // sku is nullable in the DB (String?) — the controller accepts items
    // without one, so the validator must not require it.
    sku: Joi.string().allow("", null),

    barcode: Joi.string().allow("", null),

    description: Joi.string().allow("", null),

    image: Joi.string().allow("", null),

    imagePublicId: Joi.string().allow("", null),

    price: Joi.number().required(),

    tax: Joi.number().default(0),

    preparationTime: Joi.number().default(15),

    isVeg: Joi.boolean().default(true),

    // Part 8/16: explicit dietary type. When absent, the controller falls back
    // to isVeg (legacy compatibility). VEG keeps isVeg in sync server-side.
    dietaryType: Joi.string().valid("VEG", "NON_VEG").optional(),

    // Part 16: optional subcategory — must belong to categoryId (checked in
    // the controller because it needs tenant data).
    subcategoryId: Joi.number().integer().positive().allow(null).optional(),

    isAvailable: Joi.boolean().default(true),

    categoryId: Joi.number().required()

});

const updateMenuSchema = Joi.object({
    name: Joi.string().min(1).optional(),
    shortName: Joi.string().allow("", null).optional(),
    sku: Joi.string().optional(),
    barcode: Joi.string().allow("", null).optional(),
    description: Joi.string().allow("", null).optional(),
    image: Joi.string().allow("", null).optional(),
    imagePublicId: Joi.string().allow("", null).optional(),
    price: Joi.number().positive().optional(),
    tax: Joi.number().min(0).optional(),
    preparationTime: Joi.number().min(0).optional(),    isVeg: Joi.boolean().optional(),

    dietaryType: Joi.string().valid("VEG", "NON_VEG").optional(),

    subcategoryId: Joi.number().integer().positive().allow(null).optional(),

    isAvailable: Joi.boolean().optional(),
    categoryId: Joi.number().optional(),
    currentStock: Joi.number().min(0).optional(),
    costPrice: Joi.number().min(0).optional(),
}).min(1); // at least one field must be present on update

module.exports = {
    createMenuSchema,
    updateMenuSchema
};