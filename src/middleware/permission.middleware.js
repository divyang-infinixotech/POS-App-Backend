/**
 * Per-staff permission middleware (Layer 3 of the permission model).
 *
 * Stack on a route:  protect → authorize(roles) → requireFeature(module) → requirePermission("key")
 *   - role authorization stays exactly as strict as before (never weakened),
 *   - requireFeature keeps the restaurant-wide module toggle authoritative,
 *   - this middleware adds the INDIVIDUAL staff override on top.
 *
 * Resolution (see utils/permissions.js):
 *   - ADMIN / SUPER_ADMIN → always allowed (Part 21),
 *   - everyone else → role defaults + their tenant.UserPermission overrides.
 * An absent row means "use the role default" — which is what preserves every
 * existing staff member's current access without a data migration.
 */
const { resolveEffectivePermissions, hasEffectivePermission } = require("../utils/permissions");

const requirePermission = (permissionKey) => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: "Not authorized" });
      }
      const role = String(user.role || "").toUpperCase();
      if (role === "ADMIN" || role === "SUPER_ADMIN") return next();

      // Tenant staff: permission rows live in the tenant schema — the client
      // authenticated through it and req.tenantDb is already attached by
      // protect/tenantDB middleware. Never a client-supplied schema name.
      let permRows = [];
      if (req.tenantDb && user.id) {
        permRows = await req.tenantDb.userPermission.findMany({
          where: { userId: Number(user.id) },
        });
      }
      const effective = resolveEffectivePermissions(user, permRows);
      if (hasEffectivePermission(effective, role, permissionKey)) return next();

      return res.status(403).json({
        success: false,
        message: `You do not have permission for this action (${permissionKey}).`,
      });
    } catch (error) {
      console.error("[requirePermission] error:", error.message);
      return res.status(500).json({ success: false, message: "Server Error" });
    }
  };
};

module.exports = { requirePermission };
