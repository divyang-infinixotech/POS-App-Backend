const { platformPrisma } = require("../config/tenantPrisma");
const bcrypt = require("bcryptjs");
const { createNotification } = require("../services/notification.service");

function isTenantStaff(req) {
  return req.user.role !== "SUPER_ADMIN" && req.user.role !== "ADMIN" && req.user.restaurantId;
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
    const exists = await db.user.findUnique({ where: { email } });
    if (exists) return res.status(400).json({ success: false, message: "Email already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await db.user.create({ data: { name, email, password: hashedPassword, role } });
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
    const existingUser = await db.user.findFirst({ where: { id: Number(req.params.id) }, select: { id: true } });
    if (!existingUser) return res.status(404).json({ success: false, message: "User not found" });
    const user = await db.user.update({ where: { id: Number(req.params.id) }, data: { name, email, phone, role, avatar } });
    res.status(200).json({ success: true, message: "User updated successfully", user });
  } catch (error) { console.error(error); return errorResponse(res, error.message); }
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

module.exports = { createUser, getUsers, getWaiters, getUserById, updateUser, changeStatus, changePassword, deleteUser };
