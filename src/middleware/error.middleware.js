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
        // Return the actual error message in dev, sanitized in production
        const devMessage = process.env.NODE_ENV === 'production'
            ? "Internal Server Error"
            : err.message || "Invalid request parameters";
        return res.status(400).json({
            success: false,
            message: devMessage
        });
    }

    const status = err.statusCode || 500;

    // In production never echo raw internal error messages (Prisma details,
    // filesystem paths, SQL) back to the client — the full error is logged
    // above. Intentional 4xx business errors carry their own safe message.
    if (status >= 500 && process.env.NODE_ENV === "production") {
        return res.status(status).json({
            success: false,
            message: "Internal Server Error"
        });
    }

    return res.status(status).json({
        success: false,
        message: err.message || "Internal Server Error"
    });

};

module.exports = errorHandler;