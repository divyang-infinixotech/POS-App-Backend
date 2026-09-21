const { platformPrisma } = require("../config/tenantPrisma");
const {
  ORDER_TYPE_TAKEAWAY_KEY,
  ORDER_TYPE_DINE_IN_KEY,
  assignedOrderTypesFromRows,
} = require("../utils/orderAccess");
const bcrypt = require("bcryptjs");
const { createNotification } = require("../services/notification.service");
const { normalizeEmail, emailRequiredError, isValidEmail } = require("../utils/email");
const { getVisibleStaffRoles } = require("../utils/businessCapabilities");
const prisma = require("../config/prisma");

/**
 * §6: resolve the capability-derived role set THIS tenant may assign to staff
 * (Staff Roster Add/Edit). BusinessType comes from the platform Restaurant row
 * — never the client. Falls back to the full tenant-staff set only if the
 * platform lookup fails, so an infra hiccup can never lock staff management.
 */
async function resolveVisibleStaffRoles(restaurantId) {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { businessType: true },
    });
    return getVisibleStaffRoles(restaurant ? restaurant.businessType : null);
  } catch {
    return [...TENANT_STAFF_ROLES];
  }
}

function isTenantStaff(req) {
  return req.user.role !== "SUPER_ADMIN" && req.user.role !== "ADMIN" && req.user.restaurantId;
}

/**
 * Roles that may live inside a TENANT "User" table.
 * Platform accounts (SUPER_ADMIN/ADMIN) belong in public.User only — writing
 * them into a tenant schema would produce a user that can never authenticate.
 */
const TENANT_STAFF_ROLES = ["MANAGER", "CASHIER", "KITCHEN", "WAITER"];

/**
 * The restaurant a user write targets when `db` is a tenant-schema client.
 * - Tenant staff / ADMIN are always bound to their own authenticated restaurant.
 * - SUPER_ADMIN explicitly selects the restaurant (via body/query) — the id is
 *   only used to scope the write, it can never widen the caller's powers.
 * Returns null when the target is the public platform store.
 */
function resolveTenantTargetRestaurantId(req, db) {
  if (!db || db === platformPrisma) return null;
  if (req.user.role === "SUPER_ADMIN") {
    const id = Number(req.body.restaurantId || req.query.restaurantId);
    return Number.isInteger(id) && id > 0 ? id : null;
  }
  return req.user.restaurantId || null;
}

async function resolveUserDb(req) {
  if (req.user.role === "SUPER_ADMIN" && req.body.restaurantId) {
    const { getTenantClientByRestaurantId } = require("../config/tenantPrisma");
    const { client } = await getTenantClientByRestaurantId(Number(req.body.restaurantId));
    return client;
  }
  if (req.user.role === "SUPER_ADMIN" && req.query.restaurantId) {
    const { getTenantClientByRestaurantId } = require("../config/tenantPrisma");
    const { client } = await getTenantClientByRestaurantId(Number(req.query.restaurantId));
    return client;
  }
  if (isTenantStaff(req) && req.tenantDb) return req.tenantDb;
  if (req.user.role === "ADMIN" && req.tenantDb) return req.tenantDb;
  return platformPrisma;
}

const getPagination = require("../utils/pagination");
const { successResponse, errorResponse } = require("../utils/response");

const createUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const db = await resolveUserDb(req);

    // Tenant user writes are always bound to the authenticated restaurant
    // (or, for SUPER_ADMIN, the restaurant selected via restaurantId, which
    // getTenantClientByRestaurantId already validated). The client can never
    // pick a tenant for restaurant-staff/ADMIN callers.
    const restaurantId = resolveTenantTargetRestaurantId(req, db);
    const targetingTenant = restaurantId !== null && db !== platformPrisma;

    if (targetingTenant) {
      if (!TENANT_STAFF_ROLES.includes(role)) {
        return res.status(400).json({
          success: false,
          message: "Only MANAGER, CASHIER, KITCHEN or WAITER staff can be created for a restaurant.",
        });
      }
      // §6: role must ALSO be supported by THIS tenant's business capabilities
      // (e.g. KITCHEN is never creatable in a supermarket). Resolved from the
      // platform Restaurant row — the client is never trusted.
      const allowedRoles = await resolveVisibleStaffRoles(restaurantId);
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          message: `Role ${role} is not available for this business type.`,
        });
      }
    }

    // Case-insensitive identity: normalize before the uniqueness check AND
    // before the write, so "CASHIER@RESTAURANT.COM" cannot become a second
    // account next to "cashier@restaurant.com" in the same schema.
    const cleanEmail = normalizeEmail(email);
    const emailError = emailRequiredError(cleanEmail);
    if (emailError) return res.status(400).json({ success: false, message: emailError });
    const exists = await db.user.findUnique({ where: { email: cleanEmail } });
    if (exists) return res.status(400).json({ success: false, message: "This email address is already registered." });
    const hashedPassword = await bcrypt.hash(password, 10);
    const data = { name, email: cleanEmail, password: hashedPassword, role };
    // restaurantId is REQUIRED on tenant User rows (auth resolves the tenant
    // context from it). Never leave it NULL for newly created staff.
    if (targetingTenant) data.restaurantId = restaurantId;
    const user = await db.user.create({ data });
    try {
      await createNotification(db, { userId: req.user.id, title: "New User Created", message: user.name + " (" + user.role + ") has been created.", type: "SUCCESS" });
    } catch (notifErr) { console.error("[User] Notification failed (non-critical):", notifErr.message); }
    res.status(201).json({ success: true, user });
  } catch (error) {
    console.error("Create user error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Waiter directory for the Take Order wizard.
 * Returns ONLY the ACTIVE WAITER-role staff of the caller's own restaurant
 * (tenant-scoped via resolveUserDb). Unlike the full staff-management list
 * (GET /users → ADMIN/MANAGER), cashiers and waiters can use this endpoint
 * to pick a service staff member while placing an order.
 */
const getWaiters = async (req, res) => {
  try {
    const db = await resolveUserDb(req);
    const waiters = await db.user.findMany({
      where: { role: "WAITER", isActive: true, deletedAt: null },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    });
    return successResponse(res, { users: waiters }, "Waiters fetched successfully");
  } catch (error) {
    console.error("[User] getWaiters error:", error.message);
    return errorResponse(res, error.message);
  }
};

const getUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const search = req.query.search || "";
    const allowedSortFields = ['createdAt', 'name', 'email', 'role', 'isActive', 'lastLogin'];
    const sort = allowedSortFields.includes(req.query.sort) ? req.query.sort : 'createdAt';
    const skip = (page - 1) * limit;
    const db = await resolveUserDb(req);
    const where = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }
    const users = await db.user.findMany({ where, orderBy: { [sort]: "desc" }, skip, take: limit, select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, lastLogin: true, createdAt: true } });
    const total = await db.user.count({ where });
    return successResponse(res, { users, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }, "Users fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getUserById = async (req, res) => {
  try {
    const db = await resolveUserDb(req);
    const user = await db.user.findUnique({ where: { id: Number(req.params.id) }, select: { id: true, name: true, email: true, phone: true, role: true, avatar: true, isActive: true, lastLogin: true, createdAt: true } });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, user });
  } catch (error) { return errorResponse(res, error.message); }
};

