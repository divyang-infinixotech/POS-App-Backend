/**
 * Plan feature access control middleware.
 * Blocks backend access to modules not included in the restaurant's current
 * subscription plan. SUPER_ADMIN bypasses the check.
 */
const prisma = require("../config/prisma");
const { PLAN_FEATURES, DEFAULT_FEATURES } = require("../config/subscription.config");
const { getBusinessCapabilities } = require("../utils/businessCapabilities");

/**
 * requireBusinessCapability(flag, label) — business-TYPE gate (distinct from
 * requireFeature's plan gate). Composes with it:
 *
 *   featureVisible = businessCapability && planCapability && userPermission
 *
 * Resolves the tenant's businessType from the platform Restaurant row
 * (never client-supplied) and rejects the request when the capability flag is
 * false — a retail tenant cannot create floors/tables/KOTs by calling the API
 * directly, regardless of what its plan includes. SUPER_ADMIN bypasses.
 */
const requireBusinessCapability = (flag, label) => {
  return async (req, res, next) => {
    try {
      if (req.user && req.user.role === "SUPER_ADMIN") return next();
      const restaurantId = req.user && req.user.restaurantId;
      if (!restaurantId) {
        return res.status(403).json({ success: false, message: "Feature not available for this business type." });
      }
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { businessType: true },
      });
      const capabilities = getBusinessCapabilities(restaurant ? restaurant.businessType : null);
      if (capabilities[flag] === false) {
        return res.status(403).json({
          success: false,
          message: (label || flag) + " is not available for this business type.",
        });
      }
      next();
    } catch (error) {
      console.error("[requireBusinessCapability] error:", error.message);
      return res.status(500).json({ success: false, message: "Server Error" });
    }
  };
};

module.exports.requireBusinessCapability = requireBusinessCapability;

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

      // §16 read-time normalization (capability resolution, not scattered
      // businessType checks): a BASIC_POS FOOD business (kitchen capability
      // true, tables false) always carries kitchen + active_orders even if its
      // plan snapshot predates the BASIC_POS production workflow — kitchen
      // status updates and Active Orders are core to that workflow. A retail
      // QUICK_BILLING business (kitchen capability false) can NEVER gain them
      // here, and restaurants are untouched (their plans already include both).
      let effectiveFeatures = features;
      try {
        const _rest = await prisma.restaurant.findUnique({
          where: { id: req.user.restaurantId },
          select: { businessType: true },
        });
        const _caps = getBusinessCapabilities(_rest ? _rest.businessType : null);
        if (_caps.kitchen === true && _caps.tables !== true) {
          effectiveFeatures = Array.from(new Set([...features, "kitchen", "active_orders"]));
        }
      } catch (_capErr) {
        // Lookup failed → keep the stored snapshot (fail closed, no upgrade)
      }

      if (!required.some((f) => effectiveFeatures.includes(f))) {
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

/**
 * Restaurant-level module toggle (tenant RestaurantSetting).
 *
 * Hierarchy: plan entitlement (requireFeature) → restaurant toggle → staff
 * permission. The toggle can only turn a plan-granted capability OFF; it can
 * never grant anything the plan does not include. SUPER_ADMIN bypasses (the
 * platform toggle screen is separate). Existing requireFeature chains are
 * untouched — use this alongside them on staff-roster management routes.
 *
 * Reads the value from req.tenantDb (tenant RestaurantSetting, DB authoritative);
 * if the row/column is missing the toggle defaults to ON so existing behavior
 * is never unexpectedly blocked.
 */
const requireModuleEnabled = (settingKey, label) => {
  return async (req, res, next) => {
    try {
      if (req.user && req.user.role === "SUPER_ADMIN") return next();
      if (!req.tenantDb) return next(); // no tenant context — leave gating to requireFeature
      const setting = await req.tenantDb.restaurantSetting.findFirst({
        where: { restaurantId: req.user.restaurantId },
        select: { [settingKey]: true },
      });
      // Missing row or legacy column → default ON (never surprise-block existing tenants)
      if (!setting || setting[settingKey] !== false) return next();
      return res.status(403).json({
        success: false,
        message: (label || settingKey) + " has been disabled in POS Settings. Contact your restaurant administrator.",
      });
    } catch (error) {
      // Column not migrated yet / transient DB error → fail open like a missing setting
      console.error("[requireModuleEnabled] error:", error.message);
      return next();
    }
  };
};

// requireFeature stays the default export — dozens of route files destructure
// the module directly. requireModuleEnabled / requireBusinessCapability are
// attached as named properties.
module.exports = requireFeature;
module.exports.requireModuleEnabled = requireModuleEnabled;
module.exports.requireBusinessCapability = requireBusinessCapability;
