const logger = require("../logger/logger");

/**
 * Role-based access control middleware.
 * SUPER_ADMIN is automatically granted access to any route.
 */
const authorize = (...roles) => {

  return (req, res, next) => {

    // SUPER_ADMIN has universal access
    if (req.user.role === "SUPER_ADMIN") {
      return next();
    }

    if (!roles.includes(req.user.role)) {

      logger.warn({
        message: "Access denied",
        userId: req.user.id,
        role: req.user.role,
        path: req.originalUrl,
        method: req.method,
        requiredRoles: roles
      });

      return res.status(403).json({
        success: false,
        message: "Access Denied"
      });

    }

    next();

  };

};

module.exports = authorize;