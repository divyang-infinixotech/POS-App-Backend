const errorHandler = (err, req, res, next) => {

    const logger = require("../logger/logger");

    logger.error({
        message: err.message,
        stack: err.stack,
        method: req.method,
        path: req.originalUrl,
        userId: req.user?.id || null,
        role: req.user?.role || null
    });

    // Handle known Prisma errors gracefully
    if (err.code === "P2025") {
        return res.status(404).json({
            success: false,
            message: "Resource not found"
        });
    }

    if (err.code === "P2003") {
        return res.status(409).json({
            success: false,
            message: "Referenced resource does not exist"
        });
    }

    if (err.code === "P2002") {
        return res.status(409).json({
            success: false,
            message: "A record with this value already exists"
        });
    }

    // Handle invalid JSON body
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({
            success: false,
            message: "Invalid JSON in request body"
        });
    }

    // Prisma client-side validation errors (e.g. a non-numeric :id parameter
    // reaching Number(req.params.id) → NaN, or a malformed filter value) are
    // client-input problems — return a clean 400, never a 500 with the raw
    // Prisma invocation details. The full error is still logged above.
    if (err && err.name === "PrismaClientValidationError") {
        // Detailed dev logging: helps diagnose schema/model mismatch issues
        console.error("[API ERROR] PrismaClientValidationError", {
            method: req.method,
            path: req.originalUrl,
            restaurantId: req.user?.restaurantId,
            tenantSchema: req.restaurant?.tenantSchema || req.tenantSchema || null,
            hasTenantDb: !!req.tenantDb,
            error: err.message,
            stack: err.stack?.split('\n').slice(0, 5).join('\n')
        });
        // Part 29: never echo raw Prisma invocation details (source file paths,
        // query internals, schema names) to ANY client — dev included. The full
        // error is logged above; the response is a clean, safe 400.
        return res.status(400).json({
            success: false,
            message: "Invalid request parameters."
        });
    }

    const status = err.statusCode || 500;

    // Part 29: sanitize 5xx messages in every environment — raw Prisma/SQL
    // details, filesystem paths and schema names must never reach the client.
    // Intentional 4xx business errors carry their own safe message.
    if (status >= 500) {
        return res.status(status).json({
            success: false,
            message: process.env.NODE_ENV === "production" || /Prisma|invocation|schema|SQL/i.test(err.message || "")
                ? "Internal Server Error"
                : err.message || "Internal Server Error"
        });
    }

    return res.status(status).json({
        success: false,
        message: err.message || "Internal Server Error"
    });

};

module.exports = errorHandler;