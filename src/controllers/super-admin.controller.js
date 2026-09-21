const {
  getDashboard, listRestaurants, createRestaurant, restaurantDetails, updateRestaurant,
  changeRestaurantStatus, removeRestaurant, restoreRestaurant,
  createRestaurantOnboarding, uploadDocument, listDocuments, verifyDocument, rejectDocument, deleteDocument,
  createPolicyAgreement, listPolicyAgreements, ALLOWED_DOC_TYPES,
  listUsers, adminCreateUser, adminUpdateUser, adminResetPassword, adminToggleUserStatus, adminDeleteUser, adminChangeUserRole,
  listSubscriptions, changeSubscriptionPlan, renewSubscription, cancelSubscription, suspendSubscription, activateSubscription, getSubscriptionHistory, getSubscriptionPayments,
  listPlans, listPlanModules, createPlan, updatePlan, togglePlanActive, duplicatePlan, deletePlan,
  getReports, getSystemSettings, updateSystemSetting, updateSystemSettings, getAuditLogs, listSupportTickets, updateSupportTicket, getNotifications,
} = require("../services/super-admin.service");
const { successResponse, errorResponse } = require("../utils/response");
const { createAuditLog } = require("../services/audit.service");
const { platformPrisma: prismaDb } = require("../config/tenantPrisma");
const {
  getGatewayStatus, getGatewayConfig, saveGatewayConfig, setGatewayEnabled,
  getPaymentMetrics, listAllPayments,
} = require("../services/gateway-admin.service");
const onboardingService = require("../services/onboarding.service");
const { isValidEmail } = require("../utils/email");
const jwt = require("jsonwebtoken");
const {
  getEmailStatus,
  saveEmailConfig,
  verifySmtp,
  sendTestEmail,
  setGeneralEmailEnabled,
  saveEmailProvider,
  getActiveEmailProvider,
} = require("../config/email.config");
const {
  resendEmailLog,
  processEmailQueue,
} = require("../services/email.service");
const { platformPrisma: prisma } = require("../config/tenantPrisma");

