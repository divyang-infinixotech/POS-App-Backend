const { createAuditLog } = require("../services/audit.service");

const audit = (module, action, getDescription) => {

    return (req, res, next) => {

        const originalJson = res.json;

        res.json = function (body) {

            if (
                res.statusCode >= 200 &&
                res.statusCode < 300
            ) {

                setImmediate(async () => {

                    try {

                        let description = "";

                        if (typeof getDescription === "function") {

                            description = getDescription(req, body);

                        } else {

                            description = getDescription;

                        }                        await createAuditLog({
                            restaurantId:
                                req.user?.restaurantId || null,
                            userId:
                                req.user?.id || null,
                            module,
                            action,
                            description,
                            referenceId:
                                body?.data?.id ||
                                body?.user?.id ||
                                null,
                            referenceNo:
                                body?.data?.billNo ||
                                body?.data?.orderNo ||
                                body?.data?.kotNo ||
                                null,
                            ipAddress: req.ip,
                            userAgent:
                                req.get("User-Agent")
                        }, req.tenantDb);

                    } catch (error) {

                        const logger = require("../logger/logger");

                        logger.error(

                            `Audit Error: ${error.message}`

                        );

                    }

                });

            }

            return originalJson.call(this, body);

        };

        next();

    };

};

module.exports = audit;