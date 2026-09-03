const { platformPrisma: prisma } = require("../config/tenantPrisma");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const asyncHandler = require("../utils/asyncHandler");
const { getRestaurantSubscription } = require("../utils/subscription");

/**
 * Login supports both platform users (SUPER_ADMIN/ADMIN in public.User)
 * and tenant staff (MANAGER/CASHIER/KITCHEN/WAITER in tenant schema).
 * When user is not found in public, automatically searches all active tenant schemas.
 */
const login = async (req, res) => {
  try {
    const { email, password, restaurantId } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password are required" });

    let user = await prisma.user.findUnique({ where: { email } });
    let isTenantUser = false;
    let tenantDb = null;
    let resolvedRestaurantId = null;

    if (user) {
      // Found in public — ADMIN or SUPER_ADMIN
      resolvedRestaurantId = user.restaurantId || null;
    } else {
      // Not in public — search tenant schemas for staff login
      try {
        const { getTenantClient } = require("../config/tenantPrisma");
        const activeRestaurants = await prisma.restaurant.findMany({
          where: { status: "ACTIVE", deletedAt: null, tenantSchema: { not: null } },
          select: { id: true, tenantSchema: true }
        });
        for (const r of activeRestaurants) {
          try {
            const client = getTenantClient(r.tenantSchema);
            const tenantUser = await client.user.findUnique({ where: { email } });
            if (tenantUser) {
              user = tenantUser;
              isTenantUser = true;
              tenantDb = client;
              resolvedRestaurantId = r.id;
              break;
            }
          } catch (schemaErr) { /* skip */ }
        }
      } catch (err) {
        console.warn("[Login] Tenant search failed:", err.message);
      }
    }

    if (!user) return res.status(401).json({ success: false, message: "Invalid Credentials" });
    if (user.deletedAt) return res.status(401).json({ success: false, message: "Invalid Credentials" });
    if (!user.isActive) return res.status(403).json({ success: false, message: "Your account has been disabled." });
    if (!user.password) return res.status(401).json({ success: false, message: "Invalid Credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ success: false, message: "Invalid Credentials" });

    // Subscription gate
    let subscription = null;
    if (resolvedRestaurantId && user.role !== "SUPER_ADMIN") {
      const restaurant = await prisma.restaurant.findUnique({ where: { id: resolvedRestaurantId } });
      if (!restaurant || restaurant.deletedAt) return res.status(403).json({ success: false, message: "Your restaurant account is no longer available." });
      if (restaurant.status !== "ACTIVE") return res.status(403).json({ success: false, message: "Your restaurant account is " + restaurant.status.toLowerCase() + ". Contact your Super Admin." });
      subscription = await getRestaurantSubscription(resolvedRestaurantId);
      if (!subscription) return res.status(403).json({ success: false, message: "No subscription found for your restaurant. Contact your Super Admin." });
      if (subscription.status === "CANCELLED" || subscription.status === "SUSPENDED") {
        const reason = subscription.status === "CANCELLED" ? "Your subscription has been cancelled. Contact support to renew." : "Your subscription is suspended. Contact support to reactivate.";
        return res.status(403).json({ success: false, message: reason });
      }
    }

    // Update lastLogin
    if (isTenantUser && tenantDb) {
      await tenantDb.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
    } else {
      await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
    }

    // JWT
    const tokenPayload = { id: user.id, role: user.role };
    if (user.role !== "SUPER_ADMIN" && resolvedRestaurantId) tokenPayload.restaurantId = resolvedRestaurantId;
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });

    // Settings
    let settings = null;
    if (resolvedRestaurantId && user.role !== "SUPER_ADMIN") {
      try {
        const { getTenantClient } = require("../config/tenantPrisma");
        const tenantClient = getTenantClient(require("../utils/tenantSchema").generateSchemaName(resolvedRestaurantId));
        settings = await tenantClient.restaurantSetting.findUnique({
          where: { restaurantId: resolvedRestaurantId },
          select: { restaurantName: true, currency: true, timezone: true, taxPercentage: true, serviceCharge: true, roundOffEnabled: true, billPrefix: true, invoicePrefix: true, kotPrefix: true, enableKitchenDisplay: true, enableKotStatusTracking: true, logo: true }
        });
      } catch (err) { console.warn("[Login] Could not resolve tenant for settings:", err.message); }
    }

    const { password: _, ...safeUser } = user;
    res.status(200).json({ success: true, token, user: safeUser, settings, subscription });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

const verifyPassword = async (req, res) => {
  try {
    const { password } = req.body;
    const userId = req.user.id;
    if (!password || password.length < 1) return res.status(400).json({ success: false, message: "Password is required" });
    let user;
    const isTenantStaff = req.user.role !== "SUPER_ADMIN" && req.user.role !== "ADMIN" && req.user.restaurantId;
    if (isTenantStaff && req.tenantDb) {
      user = await req.tenantDb.user.findUnique({ where: { id: userId }, select: { id: true, password: true } });
    } else {
      user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, password: true } });
    }
    if (!user) return res.status(400).json({ success: false, message: "User not found" });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: "Invalid password" });
    return res.status(200).json({ success: true, message: "Password verified successfully" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: "Current password and new password are required." });
    if (newPassword.length < 8) return res.status(400).json({ success: false, message: "New password must be at least 8 characters long." });
    if (currentPassword === newPassword) return res.status(400).json({ success: false, message: "New password cannot be the same as the current password." });
    const isTenantStaff = req.user.role !== "SUPER_ADMIN" && req.user.role !== "ADMIN" && req.user.restaurantId;
    let db = (isTenantStaff && req.tenantDb) ? req.tenantDb : prisma;
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, password: true } });
    if (!user) return res.status(400).json({ success: false, message: "User not found" });
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: "Current password is incorrect." });
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.user.update({ where: { id: userId }, data: { password: hashedPassword, passwordChangedAt: new Date() } });
    return res.status(200).json({ success: true, message: "Password changed successfully. Please sign in again." });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

const profile = async (req, res) => {
  try {
    let user;
    const isTenantStaff = req.user.role !== "SUPER_ADMIN" && req.user.role !== "ADMIN" && req.user.restaurantId;
    if (isTenantStaff && req.tenantDb) {
      user = await req.tenantDb.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true, role: true } });
    } else {
      user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true, role: true, restaurantId: true } });
    }
    let subscription = null;
    const restaurantId = user && (user.restaurantId || req.user.restaurantId);
    if (restaurantId && user.role !== "SUPER_ADMIN") subscription = await getRestaurantSubscription(restaurantId);
    res.status(200).json({ success: true, user, subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

module.exports = { login, changePassword, profile, verifyPassword };
