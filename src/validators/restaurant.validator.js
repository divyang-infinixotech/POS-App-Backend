const Joi = require("joi");
const { EMAIL_RE } = require("../utils/email");

// Strict email format shared with every other identity path (see utils/email).
const strictEmail = () =>
  Joi.string().custom((value, helpers) => {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean) return helpers.error("any.custom", { message: "Please enter a valid email address." });
    if (!EMAIL_RE.test(clean)) return helpers.error("any.custom", { message: "Please enter a valid email address." });
    return clean;
  });

const restaurantSchema = Joi.object({

    name: Joi.string().min(2).max(100).required(),

    ownerName: Joi.string().min(2).max(100).required(),

    phone: Joi.string().required(),

    email: strictEmail().allow(null, "").messages({
        "any.custom": "Please enter a valid email address.",
    }),

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

    adminEmail: strictEmail().required().messages({
        "any.custom": "Please enter a valid email address.",
    }),

    adminPhone: Joi.string().required(),

    adminPassword: Joi.string().min(8).required(),

    // NOTE: NO legal-acceptance fields — restaurant creation via the platform
    // (Super Admin / internal) is an administrative operation. Mandatory
    // Terms & Privacy acceptance lives ONLY in the self-serve registration
    // flow (onboarding legalSchema / Legal step).
});

module.exports = {

    restaurantSchema

};