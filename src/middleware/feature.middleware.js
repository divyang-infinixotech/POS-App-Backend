/**
 * Plan feature access control middleware.
 * Blocks backend access to modules not included in the restaurant's current
 * subscription plan. SUPER_ADMIN bypasses the check.
 */
const prisma = require("../config/prisma");
const { PLAN_FEATURES, DEFAULT_FEATURES } = require("../config/subscription.config");

/**
 * requireFeature accepts a single key OR an array of keys (any-of).
 * Array form is used on shared read endpoints (e.g. GET /menu is needed by
 * both the Menu module and the POS Ordering screen) so that a valid plan
 * never breaks a core flow it is allowed to use.
 */
const requireFeature = (feature) => {
  const required = Array.isArray(feature) ? feature : [feature];
  return async (req, res, next) => {
    try {
      // SUPER_ADMIN has universal access
      if (req.user && req.user.role === "SUPER_ADMIN") return next();
      if (!req.user || !req.user.restaurantId) {
        return res.status(403).json({ success: false, message: "Feature not available on your subscription plan." });
      }

      const subscription = await prisma.subscription.findUnique({
        where: { restaurantId: req.user.restaurantId },
        select: { features: true, status: true, expiryDate: true },
      });

      if (!subscription) {
        return res.status(403).json({ success: false, message: "No subscription found for your restaurant. Contact your Super Admin." });
      }

      // Logical expiry check — blocks access immediately after expiry, before the cron persists EXPIRED
      let status = subscription.status;
      if ((status === "ACTIVE" || status === "TRIAL") && subscription.expiryDate && subscription.expiryDate < new Date()) {
        status = "EXPIRED";
      }

      if (status === "EXPIRED" || status === "CANCELLED" || status === "SUSPENDED") {
        return res.status(403).json({ success: false, message: "Your subscription is " + status.toLowerCase() + ". Contact your Super Admin." });
      }

      // Legacy subscriptions may have no feature snapshot — fall back to the default feature set
      const features = Array.isArray(subscription.features) && subscription.features.length > 0
        ? subscription.features
        : DEFAULT_FEATURES;
      if (!required.some((f) => features.includes(f))) {
        const label = PLAN_FEATURES[required[0]] ? PLAN_FEATURES[required[0]].label : required[0];
        return res.status(403).json({
          success: false,
          message: label + " is not included in your current subscription plan. Please contact your Super Admin to upgrade.",
        });
      }

      next();
    } catch (error) {
      console.error("[requireFeature] error:", error.message);
      return res.status(500).json({ success: false, message: "Server Error" });
    }
  };
};

module.exports = requireFeature;