// ─── Email settings (SUPER_ADMIN only — route-level authorize enforces this) ──
const getEmailSettings = async (req, res) => {
  try {
    const data = await getEmailStatus();
    return successResponse(res, data, "Email settings fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updateEmailSettings = async (req, res) => {
  try {
    const body = req.body || {};
    // generalNotificationsEnabled alone toggles only the notification switch —
    // email VERIFICATION stays mandatory regardless (separate concern).
    if (body.generalNotificationsEnabled !== undefined && Object.keys(body).length === 1) {
      await setGeneralEmailEnabled(!!body.generalNotificationsEnabled);
      return successResponse(res, await getEmailStatus(), "Email notifications setting updated");
    }
    const saved = await saveEmailConfig(body);
    // Audit the change — never include the SMTP password (masked anyway).
    try {
      await createAuditLog({
        userId: req.user.id,
        module: "SETTINGS",
        action: "UPDATE",
        description: "Email (SMTP) configuration updated by Super Admin",
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      }, prisma);
    } catch (_) { /* non-critical */ }
    return successResponse(res, await getEmailStatus(), "Email settings saved successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const verifyEmailSettings = async (req, res) => {
  try {
    const result = await verifySmtp();
    // Message reflects the ACTIVE transport (backend decides; the frontend
    // stays transport-agnostic).
    const { activeTransportName } = require("../services/email/transport");
    const active = await activeTransportName();
    const label = active === "microsoft-graph" ? "Microsoft Graph" : "SMTP";
    return successResponse(res, { ...result, provider: active }, result.ok ? label + " connection verified" : label + " verification failed");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Active email provider selection (SUPER_ADMIN only) ───
// GET returns the persisted selection; PUT validates + persists it. Allowed
// values: GRAPH | SMTP (case-insensitive). Invalid values fail with 400 —
// never coerced. Secrets are never accepted or returned here.
const getEmailProvider = async (req, res) => {
  try {
    return successResponse(res, { emailProvider: await getActiveEmailProvider() }, "Active email provider fetched");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updateEmailProvider = async (req, res) => {
  try {
    const requested = req.body && req.body.provider;
    const previous = await getActiveEmailProvider();
    const saved = await saveEmailProvider(requested);
    try {
      await createAuditLog({
        userId: req.user.id,
        module: "SETTINGS",
        action: "UPDATE",
        description: `Active email provider changed from ${previous} to ${saved} by Super Admin`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      }, prisma);
    } catch (_) { /* non-critical */ }
    return successResponse(res, await getEmailStatus(), `Active email provider set to ${saved}.`);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 400);
  }
};

const sendTestEmailHandler = async (req, res) => {
  try {
    const to = req.body && req.body.to;
    const result = await sendTestEmail(to);
    if (!result.ok) return errorResponse(res, result.error, 400);
    try {
      await createAuditLog({
        userId: req.user.id,
        module: "SETTINGS",
        action: "CREATE",
        description: "Test email sent to " + to,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      }, prisma);
    } catch (_) { /* non-critical */ }
    // 202 means the transport ACCEPTED the message — say "accepted", never
    // "delivered". The toast identifies the provider actually used.
    const acceptedMsg = result.provider === "microsoft-graph"
      ? "Test email accepted by Microsoft Graph."
      : "Test email sent through SMTP.";
    return successResponse(res, result, acceptedMsg);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Email delivery log (queue visibility) ───
const getEmailLogs = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.to) where.to = { contains: String(req.query.to).toLowerCase() };
    const [rows, total] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, to: true, template: true, subject: true, status: true,
          attempts: true, maxAttempts: true, lastError: true, sentAt: true,
          failedAt: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.emailLog.count({ where }),
    ]);
    return successResponse(res, { logs: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }, "Email logs fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const resendEmailHandler = async (req, res) => {
  try {
    const row = await resendEmailLog(req.params.id);
    return successResponse(res, { id: row.id, status: row.status }, row.status === "SENT" ? "Email resent successfully" : "Resend failed — it will be retried automatically");
  } catch (error) {
    const status = error.statusCode || 500;
    return errorResponse(res, error.message, status);
  }
};

const retryEmailQueueHandler = async (req, res) => {
  try {
    const processed = await processEmailQueue(50);
    return successResponse(res, { processed }, `Processed ${processed} queued email(s)`);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

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
      if (!isValidEmail(cleanEmail)) {
        return errorResponse(res, "Please enter a valid email address.", 400);
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
    // NOTE: the response never contains the password — the user receives it
    // by email only. The message reflects delivery so the SA knows whether to
    // use Resend Credentials in Email Settings.
    const message = data.emailQueued
      ? "Temporary password generated and emailed to the user."
      : "Temporary password generated, but the email could not be queued. Use Resend Credentials in Email Settings.";
    return successResponse(res, data, message);
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
    const data = await listPlans(req.query); // query includes businessMode filter
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

const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

// Multer config for document uploads (max 10MB)
const DOC_UPLOADS_ROOT = path.join(__dirname, "..", "..", "uploads", "documents");
const docStorage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    const fs = require("fs");
    fs.mkdirSync(DOC_UPLOADS_ROOT, { recursive: true });
    cb(null, DOC_UPLOADS_ROOT);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  },
});
const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: function (_req, file, cb) {
    const allowed = [".pdf", ".jpg", ".jpeg", ".png"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.indexOf(ext) === -1) {
      return cb(new Error("Only PDF, JPG, JPEG, and PNG files are allowed"));
    }
    cb(null, true);
  },
});

const onboardingCreateRestaurant = async (req, res) => {
  try {
    const data = await createRestaurantOnboarding(req.body, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Restaurant created via onboarding", 201);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const uploadDocumentHandler = async (req, res) => {
  try {
    if (!req.file) return errorResponse(res, "No file uploaded", 400);
    var documentType = req.body.documentType || req.query.documentType;
    if (!documentType) {
      // Clean up uploaded file
      const fs = require("fs");
      if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return errorResponse(res, "documentType is required", 400);
    }
    var fileReference = "documents/" + req.file.filename;
    var data = await uploadDocument(
      req.params.id,
      {
        documentType: documentType,
        fileReference: fileReference,
        originalFileName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
      },
      req.user.id, req.ip, req.headers["user-agent"]
    );
    return successResponse(res, data, "Document uploaded successfully", 201);
  } catch (error) {
    // Clean up uploaded file on error
    if (req.file) {
      const fs = require("fs");
      if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
    return errorResponse(res, error.message);
  }
};

const getDocumentsHandler = async (req, res) => {
  try {
    var data = await listDocuments(req.params.id);
    return successResponse(res, data, "Documents fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const verifyDocumentHandler = async (req, res) => {
  try {
    var data = await verifyDocument(req.params.id, req.params.documentId, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Document verified successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const rejectDocumentHandler = async (req, res) => {
  try {
    var reason = req.body.reason || req.body.rejectionReason;
    var data = await rejectDocument(req.params.id, req.params.documentId, reason, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Document rejected");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const deleteDocumentHandler = async (req, res) => {
  try {
    var data = await deleteDocument(req.params.id, req.params.documentId);
    return successResponse(res, data, "Document deleted successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const createPolicyAgreementHandler = async (req, res) => {
  try {
    var data = await createPolicyAgreement(req.params.id, req.body, req.user.id, req.ip, req.headers["user-agent"]);
    return successResponse(res, data, "Policy agreement recorded", 201);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getPolicyAgreementsHandler = async (req, res) => {
  try {
    var data = await listPolicyAgreements(req.params.id);
    return successResponse(res, data, "Policy agreements fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Self-serve business applications (review + approval) ───

/** GET /super-admin/business-applications — self-serve applications list. */
const getBusinessApplications = async (req, res) => {
  try {
    const data = await onboardingService.listApplications(req.query);
    return successResponse(res, data, "Business applications fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** GET /super-admin/business-applications/:id — full application detail. */
const getBusinessApplication = async (req, res) => {
  try {
    const data = await onboardingService.applicationDetail(req.params.id);
    const review = await onboardingService.getReviewMode();
    return successResponse(res, { ...data, reviewMode: review.mode }, "Business application fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** GET /super-admin/business-applications/review-mode — current review mode. */
const getReviewModeHandler = async (req, res) => {
  try {
    const data = await onboardingService.getReviewMode();
    return successResponse(res, data, "Document review mode");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** PUT /super-admin/business-applications/review-mode — auto | manual. */
const setReviewModeHandler = async (req, res) => {
  try {
    const mode = req.body && req.body.mode;
    if (mode !== "auto" && mode !== "manual") return errorResponse(res, "mode must be 'auto' or 'manual'", 400);
    const data = await onboardingService.setReviewMode(mode);
    await createAuditLog({
      userId: req.user.id,
      module: "SETTINGS",
      action: "UPDATE",
      description: "Business application review mode set to " + mode,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return successResponse(res, data, "Review mode updated");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** POST /super-admin/business-applications/:id/approve — provision + activate. */
const approveBusinessApplication = async (req, res) => {
  try {
    const data = await onboardingService.approveApplication(
      req.params.id,
      req.user.id,
      { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
    );
    return successResponse(res, data, data.alreadyActive ? "Application is already active" : "Application approved and activated");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** POST /super-admin/business-applications/:id/reject — requires a reason. */
const rejectBusinessApplication = async (req, res) => {
  try {
    const reason = (req.body && (req.body.reason || req.body.rejectionReason)) || "";
    const data = await onboardingService.rejectApplication(
      req.params.id,
      reason,
      req.user.id,
      { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
    );
    return successResponse(res, data, "Application rejected");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

// ─── Manual payment applications (Super Admin) ───────────────────────────────

/** GET /super-admin/manual-applications — list manual payment applications. */
const getManualApplications = async (req, res) => {
  try {
    const data = await onboardingService.listManualApplications(req.query);
    return successResponse(res, data, "Manual payment applications fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** GET /super-admin/manual-applications/:id — get manual payment application detail. */
const getManualApplication = async (req, res) => {
  try {
    const data = await onboardingService.getManualApplicationDetail(req.params.id);
    // paymentQRConfig intentionally omitted — the approval screen must not
    // offer QR generation; payment verification is a manual Super Admin action.
    return successResponse(res, { ...data, paymentQRConfig: null }, "Manual payment application fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** POST /super-admin/manual-applications/:id/mark-payment — mark payment received. */
const markManualPaymentReceived = async (req, res) => {
  try {
    const data = await onboardingService.markPaymentReceived(
      req.params.id,
      req.user.id,
      { ...req.body, _ip: req.ip, _ua: req.headers["user-agent"] }
    );
    return successResponse(res, data, "Payment verified successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** POST /super-admin/manual-applications/:id/approve — approve manual payment application. */
const approveManualApplicationHandler = async (req, res) => {
  try {
    const data = await onboardingService.approveManualApplication(
      req.params.id,
      req.user.id,
      { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
    );
    return successResponse(res, data, data.alreadyActive ? "Application is already active" : "Application approved and activated");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/** POST /super-admin/manual-applications/:id/reject — reject manual payment application. */
const rejectManualApplicationHandler = async (req, res) => {
  try {
    const reason = (req.body && (req.body.reason || req.body.rejectionReason)) || "";
    const data = await onboardingService.rejectManualApplication(
      req.params.id,
      reason,
      req.user.id,
      { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
    );
    return successResponse(res, data, "Application rejected");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /super-admin/manual-applications/:id/qr — REMOVED.
 * The approval workflow must not expose QR generation: payment is verified
 * manually (Mark Payment Received) before approval. generatePaymentQR remains
 * an internal service function but is no longer routed from anywhere.
 */

/** GET /super-admin/restaurants/:id/documents/:documentId/download (authorized). */
const downloadRestaurantDocument = async (req, res) => {
  try {
    const doc = await onboardingService.getOwnedDocument(req.params.id, req.params.documentId);
    const filePath = onboardingService.resolveDocumentFilePath(doc);
    const safeName = String(doc.originalFileName || "document").replace(/[^\w.\- ]+/g, "").slice(0, 100);
    res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName || "document"}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(filePath);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  dashboard, getOwnProfile, updateOwnProfile, getRestaurants, createRestaurant: createRestaurantHandler, onboardingCreateRestaurant, getRestaurant, updateRestaurant: updateRestaurantHandler, updateRestaurantStatus, deleteRestaurant, getRestaurantLoginAs,
  getUsers, createUser: createUserHandler, updateUser: updateUserHandler, resetUserPassword, toggleUserStatus, deleteUser: deleteUserHandler, changeUserRole,
  getSubscriptions, changePlan, renewSubscription: renewSubscriptionHandler, cancelSubscription: cancelSubscriptionHandler, suspendSubscription: suspendSubscriptionHandler, activateSubscription: activateSubscriptionHandler, getSubscriptionHistory: getSubscriptionHistoryHandler, getSubscriptionPayments: getSubscriptionPaymentsHandler,
  getPlans, getPlanModules, createPlan: createPlanHandler, updatePlan: updatePlanHandler, togglePlanActive: togglePlanActiveHandler, duplicatePlan: duplicatePlanHandler, deletePlan: deletePlanHandler,
  getPlatformReports, getPlatformSettings, updatePlatformSetting, updatePlatformSettings, getAuditLogs: getAuditLogsHandler, getSupportTickets, updateSupportTicket: updateSupportTicketHandler, getPlatformNotifications,
  getGatewayStatus: getGatewayStatusHandler, saveGatewayConfig: saveGatewayConfigHandler, testGateway: testGatewayHandler, toggleGateway: toggleGatewayHandler,
  getPaymentMetrics: getPaymentMetricsHandler, listPayments: listPaymentsHandler,
  docUpload, uploadDocument: uploadDocumentHandler, getDocuments: getDocumentsHandler,
  verifyDocument: verifyDocumentHandler, rejectDocument: rejectDocumentHandler, deleteDocument: deleteDocumentHandler,
  createPolicyAgreement: createPolicyAgreementHandler, getPolicyAgreements: getPolicyAgreementsHandler,
  getBusinessApplications, getBusinessApplication, getReviewMode: getReviewModeHandler, setReviewMode: setReviewModeHandler,
  approveBusinessApplication, rejectBusinessApplication, downloadRestaurantDocument,
  // Manual payment flow
  getManualApplications, getManualApplication, markManualPaymentReceived, approveManualApplication: approveManualApplicationHandler, rejectManualApplication: rejectManualApplicationHandler,
  // Email settings + delivery log (SUPER_ADMIN only)
  getEmailSettings, updateEmailSettings, verifyEmailSettings, sendTestEmailHandler, getEmailProvider, updateEmailProvider,
  getEmailLogs, resendEmailHandler, retryEmailQueueHandler,
};