const prisma = require("../config/prisma");
const bcrypt = require("bcryptjs");
const { createNotification } = require("../services/notification.service");

const createUser = async (req, res) => {
  try {
    const { name, email, password, role, restaurantId } = req.body;

    const exists = await prisma.user.findUnique({
      where: { email },
    });

    if (exists) {
      return res.status(400).json({
        success: false,
        message: "Email already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    let assignedRestaurantId;

    // Super Admin can create users for any restaurant
    if (req.user.role === "SUPER_ADMIN") {
      if (!restaurantId) {
        return res.status(400).json({
          success: false,

          message: "restaurantId is required.",
        });
      }

      assignedRestaurantId = Number(restaurantId);
    } else {
      // Restaurant Admin / Manager always use their own restaurant
      assignedRestaurantId = req.user.restaurantId;
    }
    const restaurant = await prisma.restaurant.findUnique({
      where: {
        id: assignedRestaurantId,
      },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,

        message: "Restaurant not found.",
      });
    }
    const user = await prisma.user.create({
      data: {
        restaurantId: assignedRestaurantId,

        name,

        email,

        password: hashedPassword,

        role,
      },
    });
    await createNotification({
      restaurantId: req.user.restaurantId,

      userId: req.user.id,

      title: "New User Created",

      message: `${user.name} (${user.role}) has been created.`,

      type: "SUCCESS",
    });

    res.status(201).json({
      success: true,
      user,
    });
  } catch (error) {return errorResponse(res, error.message);}
};

const getPagination = require("../utils/pagination");
const { successResponse, errorResponse } = require("../utils/response");

const getUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "", sort = "createdAt" } = req.query;
    const { skip, take } = getPagination(page, limit);

    // Build where clause with restaurant isolation
    const where = {
      deletedAt: null,
      // Non-super-admin users can only see their own restaurant's users
      ...(req.user.role !== "SUPER_ADMIN" && req.user.restaurantId
        ? { restaurantId: req.user.restaurantId }
        : {}),
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ],
    };

    const users = await prisma.user.findMany({
      where,
      orderBy: { [sort]: "desc" },
      skip,
      take,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        lastLogin: true,
        createdAt: true,
      },
    });

    return successResponse(res, users, "Users fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    // Multi-tenant isolation: non-super-admin users can only access users
    // within their own restaurant.
    const where = {
      id: Number(id),
    };
    if (req.user.role !== "SUPER_ADMIN" && req.user.restaurantId) {
      where.restaurantId = req.user.restaurantId;
    }

    const user = await prisma.user.findUnique({
      where,

      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        avatar: true,
        isActive: true,
        lastLogin: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      user,
    });
  } catch (error) {return errorResponse(res, error.message);}
};
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;

    const { name, email, phone, role, avatar } = req.body;

    // Multi-tenant isolation: only SUPER_ADMIN may edit users outside the
    // caller's own restaurant.
    const existingUser = await prisma.user.findFirst({
      where: {
        id: Number(id),
        ...(req.user.role !== "SUPER_ADMIN" && req.user.restaurantId
          ? { restaurantId: req.user.restaurantId }
          : {}),
      },
      select: { id: true },
    });
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = await prisma.user.update({
      where: {
        id: Number(id),
      },
      data: {
        name,
        email,
        phone,
        role,
        avatar,
      },
    });

    res.status(200).json({
      success: true,
      message: "User updated successfully",
      user,
    });
  } catch (error) {
    console.error(error);return errorResponse(res, error.message);}
};

const changeStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const { isActive } = req.body;

    // Multi-tenant isolation: only SUPER_ADMIN may toggle users outside the
    // caller's own restaurant.
    const existingUser = await prisma.user.findFirst({
      where: {
        id: Number(id),
        ...(req.user.role !== "SUPER_ADMIN" && req.user.restaurantId
          ? { restaurantId: req.user.restaurantId }
          : {}),
      },
      select: { id: true },
    });
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = await prisma.user.update({
      where: {
        id: Number(id),
      },

      data: {
        isActive,
      },
    });

    res.json({
      success: true,
      user,
    });
  } catch (error) {return errorResponse(res, error.message);}
};

const changePassword = async (req, res) => {
  try {
    const { id } = req.params;

    const { newPassword } = req.body;

    if (!newPassword) {
      return errorResponse(
        res,

        "New password is required.",
      );
    }

    if (newPassword.length < 8) {
      return errorResponse(
        res,

        "Password must be at least 8 characters.",
      );
    }

    // Multi-tenant isolation: only SUPER_ADMIN may reset passwords for users
    // outside the caller's own restaurant.
    const existingUser = await prisma.user.findFirst({
      where: {
        id: Number(id),
        ...(req.user.role !== "SUPER_ADMIN" && req.user.restaurantId
          ? { restaurantId: req.user.restaurantId }
          : {}),
      },
      select: { id: true },
    });
    if (!existingUser) {
      return errorResponse(res, "User not found", 404);
    }

    const hashedPassword = await bcrypt.hash(
      newPassword,

      10,
    );

    await prisma.user.update({
      where: {
        id: Number(id),
      },

      data: {
        password: hashedPassword,
        passwordChangedAt: new Date(),
      },
    });

    return successResponse(
      res,

      null,

      "Password updated successfully.",
    );
  } catch (error) {
    return errorResponse(
      res,

      error.message,
    );
  }
};

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    // Multi-tenant isolation: only SUPER_ADMIN may delete users outside the
    // caller's own restaurant.
    const existingUser = await prisma.user.findFirst({
      where: {
        id: Number(id),
        ...(req.user.role !== "SUPER_ADMIN" && req.user.restaurantId
          ? { restaurantId: req.user.restaurantId }
          : {}),
      },
      select: { id: true },
    });
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    await prisma.user.delete({
      where: {
        id: Number(id),
      },
    });

    res.json({
      success: true,
      message: "User deleted",
    });
  } catch (error) {return errorResponse(res, error.message);}
};

module.exports = {
  createUser,
  getUsers,
  getUserById,
  updateUser,
  changeStatus,
  changePassword,
  deleteUser,
};
