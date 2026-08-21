const {
  getDashboard, listRestaurants, createRestaurant, restaurantDetails, updateRestaurant,
  changeRestaurantStatus, removeRestaurant, restoreRestaurant,
  listUsers, adminCreateUser, adminUpdateUser, adminResetPassword, adminToggleUserStatus, adminDeleteUser, adminChangeUserRole,
  listSubscriptions, changeSubscriptionPlan, renewSubscription, cancelSubscription, suspendSubscription, activateSubscription, getSubscriptionHistory, getSubscriptionPayments,
  listPlans, listPlanModules, createPlan, updatePlan, togglePlanActive, duplicatePlan, deletePlan,
  getReports, getSystemSettings, updateSystemSetting, updateSystemSettings, getAuditLogs, listSupportTickets, updateSupportTicket, getNotifications,
} = require("../services/super-admin.service");
const { successResponse, errorResponse } = require("../utils/response");
const { createAuditLog } = require("../services/audit.service");
const prismaDb = require("../config/prisma");
const {
  getGatewayStatus, getGatewayConfig, saveGatewayConfig, setGatewayEnabled,
  getPaymentMetrics, listAllPayments,
} = require("../services/gateway-admin.service");
const jwt = require("jsonwebtoken");

const dashboard = async (req, res) => {
  try {
    const data = await getDashboard();
    return successResponse(res, data, "Super Admin Dashboard");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const PROFILE_SELECT = { id: true, name: true, email: true, phone: true, avatar: true, role: true, isActive: true, lastLogin: true, createdAt: true };

/** GET /super-admin/profile — the Super Admin's own profile (SA-only route). */
const getOwnProfile = async (req, res) => {
  try {
    const user = await prismaDb.user.findUnique({ where: { id: req.user.id }, select: PROFILE_SELECT });
    if (!user) return errorResponse(res, "User not found", 404);
    return successResponse(res, user, "Profile fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** PUT /super-admin/profile — update the SA's own name/email/phone/avatar. */
const updateOwnProfile = async (req, res) => {
  try {
    const { name, email, phone, avatar } = req.body || {};
    const cleanName = typeof name === "string" ? name.trim() : undefined;
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : undefined;
    // "Not provided" (field absent) vs "explicitly cleared" (null/"") are
    // different: absent means nothing to update, null/"" clears the phone.
    const PHONE_UNSET = Symbol("phone-unset");
    const cleanPhone = phone === undefined ? PHONE_UNSET : (phone === null || phone === "" ? null : String(phone).trim());

    if (cleanName !== undefined && cleanName.length < 2) {
      return errorResponse(res, "Name must be at least 2 characters", 400);
    }
    if (cleanEmail !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return errorResponse(res, "A valid email address is required", 400);
      }
      const dup = await prismaDb.user.findUnique({ where: { email: cleanEmail } });
      if (dup && dup.id !== req.user.id) {
        return errorResponse(res, "Email already exists", 400);
      }
    }

    const data = {};
    if (cleanName !== undefined) data.name = cleanName;
    if (cleanEmail !== undefined) data.email = cleanEmail;
    if (cleanPhone !== PHONE_UNSET) data.phone = cleanPhone;
    if (avatar !== undefined) data.avatar = avatar || null;
    if (Object.keys(data).length === 0) {
      return errorResponse(res, "Nothing to update", 400);
    }

    const user = await prismaDb.user.update({ where: { id: req.user.id }, data, select: PROFILE_SELECT });
    await createAuditLog({
      userId: req.user.id,
      module: "USER",
      action: "UPDATE",
      description: "Super Admin updated own profile",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return successResponse(res, user, "Profile updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getRestaurants = async (req, res) => {
  try {
    const data = await listRestaurants(req.query);
    return successResponse(res, data, "Restaurants fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const createRestaurantHandler = async (req, res) => {
  try {
    const data = await createRestaurant(req.body, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Restaurant created successfully", 201);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getRestaurant = async (req, res) => {
  try {
    const data = await restaurantDetails(req.params.id);
    return successResponse(res, data, "Restaurant details fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updateRestaurantHandler = async (req, res) => {
  try {
    const data = await updateRestaurant(req.params.id, req.body);
    return successResponse(res, data, "Restaurant updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updateRestaurantStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const data = await changeRestaurantStatus(req.params.id, status);
    return successResponse(res, data, "Restaurant status updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const deleteRestaurant = async (req, res) => {
  try {
    const data = await removeRestaurant(req.params.id);
    return successResponse(res, data, "Restaurant deleted successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getRestaurantLoginAs = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurant = await prismaDb.restaurant.findUnique({ where: { id: Number(id) } });
    if (!restaurant) return errorResponse(res, "Restaurant not found", 404);
    const admin = await prismaDb.user.findFirst({
      where: { restaurantId: Number(id), role: "ADMIN", isActive: true, deletedAt: null },
    });
    if (!admin) return errorResponse(res, "No active admin found for this restaurant", 404);
    const token = jwt.sign(
      { id: admin.id, role: admin.role, restaurantId: admin.restaurantId },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );
    return successResponse(res, { token, user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, restaurantId: admin.restaurantId } }, "Login-as token generated");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getUsers = async (req, res) => {
  try {
    const data = await listUsers(req.query);
    return successResponse(res, data, "Users fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const createUserHandler = async (req, res) => {
  try {
    const data = await adminCreateUser(req.body, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "User created successfully", 201);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updateUserHandler = async (req, res) => {
  try {
    const data = await adminUpdateUser(req.params.id, req.body);
    return successResponse(res, data, "User updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const resetUserPassword = async (req, res) => {
  try {
    const data = await adminResetPassword(req.params.id);
    return successResponse(res, data, "Password reset successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const toggleUserStatus = async (req, res) => {
  try {
    const data = await adminToggleUserStatus(req.params.id);
    return successResponse(res, data, "User status toggled successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const deleteUserHandler = async (req, res) => {
  try {
    const data = await adminDeleteUser(req.params.id);
    return successResponse(res, data, "User deleted successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const changeUserRole = async (req, res) => {
  try {
    const data = await adminChangeUserRole(req.params.id, req.body.role);
    return successResponse(res, data, "User role changed successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getSubscriptions = async (req, res) => {
  try {
    const data = await listSubscriptions(req.query);
    return successResponse(res, data, "Subscriptions fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const changePlan = async (req, res) => {
  try {
    const data = await changeSubscriptionPlan(req.params.restaurantId, req.body, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Subscription plan changed successfully");
  } catch (error) {
    // Business-validation failures (inactive plan, missing planId, invalid
    // cycle) carry statusCode 400 — forward it instead of defaulting to 500.
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const activateSubscriptionHandler = async (req, res) => {
  try {
    const data = await activateSubscription(req.params.restaurantId, req.user.id, req.ip, req.headers["user-agent"], req.body.notes);
    return successResponse(res, data, "Subscription activated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getSubscriptionHistoryHandler = async (req, res) => {
  try {
    const data = await getSubscriptionHistory(req.params.restaurantId);
    return successResponse(res, data, "Subscription history fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** GET /super-admin/subscriptions/:restaurantId/payments — real gateway payments */
const getSubscriptionPaymentsHandler = async (req, res) => {
  try {
    const data = await getSubscriptionPayments(req.params.restaurantId);
    return successResponse(res, data, "Subscription payments fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** GET /super-admin/payments/gateway — masked gateway status (never secrets) */
const getGatewayStatusHandler = async (req, res) => {
  try {
    const data = await getGatewayStatus();
    return successResponse(res, data, "Payment gateway status");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** PUT /super-admin/payments/gateway — save config (secrets encrypted at rest) */
const saveGatewayConfigHandler = async (req, res) => {
  try {
    const { environment, enabled, keyId, keySecret, webhookSecret } = req.body || {};
    if (!keyId) return errorResponse(res, "Key ID is required", 400);
    if (environment !== "LIVE" && environment !== "TEST") return errorResponse(res, "Environment must be TEST or LIVE", 400);

    const prev = await getGatewayStatus();
    const saved = await saveGatewayConfig({
      environment,
      enabled: enabled !== false,
      keyId,
      keySecret,
      webhookSecret,
    });

    const envChanged = prev.environment && prev.environment !== environment;
    await createAuditLog({
      userId: req.user.id,
      module: "PAYMENT",
      action: "UPDATE",
      description: envChanged
        ? `Razorpay configuration updated (environment ${prev.environment} → ${environment})`
        : "Razorpay configuration updated",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return successResponse(res, { environment: saved.environment, enabled: saved.enabled }, "Payment gateway configuration saved");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** POST /super-admin/payments/gateway/test — real Razorpay API call, safe error */
const testGatewayHandler = async (req, res) => {
  try {
    const cfg = await getGatewayConfig();
    if (!cfg.keyId || !cfg.keySecret) {
      return errorResponse(res, "Razorpay keys are not configured. Save the configuration first.", 400);
    }

    const Razorpay = require("razorpay");
    const rzp = new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret });
    // Lightweight real API call — verifies the credentials actually work.
    await rzp.orders.all({ count: 1 });

    await saveGatewayConfig({
      environment: cfg.environment,
      enabled: cfg.enabled,
      keyId: cfg.keyId,
      keySecret: cfg.keySecret,
      webhookSecret: cfg.webhookSecret,
      checkedAt: new Date().toISOString(),
    });
    await createAuditLog({
      userId: req.user.id,
      module: "PAYMENT",
      action: "VIEW",
      description: "Razorpay test connection successful",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return successResponse(
      res,
      { environment: cfg.environment, connected: true, checkedAt: new Date().toISOString() },
      "Razorpay connection successful"
    );
  } catch (error) {
    // Human-readable reason only — never the secret, never a stack trace.
    const reason = /401|Bad Request|invalid key|Invalid Key/i.test(error?.message)
      ? "Invalid Razorpay credentials. Check the Key ID and Key Secret."
      : error?.response?.data?.error?.description || (error?.message ? `Razorpay could not be reached (${error.message.slice(0, 80)})` : "Unable to connect to Razorpay");
    return errorResponse(res, reason, 502);
  }
};

/** POST /super-admin/payments/gateway/toggle — enable/disable online payments */
const toggleGatewayHandler = async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    await setGatewayEnabled(enabled);
    await createAuditLog({
      userId: req.user.id,
      module: "PAYMENT",
      action: enabled ? "CREATE" : "CANCEL",
      description: enabled ? "Online payments enabled" : "Online payments disabled",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    const status = await getGatewayStatus();
    return successResponse(res, { enabled, status }, enabled ? "Online payments enabled" : "Online payments disabled");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** GET /super-admin/payments/metrics — platform payment/subscription metrics */
const getPaymentMetricsHandler = async (req, res) => {
  try {
    const { activeSubscriptions, expiringSubscriptions, monthlyRevenue, yearlyRevenue, paymentStats, planRevenue } = await getPaymentMetrics();
    return successResponse(res, {
      activeSubscriptions,
      expiringSubscriptions,
      monthlyRevenue,
      yearlyRevenue,
      paymentStats,
      planRevenue,
    }, "Payment metrics");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** GET /super-admin/payments — filtered platform payment history */
const listPaymentsHandler = async (req, res) => {
  try {
    const data = await listAllPayments(req.query);
    return successResponse(res, data, "Payment history");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Plans (DB-driven) ───

const getPlans = async (req, res) => {
  try {
    const data = await listPlans(req.query);
    return successResponse(res, data, "Plans fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getPlanModules = async (req, res) => {
  try {
    const data = await listPlanModules(req.query);
    return successResponse(res, data, "Plan modules fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const createPlanHandler = async (req, res) => {
  try {
    const data = await createPlan(req.body);
    return successResponse(res, data, "Plan created successfully", 201);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updatePlanHandler = async (req, res) => {
  try {
    const data = await updatePlan(req.params.id, req.body);
    return successResponse(res, data, "Plan updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const togglePlanActiveHandler = async (req, res) => {
  try {
    const data = await togglePlanActive(req.params.id);
    return successResponse(res, data, "Plan status toggled successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const duplicatePlanHandler = async (req, res) => {
  try {
    const data = await duplicatePlan(req.params.id);
    return successResponse(res, data, "Plan duplicated successfully", 201);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const deletePlanHandler = async (req, res) => {
  try {
    const data = await deletePlan(req.params.id);
    return successResponse(res, data, "Plan deleted successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const renewSubscriptionHandler = async (req, res) => {
  try {
    const data = await renewSubscription(req.params.restaurantId, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Subscription renewed successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const cancelSubscriptionHandler = async (req, res) => {
  try {
    const data = await cancelSubscription(req.params.restaurantId, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Subscription cancelled successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const suspendSubscriptionHandler = async (req, res) => {
  try {
    const data = await suspendSubscription(req.params.restaurantId, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Subscription suspended successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getPlatformReports = async (req, res) => {
  try {
    const data = await getReports(req.query);
    return successResponse(res, data, "Reports fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getPlatformSettings = async (req, res) => {
  try {
    const data = await getSystemSettings();
    return successResponse(res, data, "Settings fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updatePlatformSetting = async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return errorResponse(res, "Key is required");
    const data = await updateSystemSetting(key, value);
    return successResponse(res, data, "Setting updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/**
 * Bulk save for the System Settings screen (ONE atomic operation).
 * Accepts either the new bulk shape `{ settings: { key: value, ... } }` or
 * the legacy single-key shape `{ key, value }` (kept for backward compat).
 */
const updatePlatformSettings = async (req, res) => {
  try {
    const body = req.body || {};
    let bulk = null;
    if (body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)) {
      bulk = body.settings;
    } else if (body.key !== undefined) {
      bulk = { [body.key]: body.value };
    } else if (typeof body === "object" && Object.keys(body).length > 0) {
      bulk = body; // flat map of key → value
    }
    if (!bulk || Object.keys(bulk).length === 0) {
      return errorResponse(res, "No settings provided", 400);
    }
    const data = await updateSystemSettings(bulk);
    // One audit entry for the whole save — never per-field, never with secret values.
    await createAuditLog({
      userId: req.user.id,
      module: "SETTINGS",
      action: "UPDATE",
      description: "Super Admin updated " + Object.keys(bulk).length + " system setting(s)",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return successResponse(res, data, "Settings saved successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const getAuditLogsHandler = async (req, res) => {
  try {
    const data = await getAuditLogs(req.query);
    return successResponse(res, data, "Audit logs fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getSupportTickets = async (req, res) => {
  try {
    const data = await listSupportTickets(req.query);
    return successResponse(res, data, "Support tickets fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updateSupportTicketHandler = async (req, res) => {
  try {
    const data = await updateSupportTicket(req.params.id, req.body);
    return successResponse(res, data, "Support ticket updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getPlatformNotifications = async (req, res) => {
  try {
    const data = await getNotifications(req.query);
    return successResponse(res, data, "Notifications fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

module.exports = {
  dashboard, getOwnProfile, updateOwnProfile, getRestaurants, createRestaurant: createRestaurantHandler, getRestaurant, updateRestaurant: updateRestaurantHandler, updateRestaurantStatus, deleteRestaurant, getRestaurantLoginAs,
  getUsers, createUser: createUserHandler, updateUser: updateUserHandler, resetUserPassword, toggleUserStatus, deleteUser: deleteUserHandler, changeUserRole,
  getSubscriptions, changePlan, renewSubscription: renewSubscriptionHandler, cancelSubscription: cancelSubscriptionHandler, suspendSubscription: suspendSubscriptionHandler, activateSubscription: activateSubscriptionHandler, getSubscriptionHistory: getSubscriptionHistoryHandler, getSubscriptionPayments: getSubscriptionPaymentsHandler,
  getPlans, getPlanModules, createPlan: createPlanHandler, updatePlan: updatePlanHandler, togglePlanActive: togglePlanActiveHandler, duplicatePlan: duplicatePlanHandler, deletePlan: deletePlanHandler,
  getPlatformReports, getPlatformSettings, updatePlatformSetting, updatePlatformSettings, getAuditLogs: getAuditLogsHandler, getSupportTickets, updateSupportTicket: updateSupportTicketHandler, getPlatformNotifications,
  getGatewayStatus: getGatewayStatusHandler, saveGatewayConfig: saveGatewayConfigHandler, testGateway: testGatewayHandler, toggleGateway: toggleGatewayHandler,
  getPaymentMetrics: getPaymentMetricsHandler, listPayments: listPaymentsHandler,
};