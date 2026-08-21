const prisma = require("../config/prisma");

const bcrypt = require("bcryptjs");

const { successResponse, errorResponse } = require("../utils/response");
const { planToSnapshot, computeDates } = require("../utils/subscription");

const createRestaurant = async (req, res) => {
  try {
    const {
      name,
      ownerName,
      phone,
      email,
      gstNumber,
      fssaiNumber,
      address,
      city,
      state,
      country,
      pincode,
      logo,

      adminName,
      adminEmail,
      adminPhone,
      adminPassword,
    } = req.body;

    const restaurant = await prisma.$transaction(async (tx) => {
      const existingRestaurant = await prisma.restaurant.findFirst({
        where: {
          OR: [{ phone }, { email }],
        },
      });

      if (existingRestaurant) {
        return errorResponse(
          res,
          "Restaurant with this phone or email already exists.",
          400,
        );
      }
      // 1. Create Restaurant

      const newRestaurant = await tx.restaurant.create({
        data: {
          name,
          ownerName,
          phone,
          email,
          gstNumber,
          fssaiNumber,
          address,
          city,
          state,
          country,
          pincode,
          logo,
        },
      });
      const hashedPassword = await bcrypt.hash(
        adminPassword,

        10,
      );

      // 2. Create Default Restaurant Settings

      await tx.restaurantSetting.create({
        data: {
          restaurantId: newRestaurant.id,

          restaurantName: name,

          gstNumber,

          phone,

          email,

          address,

          logo,
        },
      });
      await tx.user.create({
        data: {
          restaurantId: newRestaurant.id,

          name: adminName,

          email: adminEmail,

          phone: adminPhone,

          password: hashedPassword,

          role: "ADMIN",
        },
      });

      // 3. Create Default Printer Settings

      await tx.printerSetting.create({
        data: {
          restaurantId: newRestaurant.id,

          printerName: "Default Printer",

          printerWidth: 80,
        },
      });
      // 4. Create Subscription (database-driven plan — default plan, no hardcoded config)

      const defaultPlan =
        (await prisma.plan.findFirst({ where: { isDefault: true }, orderBy: { sortOrder: "asc" } })) ||
        (await prisma.plan.findFirst({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }));
      if (!defaultPlan) {
        throw new Error("No subscription plan found. Seed plans first.");
      }
      const billingCycle = defaultPlan.billingCycle || "MONTHLY";
      const dates = computeDates(defaultPlan, billingCycle, new Date());
      const snapshot = planToSnapshot(defaultPlan, billingCycle);

      await tx.subscription.create({
        data: {
          restaurantId: newRestaurant.id,

          planId: defaultPlan.id,

          plan: defaultPlan.code,

          status: "ACTIVE",

          startDate: dates.startDate,

          expiryDate: dates.expiryDate,

          nextRenewalDate: dates.expiryDate,

          billingCycle,

          maxUsers: snapshot.maxUsers,

          maxTables: snapshot.maxTables,

          maxMenuItems: snapshot.maxMenuItems,

          maxOrdersPerMonth: snapshot.maxOrdersPerMonth,

          amount: snapshot.amount,

          autoRenew: snapshot.autoRenew,

          features: snapshot.features,
        },
      });

      // 5. Create Walk-in Customer

      await tx.customer.create({
        data: {
          restaurantId: newRestaurant.id,

          name: "Walk-in Customer",

          type: "WALK_IN",
        },
      });

      // 5. Return Restaurant

      return newRestaurant;
    });

    return successResponse(
      res,

      restaurant,

      "Restaurant created successfully",
    );
  } catch (error) {
    return errorResponse(
      res,

      error.message,

      500,
    );
  }
};

