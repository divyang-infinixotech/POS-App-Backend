const Joi = require("joi");
const { EMAIL_RE } = require("../utils/email");

// Strict email format shared with every other identity path (see utils/email).
const strictEmail = () =>
    Joi.string().custom((value, helpers) => {
        const clean = String(value || "").trim().toLowerCase();
        if (!clean) return helpers.error("any.custom", { message: "Email is required." });
        if (!EMAIL_RE.test(clean)) return helpers.error("any.custom", { message: "Please enter a valid email address." });
        return clean;
    });

const createUserSchema = Joi.object({

    name: Joi.string()
        .min(3)
        .max(50)
        .required(),

    email: strictEmail()
        .required()
        .messages({
            "any.custom": "Please enter a valid email address.",
            "any.required": "Email is required."
        }),

    phone: Joi.string()
        .allow("", null),

    password: Joi.string()
        .min(6)
        .required(),

    role: Joi.string()
        .valid(
            "ADMIN",
            "MANAGER",
            "CASHIER",
            "WAITER",
            "KITCHEN"
        )
        .required(),

    avatar: Joi.string()
        .allow("", null)

});

module.exports = {
    createUserSchema
};