const updateUser = async (req, res) => {
  try {
    const { name, email, phone, role, avatar } = req.body;
    const db = await resolveUserDb(req);
    const existingUser = await db.user.findFirst({ where: { id: Number(req.params.id) }, select: { id: true, role: true } });
    if (!existingUser) return res.status(404).json({ success: false, message: "User not found" });

    const restaurantId = resolveTenantTargetRestaurantId(req, db);
    const targetingTenant = restaurantId !== null && db !== platformPrisma;
    // A role change on a tenant staff user may only select another tenant-staff
    // role — platform roles (ADMIN/SUPER_ADMIN) live in public.User and would
    // lock the account out if written into the tenant schema.
    if (targetingTenant && role && !TENANT_STAFF_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Only MANAGER, CASHIER, KITCHEN or WAITER roles can be assigned to restaurant staff.",
      });
    }
    // §6: a NEW role must be supported by THIS tenant's business capabilities.
    // §4: legacy users keep their existing role — submitting the SAME
    // unsupported role back (an edit that does not change the role, which the
    // roster form always sends) is allowed, so legacy accounts stay editable
    // without ever re-introducing the role for other/new users.
    if (targetingTenant && role && role !== existingUser.role) {
      const allowedRoles = await resolveVisibleStaffRoles(restaurantId);
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          message: `Role ${role} is not available for this business type.`,
        });
      }
    }

    const data = { name, phone, role, avatar };
    if (email !== undefined) {
      const cleanEmail = normalizeEmail(email);
      if (!isValidEmail(cleanEmail)) return errorResponse(res, "Please enter a valid email address.", 400);
      const dupe = await db.user.findFirst({ where: { email: cleanEmail, id: { not: Number(req.params.id) } } });
      if (dupe) return errorResponse(res, "This email address is already registered.", 400);
      data.email = cleanEmail;
    }
    if (targetingTenant) data.restaurantId = restaurantId;
    const user = await db.user.update({ where: { id: Number(req.params.id) }, data });
    res.status(200).json({ success: true, message: "User updated successfully", user });
  } catch (error) { console.error(error); return errorResponse(res, error.message); }
};

// ─── Per-staff permission APIs (tenant-scoped) ──────────────────────────────
/**
 * GET /api/users/me/permissions — the CURRENT authenticated user's effective
 * permissions (used after login for sidebar/route gating).
 *
 * Dedicated handler instead of reusing getUserPermissions: the literal route
 * "/me/permissions" never populates req.params.id, so the shared controller
 * previously computed Number(undefined) = NaN → Prisma "Argument `id` is
 * missing" (500). Binding req.params.id = "me" here gives the shared logic an
 * unambiguous target — no URL sniffing, no fragile detection.
 *
 * Authorization: a user may always read their OWN permissions. Tenant isolation
 * is preserved — resolveUserDb pins the schema, and the identity guard inside
 * getUserPermissions still applies.
 */
const getMyPermissions = async (req, res) => {
  req.params.id = "me";
  return getUserPermissions(req, res);
};

/**
 * GET /api/users/:id/permissions
 * Returns the staff member's dietary access + effective permission state:
 * role defaults merged with their explicit UserPermission overrides, plus
 * the full catalog so the UI can render every toggle.
 */
