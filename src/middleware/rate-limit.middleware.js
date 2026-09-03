const rateLimit = require("express-rate-limit");

const isProduction = process.env.NODE_ENV === "production";

/**
 * Shared function to skip rate limiting for:
 *   - Socket.IO transport ("/socket.io/")
 *   - Health-check endpoint ("/")
 *   - Static assets ("/uploads/")
 *   - Localhost / LAN IPs in DEVELOPMENT only
 *
 * The localhost/LAN skip must never apply in production: behind a reverse
 * proxy every client can appear as 127.0.0.1 or a private address, which
 * would silently disable rate limiting for real traffic.
 */
function isExcludedPath(req) {
  const path = req.originalUrl || req.url;

  if (!isProduction) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === '::ffff:127.0.0.1' ||
      ip === 'localhost' ||
      ip?.startsWith('192.168.') ||
      ip?.startsWith('10.') ||
      ip?.startsWith('172.16.')
    ) {
      return true;
    }
  }

  return (
    req.method === "OPTIONS" ||
    path.startsWith("/socket.io/") ||
    path === "/" ||
    path.startsWith("/uploads/")
  );
}

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isExcludedPath,
    message: {
        success: false,
        message:
            "Too many requests. Please try again later."
    }
});

// 50 attempts / 15 min per IP: still stops credential brute-forcing while
// never blocking a busy restaurant where all staff share one public IP
// (e.g. behind a NAT gateway) during shift-change logins.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isExcludedPath,
    message: {
        success: false,
        message:
            "Too many login attempts. Try again after 15 minutes."
    }
});

module.exports = {
    apiLimiter,
    loginLimiter
};