const jwt = require("jsonwebtoken");
const { platformPrisma: prisma } = require("../config/tenantPrisma");

/**
 * Subscription self-service paths the ADMIN still needs when the subscription
 * has expired (view own snapshot, plans, checkout, verify, payment history,
 * gateway readiness, scheduled-downgrade cleanup). /auth/profile is included
 * so the frontend can rehydrate the expired snapshot on app boot. Everything
 * else stays blocked for an expired subscription.
 */
function isSubscriptionSelfServiceRoute(url) {
  const path = String(url || "").split("?")[0];
  if (/^\/api\/auth\/profile$/.test(path)) return true;
  return /^\/api\/subscriptions\/(me|refresh|plans|gateway-status|payments|checkout|verify|downgrade)($|\/)/.test(path);
}

/**
 * Auth middleware that supports both public schema users (SUPER_ADMIN, ADMIN)
 * and tenant schema users (MANAGER, CASHIER, KITCHEN, WAITER).
 *
 * Resolution strategy:
 *   1. Decode JWT -> extract id, role, restaurantId
 *   2. SUPER_ADMIN / ADMIN -> look up in public.User
 *   3. Staff roles (MANAGER/CASHIER/KITCHEN/WAITER) -> look up in tenant schema
 *   4. Attach req.user and req.tenantDb for downstream controllers
 */
const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
        token = req.headers.authorization.split(" ")[1];
    }
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ success: false, message: "No token provided" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Determine user type from JWT role
        const isPlatformUser = decoded.role === "SUPER_ADMIN" || decoded.role === "ADMIN";
        const isTenantStaff = !isPlatformUser && decoded.restaurantId;

        let user = null;
        let tenantDb = null;

        if (isPlatformUser) {
            // Platform user (SUPER_ADMIN / ADMIN): look up in public.User
            user = await prisma.user.findUnique({
                where: { id: decoded.id },
                include: { restaurant: true }
            });
        } else if (isTenantStaff) {
            // Tenant staff (MANAGER / CASHIER / KITCHEN / WAITER):
            // Resolve tenant schema from restaurantId and look up user there.
            try {
                const { getTenantClientByRestaurantId } = require("../config/tenantPrisma");
                const { client } = await getTenantClientByRestaurantId(decoded.restaurantId);
                tenantDb = client;
                user = await tenantDb.user.findUnique({ where: { id: decoded.id } });
                req.tenantDb = tenantDb;
            } catch (tenantErr) {
                console.error("[Auth] Tenant resolution failed for restaurant " + decoded.restaurantId + ":", tenantErr.message);
                return res.status(503).json({
                    success: false,
                    message: "Restaurant data not available: " + tenantErr.message + ". Please contact support."
                });
            }
        }

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (!user.isActive) {
            return res.status(403).json({ success: false, message: "Your account has been disabled." });
        }

        // Password changed check - invalidate old tokens
        if (user.passwordChangedAt) {
            const changedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
            if (decoded.iat && changedAtSec > decoded.iat) {
                return res.status(401).json({ success: false, message: "Your password was changed. Please log in again." });
            }
        }

        // Restaurant validation (platform users only)
        if (isPlatformUser && user.role !== "SUPER_ADMIN" && !user.restaurant) {
            return res.status(403).json({ success: false, message: "Restaurant not found." });
        }
        if (isPlatformUser && user.role !== "SUPER_ADMIN" && user.restaurant && user.restaurant.status !== "ACTIVE") {
            return res.status(403).json({
                success: false,
                message: "Your restaurant account is " + user.restaurant.status.toLowerCase() + ". Contact your Super Admin."
            });
        }

        // Subscription gate (restaurant users only)
        // ADMIN can always reach subscription self-service routes even when expired.
        if (user.role !== "SUPER_ADMIN" && decoded.restaurantId) {
          try {
            const subscription = await prisma.subscription.findUnique({
              where: { restaurantId: decoded.restaurantId },
              select: { status: true, expiryDate: true },
            });
            let subStatus = subscription ? subscription.status : null;
            if (subscription && (subStatus === "ACTIVE" || subStatus === "TRIAL") && subscription.expiryDate && subscription.expiryDate < new Date()) {
              subStatus = "EXPIRED";
            }
            const blocked =
              !subscription ||
              subStatus === "CANCELLED" ||
              subStatus === "SUSPENDED" ||
              (subStatus === "EXPIRED" && !isSubscriptionSelfServiceRoute(req.originalUrl || req.url));
            if (blocked) {
              const reason = !subscription
                ? "No subscription found for your restaurant. Contact your Super Admin."
                : subStatus === "EXPIRED"
                  ? "Your subscription has expired. Please renew to continue."
                  : subStatus === "CANCELLED"
                    ? "Your subscription has been cancelled. Contact support to renew."
                    : "Your subscription is suspended. Contact support to reactivate.";
              return res.status(403).json({ success: false, message: reason });
            }
          } catch (err) {
            // fail-open only if subscription data cannot be resolved
          }
        }

        // Build req.user - same shape as before for backward compatibility
        req.user = {
            id: user.id,
            restaurantId: decoded.restaurantId || null,
            role: user.role,
            name: user.name,
            email: user.email
        };

        // Attach tenant Prisma client for restaurant users
        // SUPER_ADMIN skips this (they use platformPrisma directly).
        // Staff: tenantDb was already attached above during user lookup.
        // ADMIN: attach tenantDb here so they can manage staff in their restaurant.
        if (req.user.role !== "SUPER_ADMIN" && req.user.restaurantId && !req.tenantDb) {
          try {
            const { getTenantClientByRestaurantId } = require("../config/tenantPrisma");
            const { client } = await getTenantClientByRestaurantId(req.user.restaurantId);
            req.tenantDb = client;
          } catch (tenantErr) {
            console.error("[Auth] Tenant resolution failed for restaurant " + req.user.restaurantId + ":", tenantErr.message);
            return res.status(503).json({
              success: false,
              message: "Restaurant data not available: " + tenantErr.message + ". Please contact support."
            });
          }
        }

        next();

    } catch (error) {
        return res.status(401).json({ success: false, message: "Invalid token" });
    }
};

module.exports = protect;
