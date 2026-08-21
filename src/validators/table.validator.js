const Joi = require("joi");

const createTableSchema = Joi.object({
    tableNo: Joi.string().trim().min(1).required(),
    name: Joi.string().allow("", null).optional(),
    capacity: Joi.number().positive().required(),
    shape: Joi.string().allow("", null).optional(),
    floorId: Joi.number().optional(),
});

const updateTableSchema = Joi.object({
    tableNo: Joi.string().trim().min(1).optional(),
    name: Joi.string().allow("", null).optional(),
    capacity: Joi.number().positive().optional(),
    shape: Joi.string().allow("", null).optional(),
    floorId: Joi.number().optional(),
}).min(1); // at least one field must be present on update

module.exports = {
    createTableSchema,
    updateTableSchema
};
