const Joi = require("joi");

const createUserSchema = Joi.object({

    name: Joi.string()
        .min(3)
        .max(50)
        .required(),

    email: Joi.string()
        .email()
        .required(),

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