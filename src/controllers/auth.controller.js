const { platformPrisma: prisma } = require("../config/tenantPrisma");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const asyncHandler = require("../utils/asyncHandler");
const { getRestaurantSubscription } = require("../utils/subscription");
const { createAuditLog } = require("../services/audit.service");
const { normalizeEmail, emailRequiredError } = require("../utils/email");
const { buildOnboardingPayload, MANUAL_ONBOARDING_STAGES, MANUAL_STATUS_MESSAGES } = require("../services/onboarding.service");
const { SELF_SERVE_IN_PROGRESS } = require("../config/onboarding.config");

// Manual payment application statuses that block POS access
const MANUAL_BLOCKING_STATUSES = ["MANUAL_PENDING", "MANUAL_PAYMENT_PENDING", "MANUAL_PAYMENT_RECEIVED", "MANUAL_REJECTED", "EXPIRED"];

/**
 * Login supports both platform users (SUPER_ADMIN/ADMIN in public.User)
 * and tenant staff (MANAGER/CASHIER/KITCHEN/WAITER in tenant schema).
 * When user is not found in public, automatically searches all active tenant schemas.
 */
const login = async (req, res) => {
  try {
    const { email, password, restaurantId } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password are required" });

    // Case-insensitive login identity: "Admin@Example.com" and
    // "admin@example.com" authenticate against the same account.
    // (Passwords stay case-sensitive.)
    const lookupEmail = normalizeEmail(email);

    let user = await prisma.user.findUnique({ where: { email: lookupEmail } });
    let isTenantUser = false;
    let tenantDb = null;
    let resolvedRestaurantId = null;

    if (user) {
      // Found in public — ADMIN or SUPER_ADMIN
      resolvedRestaurantId = user.restaurantId || null;
    } else {
      // Not in public — search tenant schemas for staff login.
      // The PostgreSQL schema itself is the tenant boundary, so an email found
      // in restaurant_2's "User" table belongs to restaurant 2 even if the row's
      // restaurantId column disagrees. Every candidate whose restaurantId column
      // is populated must match the schema it was found in; a mismatched row is
      // data corruption and is never used to log in.
      try {
        const { getTenantClient } = require("../config/tenantPrisma");
        const activeRestaurants = await prisma.restaurant.findMany({
          where: { status: "ACTIVE", deletedAt: null, tenantSchema: { not: null } },
          select: { id: true, tenantSchema: true }
        });
        const candidates = [];
        for (const r of activeRestaurants) {
          try {
            const client = getTenantClient(r.tenantSchema);
            const tenantUser = await client.user.findUnique({ where: { email: lookupEmail } });
            if (!tenantUser) continue;
            // The row must agree with the schema it lives in. A NULL
            // restaurantId is tolerated only for legacy rows (treated as "the
            // schema is authoritative") — it is backfilled by the migration.
            if (tenantUser.restaurantId != null && Number(tenantUser.restaurantId) !== Number(r.id)) {
              console.warn(
                `[Login] Skipping ${lookupEmail}: restaurant_${r.id} row has restaurantId=${tenantUser.restaurantId}`
              );
              continue;
            }
            candidates.push({ client, user: tenantUser, restaurantId: r.id });
          } catch (schemaErr) { /* skip */ }
        }

        if (candidates.length === 1) {
          const hit = candidates[0];
          user = hit.user;
          isTenantUser = true;
          tenantDb = hit.client;
          resolvedRestaurantId = hit.restaurantId;
        } else if (candidates.length > 1) {
          // The same staff email exists in more than one ACTIVE restaurant.
          // Picking the first match could authenticate into the WRONG tenant,
          // so the login is refused and an operator must disambiguate.
          console.warn(
            `[Login] Ambiguous tenant email ${lookupEmail} — accounts found in ${candidates
              .map((c) => "restaurant_" + c.restaurantId)
              .join(", ")}. Login refused.`
          );
          return res.status(401).json({ success: false, message: "Invalid Credentials" });
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

    // ── Self-serve onboarding accounts (resume / status access only) ──
    // Applicants whose restaurant is not yet ACTIVE log in to CONTINUE their
    // registration or to see review/rejection status. The issued token only
    // unlocks /api/onboarding/* (its own auth middleware). Every POS route is
    // still guarded by protect, which refuses non-ACTIVE restaurants — an
    // onboarding account can never reach the POS before activation.
    if (user.role === "ADMIN") {
      let onboardingRestaurant = null;
      if (user.restaurantId) {
        onboardingRestaurant = await prisma.restaurant.findUnique({ where: { id: user.restaurantId } });
        if (!onboardingRestaurant || onboardingRestaurant.deletedAt) {
          return res.status(403).json({ success: false, message: "Your restaurant account is no longer available." });
        }
      }
      const isSelfServeApplicant =
        !user.restaurantId ||
        (onboardingRestaurant.selfServe &&
          onboardingRestaurant.status === "INACTIVE" &&
          SELF_SERVE_IN_PROGRESS.includes(onboardingRestaurant.onboardingStatus));
      if (isSelfServeApplicant) {
        await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
        
        // Check for manual payment application status (blocking statuses)
        if (onboardingRestaurant && MANUAL_BLOCKING_STATUSES.includes(onboardingRestaurant.onboardingStatus)) {
          const status = onboardingRestaurant.onboardingStatus;
          const reason = onboardingRestaurant.onboardingNote || null;
          
          // Handle rejected applications
          if (status === "MANUAL_REJECTED") {
            return res.status(403).json({
              success: false,
              code: "APPLICATION_REJECTED",
              message: "Your application has been rejected." + (reason ? ` Reason: ${reason}` : ""),
              reason,
            });
          }

          // Handle expired applications — the expiry cron sets EXPIRED after
          // the review window lapses (applicationExpiresAt).
          if (status === "EXPIRED") {
            return res.status(403).json({
              success: false,
              code: "APPLICATION_EXPIRED",
              message: "Your application has expired. Please contact support or submit a new application.",
              status,
              restaurantId: user.restaurantId,
            });
          }
          
          // Handle pending/approval-pending applications
          const messageMap = {
            MANUAL_PENDING: "Your application is pending review by Super Admin.",
            MANUAL_PAYMENT_PENDING: "Your application is awaiting payment verification.",
            MANUAL_PAYMENT_RECEIVED: "Payment received. Your application is awaiting Super Admin approval.",
          };
          
          return res.status(200).json({
            success: false,
            code: "APPLICATION_PENDING",
            message: messageMap[status] || "Your application is pending approval.",
            status: status,
            restaurantId: user.restaurantId,
          });
        }
        
        const tokenPayload = { id: user.id, role: user.role };
        if (user.restaurantId) tokenPayload.restaurantId = user.restaurantId;
        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
        let onboarding = null;
        try {
          onboarding = await buildOnboardingPayload(user.id);
        } catch (err) {
          console.warn("[Login] Could not build onboarding payload:", err.message);
        }
        const { password: _, ...safeUser } = user;
        return res.status(200).json({
          success: true,
          token,
          user: safeUser,
          settings: null,
          subscription: null,
          onboarding,
          message: "Welcome back — continue your registration",
        });
      }
    }

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
    res.status(200).json({ success: true, token, user: safeUser, settings, subscription, mustChangePassword: user.mustChangePassword === true });
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
    // Clearing mustChangePassword here is what retires the temporary
    // credential: the old password's hash no longer matches and the
    // first-login gate no longer applies. passwordChangedAt (set below) also
    // invalidates any token issued before the change.
    await db.user.update({ where: { id: userId }, data: { password: hashedPassword, passwordChangedAt: new Date(), mustChangePassword: false } });
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
      // mustChangePassword is included so the frontend can re-route an
      // admin with a temporary credential to the forced password change
      // screen after a browser refresh (session rehydration).
      user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true, role: true, restaurantId: true, mustChangePassword: true } });
    }
    let subscription = null;
    const restaurantId = user && (user.restaurantId || req.user.restaurantId);
    if (restaurantId && user.role !== "SUPER_ADMIN") subscription = await getRestaurantSubscription(restaurantId);
    // Self-serve applicants get their onboarding context so the app can route
    // them back into the registration wizard on refresh (resume-in-progress).
    let onboarding = null;
    if (user && user.role === "ADMIN") {
      try {
        onboarding = await buildOnboardingPayload(user.id);
      } catch (err) {
        console.warn("[Profile] Could not build onboarding payload:", err.message);
      }
    }
    if (onboarding) {
      return res.status(200).json({ success: true, user, subscription, onboarding });
    }
    res.status(200).json({ success: true, user, subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

/**
 * Public self-serve registration (new business user).
 *
 * Security notes (this replaces the removed /auth/register hole):
 *  - The account is ALWAYS role ADMIN with NO restaurantId — the caller can
 *    never choose a role or attach themselves to an existing restaurant.
 *  - Only whitelisted fields are read (name/email/phone/password); everything
 *    else in the body is ignored.
 *  - The account starts in ONBOARDING (REGISTERED) state — no restaurant, no
 *    subscription, no tenant schema, no POS access. Business details come next.
 *  - Password is bcrypt-hashed; duplicate emails are rejected.
 */
const register = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    const emailError = emailRequiredError(cleanEmail);
    if (!name || emailError || !phone || !password) {
      return res.status(400).json({ success: false, message: emailError || "Name, email, phone and password are required." });
    }

    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      return res.status(400).json({ success: false, message: "An account with this email already exists. Please log in." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name: name.trim(), email: cleanEmail, phone: String(phone).trim(), password: hashedPassword, role: "ADMIN", isActive: true },
    });

    try {
      await createAuditLog({
        userId: user.id,
        module: "AUTH",
        action: "CREATE",
        description: "Self-serve account registered: " + cleanEmail,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
    } catch (err) {
      console.warn("[Register] Audit failed (non-critical):", err.message);
    }

    // Prefer authenticating immediately — no second login after registering.
    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    });

    let onboarding = null;
    try {
      onboarding = await buildOnboardingPayload(user.id);
    } catch (err) {
      console.warn("[Register] Could not build onboarding payload:", err.message);
    }
    const { password: _, ...safeUser } = user;
    return res.status(201).json({
      success: true,
      token,
      user: safeUser,
      settings: null,
      subscription: null,
      onboarding,
      message: "Account created — continue with your business details",
    });
  } catch (error) {
    console.error("Register error:", error);
    if (error && error.code === "P2002") {
      return res.status(400).json({ success: false, message: "An account with this email already exists. Please log in." });
    }
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

module.exports = { login, register, changePassword, profile, verifyPassword };