const getUserPermissions = async (req, res) => {
  try {
    // ADMIN/SUPER_ADMIN always resolve to full access (Part 21) — they are
    // never restricted by UserPermission rows, and their account lives in
    // public.User, not a tenant schema.
    const callerRole = String(req.user.role || "").toUpperCase();
    if (callerRole === "ADMIN" || callerRole === "SUPER_ADMIN") {
      const { ALL_PERMISSION_KEYS, PERMISSION_LABELS, ACTION_GROUPS, DIETARY_ACCESS } = require("../utils/permissions");
      return res.json({
        success: true,
        data: {
          user: { id: req.user.id, name: req.user.name, role: req.user.role },
          dietaryAccess: "VEG_AND_NON_VEG",
          assignedOrderTypes: null, // ADMIN unrestricted — consistent response shape
          dietaryOptions: Object.values(DIETARY_ACCESS),
          fullAccess: true,
          effectivePermissions: ALL_PERMISSION_KEYS,
          roleDefaults: ALL_PERMISSION_KEYS,
          overrides: [],
          catalog: ALL_PERMISSION_KEYS.map((key) => ({ key, label: PERMISSION_LABELS[key] || key })),
          actionGroups: ACTION_GROUPS,
        },
      });
    }

    // "me" mode: the authenticated user loads their OWN effective permissions
    // (used by the frontend after login for sidebar/route gating). Otherwise
    // an ADMIN/MANAGER inspects an arbitrary staff member by id.
    //
    // The literal route GET /users/me/permissions never populates
    // req.params.id, so it is handled by the dedicated getMyPermissions
    // wrapper, which binds req.params.id = "me" up-front. This controller
    // therefore only ever sees "me" or a numeric id — no URL sniffing.
    const isMe = req.params.id === "me";
    const db = await resolveUserDb(req);
    const userId = isMe ? Number(req.user.id) : Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // Identity guard for "me": a tenant user may only read their own row, and
    // always from their own tenant schema (resolveUserDb already guarantees the
    // schema — this blocks cross-tenant/cross-user probing by id).
    if (isMe && !isTenantStaff(req) && String(user.role).toUpperCase() !== String(req.user.role).toUpperCase()) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const permRows = await db.userPermission.findMany({ where: { userId } });
    const {
      ALL_PERMISSION_KEYS,
      PERMISSION_LABELS,
      ACTION_GROUPS,
      resolveEffectivePermissions,
      roleDefaultsFor,
      DIETARY_ACCESS,
    } = require("../utils/permissions");

    // Restaurant-level dietary mode (Part 14): the ceiling for staff Food
    // Access. Loaded from the TENANT settings — the modal shows it and the
    // PUT endpoint rejects a broader staff value.
    let restaurantDietaryMode = "VEG_AND_NON_VEG";
    try {
      const setting = await db.restaurantSetting.findUnique({
        where: { restaurantId: req.user.restaurantId },
        select: { dietaryMode: true },
      });
      if (setting && setting.dietaryMode === "VEG_ONLY") restaurantDietaryMode = "VEG_ONLY";
    } catch (err) {
      console.warn("[User] dietaryMode read failed (defaulting to VEG_AND_NON_VEG):", err.message);
    }

    const effective = resolveEffectivePermissions(user, permRows);
    // Order-type assignment (Takeaway vs Dine In / Floor) — same UserPermission
    // table, reported alongside the rest so the Staff Roster modal renders it.
    const { assignedOrderTypesFromRows } = require("../utils/orderAccess");
    return res.json({
      success: true,
      data: {
        user: { id: user.id, name: user.name, role: user.role },
        dietaryAccess: user.dietaryAccess || "VEG_AND_NON_VEG",
        assignedOrderTypes: assignedOrderTypesFromRows(permRows),
        dietaryOptions: Object.values(DIETARY_ACCESS),
        restaurantDietaryMode,
        fullAccess: effective.full,
        effectivePermissions: Array.from(effective.permissions),
        roleDefaults: roleDefaultsFor(user.role) === "FULL" ? ALL_PERMISSION_KEYS : roleDefaultsFor(user.role),
        overrides: permRows.map((r) => ({ permissionKey: r.permissionKey, enabled: r.enabled })),
        catalog: ALL_PERMISSION_KEYS.map((key) => ({ key, label: PERMISSION_LABELS[key] || key })),
        actionGroups: ACTION_GROUPS,
      },
    });
  } catch (error) {
    console.error("[User] getUserPermissions error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/users/:id/permissions
 * Body: { permissions: { "dashboard.view": true, "orders.create": false, ... },
 *         dietaryAccess: "VEG_ONLY" | "VEG_AND_NON_VEG" }
 *
 * Writes explicit overrides into the TENANT UserPermission table (never
 * public.User). ADMIN's own access is never restricted (Part 21) — the
 * backend still refuses permission changes for ADMIN targets.
 */
const updateUserPermissions = async (req, res) => {
  try {
    const db = await resolveUserDb(req);
    const userId = Number(req.params.id);
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const { ADMIN, SUPER_ADMIN } = { ADMIN: "ADMIN", SUPER_ADMIN: "SUPER_ADMIN" };
    if ([ADMIN, SUPER_ADMIN].includes(String(user.role).toUpperCase())) {
      return res.status(400).json({ success: false, message: "Admin accounts always have full access and cannot be restricted." });
    }

    const { ALL_PERMISSION_KEYS, DIETARY_ACCESS } = require("../utils/permissions");
    const { ORDER_TYPE_ASSIGNMENT_KEYS } = require("../utils/orderAccess");
    const { permissions, dietaryAccess } = req.body || {};
    // Valid keys = permission catalog + the reserved order-type assignment keys
    // (orders.takeaway / orders.dine_in — same UserPermission table, no new model).
    const validKeys = new Set([...ALL_PERMISSION_KEYS, ...ORDER_TYPE_ASSIGNMENT_KEYS]);

    if (dietaryAccess !== undefined) {
      if (!Object.values(DIETARY_ACCESS).includes(dietaryAccess)) {
        return res.status(400).json({ success: false, message: "Invalid dietaryAccess value." });
      }
      // Part 14: a staff member can never hold a BROADER Food Access than the
      // restaurant's dietary mode (VEG_ONLY restaurant ⇒ everyone VEG_ONLY).
      if (dietaryAccess === "VEG_AND_NON_VEG") {
        try {
          const setting = await db.restaurantSetting.findUnique({
            where: { restaurantId: req.user.restaurantId },
            select: { dietaryMode: true },
          });
          if (setting && setting.dietaryMode === "VEG_ONLY") {
            return res.status(400).json({ success: false, message: "Your restaurant is configured for Veg Only — staff cannot be granted Non-Veg access." });
          }
        } catch (err) {
          console.warn("[User] dietaryMode read failed (allowing staff value):", err.message);
        }
      }
      await db.user.update({ where: { id: userId }, data: { dietaryAccess } });
    }

    if (permissions !== undefined) {
      if (typeof permissions !== "object" || Array.isArray(permissions)) {
        return res.status(400).json({ success: false, message: "permissions must be an object of key → boolean." });
      }
      const entries = Object.entries(permissions).filter(([key]) => validKeys.has(key));
      for (const [key, enabled] of entries) {
        await db.userPermission.upsert({
          where: { userId_permissionKey: { userId, permissionKey: key } },
          update: { enabled: !!enabled },
          create: { userId, permissionKey: key, enabled: !!enabled },
        });
      }
    }

    // Return the fresh effective state (same shape as GET).
    const permRows = await db.userPermission.findMany({ where: { userId } });
    const fresh = await db.user.findUnique({ where: { id: userId } });
    const { resolveEffectivePermissions, roleDefaultsFor } = require("../utils/permissions");
    const { assignedOrderTypesFromRows } = require("../utils/orderAccess");
    const effective = resolveEffectivePermissions(fresh, permRows);
    return res.json({
      success: true,
      message: "Permissions updated successfully",
      data: {
        dietaryAccess: fresh.dietaryAccess,
        assignedOrderTypes: assignedOrderTypesFromRows(permRows),
        fullAccess: effective.full,
        effectivePermissions: Array.from(effective.permissions),
        overrides: permRows.map((r) => ({ permissionKey: r.permissionKey, enabled: r.enabled })),
      },
    });
  } catch (error) {
    console.error("[User] updateUserPermissions error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/users/:id/permissions — reset to role defaults.
 * Removes every override row: the user is back to exactly what their role
 * grants by default (Part 7 "Reset to Role Defaults").
 */
const resetUserPermissions = async (req, res) => {
  try {
    const db = await resolveUserDb(req);
    const userId = Number(req.params.id);
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (["ADMIN", "SUPER_ADMIN"].includes(String(user.role).toUpperCase())) {
      return res.status(400).json({ success: false, message: "Admin accounts always have full access." });
    }
    await db.userPermission.deleteMany({ where: { userId } });
    return res.json({ success: true, message: "Permissions reset to role defaults" });
  } catch (error) {
    console.error("[User] resetUserPermissions error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const changeStatus = async (req, res) => {
  try {
    const db = await resolveUserDb(req);
    const existingUser = await db.user.findFirst({ where: { id: Number(req.params.id) }, select: { id: true } });
    if (!existingUser) return res.status(404).json({ success: false, message: "User not found" });
    const user = await db.user.update({ where: { id: Number(req.params.id) }, data: { isActive: req.body.isActive } });
    res.json({ success: true, user });
  } catch (error) { return errorResponse(res, error.message); }
};

const changePassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) return errorResponse(res, "New password is required.");
    if (newPassword.length < 8) return errorResponse(res, "Password must be at least 8 characters.");
    const db = await resolveUserDb(req);
    const existingUser = await db.user.findFirst({ where: { id: Number(req.params.id) }, select: { id: true } });
    if (!existingUser) return errorResponse(res, "User not found", 404);
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.user.update({ where: { id: Number(req.params.id) }, data: { password: hashedPassword, passwordChangedAt: new Date() } });
    return successResponse(res, null, "Password updated successfully.");
  } catch (error) { return errorResponse(res, error.message); }
};

const deleteUser = async (req, res) => {
  try {
    const db = await resolveUserDb(req);
    const existingUser = await db.user.findFirst({ where: { id: Number(req.params.id) }, select: { id: true } });
    if (!existingUser) return res.status(404).json({ success: false, message: "User not found" });
    await db.user.delete({ where: { id: Number(req.params.id) } });
    res.json({ success: true, message: "User deleted" });
  } catch (error) { return errorResponse(res, error.message); }
};

// ─── Staff Floor Assignment (many-to-many, tenant-scoped) ──────────────────
// Assignable roles: MANAGER / CASHIER / KITCHEN / WAITER. SUPER_ADMIN is
// platform-level and ADMIN is restaurant-wide — neither is assignable.
const ASSIGNABLE_FLOOR_ROLES = ["MANAGER", "CASHIER", "KITCHEN", "WAITER"];

const getUserFloorAssignments = async (req, res) => {
  try {
    const db = await resolveUserDb(req);
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return errorResponse(res, "Invalid user ID", 400);
    }
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true } });
    if (!user) return errorResponse(res, "Staff member not found", 404);
    const assignments = await db.userFloorAssignment.findMany({
      where: { userId },
      select: { floorId: true, createdAt: true },
    });
    // Order-type grant rides along in the same response — the Staff Roster
    // card + Assign Access modal need it, and this keeps it to one request.
    // Dine In is implicit (default for all staff); only TAKEAWAY is reported.
    const orderTypeRows = await db.userPermission.findMany({
      where: { userId, permissionKey: { in: [ORDER_TYPE_TAKEAWAY_KEY, ORDER_TYPE_DINE_IN_KEY] } },
      select: { permissionKey: true, enabled: true },
    });
    res.json({
      success: true,
      floorIds: assignments.map((a) => a.floorId),
      assignedOrderTypes: assignedOrderTypesFromRows(orderTypeRows),
    });
  } catch (error) {
    console.error("[User] getUserFloorAssignments error:", error.message);
    return errorResponse(res, error.message);
  }
};

const updateUserFloorAssignments = async (req, res) => {
  try {
    const db = await resolveUserDb(req);
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return errorResponse(res, "Invalid user ID", 400);
    }
    // Order-type grant and floors are saved together from the Assign Access
    // modal. Dine In is implicit — the only meaningful value is whether the
    // TAKEAWAY grant is present. Legacy callers that send only floorIds still
    // work: when assignedOrderTypes is absent the floor set is updated and the
    // takeaway grant is left untouched (idempotent for existing UIs).
    const { floorIds, assignedOrderTypes } = req.body || {};
    const hasOrderTypePayload = Array.isArray(assignedOrderTypes);
    if (hasOrderTypePayload && assignedOrderTypes.some((t) => String(t) !== "TAKEAWAY")) {
      return errorResponse(res, "assignedOrderTypes may only contain TAKEAWAY (Dine In is default for all staff)", 400);
    }
    if (!Array.isArray(floorIds) || floorIds.some((f) => !Number.isSafeInteger(Number(f)) || Number(f) <= 0)) {
      return errorResponse(res, "floorIds must be an array of positive integers", 400);
    }
    const normalized = [...new Set(floorIds.map((f) => Number(f)))];

    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, name: true } });
    if (!user) return errorResponse(res, "Staff member not found", 404);
    if (!ASSIGNABLE_FLOOR_ROLES.includes(user.role)) {
      return errorResponse(res, `Floor assignment is not available for role ${user.role}`, 400);
    }

    // Every floorId must exist in this tenant (never trust client floor data).
    if (normalized.length > 0) {
      const validFloors = await db.floor.findMany({
        where: { id: { in: normalized } },
        select: { id: true },
      });
      const validSet = new Set(validFloors.map((f) => f.id));
      const invalid = normalized.filter((f) => !validSet.has(f));
      if (invalid.length > 0) {
        return errorResponse(res, `Unknown floor ID(s): ${invalid.join(", ")}`, 400);
      }
    }

    // Replace-all semantics inside a transaction; unique(userId, floorId)
    // guarantees no duplicate assignment rows. When the payload includes the
    // order grant: upsert orders.takeaway to the flag and DELETE any legacy
    // orders.dine_in row (Dine In is implicit — the row is dead weight and its
    // presence must not silently re-enable anything). DINE_IN cannot be revoked
    // because no row is ever written for it again.
    const wantTakeaway = hasOrderTypePayload && assignedOrderTypes.map(String).includes("TAKEAWAY");
    await db.$transaction(async (tx) => {
      await tx.userFloorAssignment.deleteMany({ where: { userId } });
      if (normalized.length > 0) {
        await tx.userFloorAssignment.createMany({
          data: normalized.map((floorId) => ({ userId, floorId })),
        });
      }
      if (hasOrderTypePayload) {
        if (wantTakeaway) {
          await tx.userPermission.upsert({
            where: { userId_permissionKey: { userId, permissionKey: ORDER_TYPE_TAKEAWAY_KEY } },
            update: { enabled: true },
            create: { userId, permissionKey: ORDER_TYPE_TAKEAWAY_KEY, enabled: true },
          });
        } else {
          await tx.userPermission.deleteMany({
            where: { userId, permissionKey: ORDER_TYPE_TAKEAWAY_KEY },
          });
        }
        // Legacy cleanup: two-checkbox era rows no longer have meaning.
        await tx.userPermission.deleteMany({
          where: { userId, permissionKey: ORDER_TYPE_DINE_IN_KEY },
        });
      }
    });

    res.json({
      success: true,
      message: "Assignments updated",
      floorIds: normalized,
      assignedOrderTypes: hasOrderTypePayload ? (wantTakeaway ? ["TAKEAWAY"] : []) : undefined,
    });
  } catch (error) {
    console.error("[User] updateUserFloorAssignments error:", error.message);
    return errorResponse(res, error.message);
  }
};

// Floors visible to the CURRENT user (for Floors & Tables / POS): restricted
// staff see only their assigned floors; exempt roles see everything.
const getMyFloors = async (req, res) => {
  try {
    const { getAssignedFloorIds } = require("../utils/floorAccess");
    const floorIds = await getAssignedFloorIds(req.tenantDb, req.user.id, req.user.role);
    const where = floorIds === null ? {} : { id: { in: floorIds.length ? floorIds : [-1] } };
    const floors = await req.tenantDb.floor.findMany({ where, orderBy: { sortOrder: "asc" } });
    res.json({ success: true, floors, restricted: floorIds !== null });
  } catch (error) {
    console.error("[User] getMyFloors error:", error.message);
    return errorResponse(res, error.message);
  }
};

module.exports = {
  createUser,
  getUsers,
  getWaiters,
  getUserById,
  updateUser,
  changeStatus,
  changePassword,
  deleteUser,
  getUserPermissions,
  getMyPermissions,
  updateUserPermissions,
  resetUserPermissions,
  getUserFloorAssignments,
  updateUserFloorAssignments,
  getMyFloors,
};