const getRestaurants = async (req, res) => {
  try {
    // SUPER_ADMIN can see all non-deleted restaurants
    // Regular users can only see their own restaurant
    if (req.user.role === "SUPER_ADMIN") {
      const restaurants = await prisma.restaurant.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { users: true, orders: true, bills: true } },
          subscription: { select: { plan: true, status: true, expiryDate: true } },
        },
      });
      return successResponse(res, restaurants, "Restaurants fetched successfully");
    }

    // Regular users see their own restaurant (returned as array for consistency)
    const restaurant = await prisma.restaurant.findFirst({
      where: { id: req.user.restaurantId, deletedAt: null },
      include: {
        _count: { select: { users: true, orders: true, bills: true } },
        subscription: { select: { plan: true, status: true, expiryDate: true } },
      },
    });

    if (!restaurant) {
      return errorResponse(res, "Restaurant not found", 404);
    }

    return successResponse(res, [restaurant], "Restaurant fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getRestaurant = async (req, res) => {
  try {
    const { id } = req.params;

    // SUPER_ADMIN can access any restaurant by ID
    // Regular users can only access their own restaurant
    const whereClause = { id: Number(id), deletedAt: null };
    if (req.user.role !== "SUPER_ADMIN") {
      whereClause.id = req.user.restaurantId;
    }

    const restaurant = await prisma.restaurant.findFirst({
      where: whereClause,
      include: {
        _count: { select: { users: true, orders: true, bills: true, menuItems: true, tables: true, customers: true } },
        subscription: { select: { plan: true, status: true, startDate: true, expiryDate: true, amount: true } },
        restaurantSetting: true,
      },
    });

    if (!restaurant) {
      return errorResponse(res, "Restaurant not found", 404);
    }

    return successResponse(res, restaurant, "Restaurant details fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updateRestaurant = async (req, res) => {
  try {
    const { id } = req.params;

    // SUPER_ADMIN can update any restaurant; regular users can only update their own
    if (req.user.role !== "SUPER_ADMIN" && Number(id) !== req.user.restaurantId) {
      return errorResponse(res, "Unauthorized to update this restaurant", 403);
    }

    const existing = await prisma.restaurant.findFirst({
      where: { id: Number(id), deletedAt: null },
    });

    if (!existing) {
      return errorResponse(res, "Restaurant not found", 404);
    }

    const {
      name,
      ownerName,
      phone,
      email,
      gstNumber,
      fssaiNumber,
      address,
      city,
      state,
      country,
      pincode,
      logo,
      website,
      supportEmail,
      supportPhone,
      timezone,
      currency,
      language,
      status,
    } = req.body;

    // Check phone uniqueness if changed
    if (phone && phone !== existing.phone) {
      const phoneExists = await prisma.restaurant.findUnique({
        where: { phone },
      });
      if (phoneExists) {
        return errorResponse(res, "A restaurant with this phone number already exists", 400);
      }
    }

    // Check email uniqueness if changed
    if (email && email !== existing.email) {
      const emailExists = await prisma.restaurant.findUnique({
        where: { email },
      });
      if (emailExists) {
        return errorResponse(res, "A restaurant with this email already exists", 400);
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (ownerName !== undefined) updateData.ownerName = ownerName;
    if (phone !== undefined) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (gstNumber !== undefined) updateData.gstNumber = gstNumber;
    if (fssaiNumber !== undefined) updateData.fssaiNumber = fssaiNumber;
    if (address !== undefined) updateData.address = address;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (country !== undefined) updateData.country = country;
    if (pincode !== undefined) updateData.pincode = pincode;
    if (logo !== undefined) updateData.logo = logo;
    if (website !== undefined) updateData.website = website;
    if (supportEmail !== undefined) updateData.supportEmail = supportEmail;
    if (supportPhone !== undefined) updateData.supportPhone = supportPhone;
    if (timezone !== undefined) updateData.timezone = timezone;
    if (currency !== undefined) updateData.currency = currency;
    if (language !== undefined) updateData.language = language;
    if (status !== undefined) updateData.status = status;

    if (Object.keys(updateData).length === 0) {
      return errorResponse(res, "No fields to update", 400);
    }

    const restaurant = await prisma.restaurant.update({
      where: { id: Number(id) },
      data: updateData,
    });

    // Update restaurant name in settings if name changed
    if (name && name !== existing.name) {
      await prisma.restaurantSetting.updateMany({
        where: { restaurantId: Number(id) },
        data: { restaurantName: name },
      });
    }

    return successResponse(res, restaurant, "Restaurant updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const deleteRestaurant = async (req, res) => {
  try {
    const { id } = req.params;

    // Only SUPER_ADMIN can delete a restaurant
    if (req.user.role !== "SUPER_ADMIN") {
      return errorResponse(res, "Unauthorized to delete restaurant", 403);
    }

    const existing = await prisma.restaurant.findFirst({
      where: { id: Number(id), deletedAt: null },
    });

    if (!existing) {
      return errorResponse(res, "Restaurant not found", 404);
    }

    // Soft delete - set deletedAt timestamp
    await prisma.restaurant.update({
      where: { id: Number(id) },
      data: { deletedAt: new Date() },
    });

    // Also deactivate all users of this restaurant
    await prisma.user.updateMany({
      where: { restaurantId: Number(id) },
      data: { isActive: false, deletedAt: new Date() },
    });

    return successResponse(res, null, "Restaurant deleted successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

module.exports = {
  createRestaurant,

  getRestaurants,

  getRestaurant,

  updateRestaurant,

  deleteRestaurant,
};
