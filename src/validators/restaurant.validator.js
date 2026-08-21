const Joi = require("joi");

const restaurantSchema = Joi.object({

    name: Joi.string().min(2).max(100).required(),

    ownerName: Joi.string().min(2).max(100).required(),

    phone: Joi.string().required(),

    email: Joi.string().email().allow(null, ""),

    gstNumber: Joi.string().allow(null, ""),

    fssaiNumber: Joi.string().allow(null, ""),

    address: Joi.string().allow(null, ""),

    city: Joi.string().allow(null, ""),

    state: Joi.string().allow(null, ""),

    country: Joi.string().default("India"),

    pincode: Joi.string().allow(null, ""),

    logo: Joi.string().allow(null, ""),

    // Restaurant Admin

    adminName: Joi.string().min(2).max(100).required(),

    adminEmail: Joi.string().email().required(),

    adminPhone: Joi.string().required(),

    adminPassword: Joi.string().min(8).required()

});

module.exports = {

    restaurantSchema

};