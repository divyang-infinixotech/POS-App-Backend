const validate = (schema) => {

    return (req, res, next) => {

        // allowUnknown keeps schemas additive: they validate required/typed
        // fields without rejecting legitimate extra fields the controller
        // accepts (Joi's default would 400 on any field not listed in the
        // schema, which is stricter than the app's routes need).
        const { error } = schema.validate(req.body, { allowUnknown: true });

        if (error) {

            return res.status(400).json({

                success: false,

                message: error.details[0].message

            });

        }

        next();

    };

};

module.exports = validate;