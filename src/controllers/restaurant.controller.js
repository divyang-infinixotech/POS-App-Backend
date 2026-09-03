const { platformPrisma: prisma } = require("../config/tenantPrisma");
const { getTenantClient, generateSchemaName } = require("../config/tenantPrisma");
const bcrypt = require("bcryptjs");
const { successResponse, errorResponse } = require("../utils/response");
const { planToSnapshot, computeDates } = require("../utils/subscription");
const { initializeTenantSchema } = require("../utils/tenantSchema");

const createRestaurant = async (req, res) => {
  try {
    const { name, ownerName, phone, email, gstNumber, fssaiNumber, address, city, state, country, pincode, logo, adminName, adminEmail, adminPhone, adminPassword } = req.body;
    const existingRestaurant = await prisma.restaurant.findFirst({ where: { OR: [{ phone }, { email }] } });
    if (existingRestaurant) return errorResponse(res, "Restaurant with this phone or email already exists.", 400);

    // 1. Create Restaurant record (to get ID)
    const newRestaurant = await prisma.restaurant.create({ data: { name, ownerName, phone, email, gstNumber, fssaiNumber, address, city, state, country, pincode, logo } });

    // 2. Create tenant schema with all tables including User
    const tenantResult = await initializeTenantSchema(newRestaurant.id);
    const tenantDb = getTenantClient(tenantResult.schemaName);

    // 3. Create tenant settings
    await tenantDb.restaurantSetting.create({ data: { restaurantId: newRestaurant.id, restaurantName: name, gstNumber, phone, email, address, logo } });
    await tenantDb.printerSetting.create({ data: { restaurantId: newRestaurant.id, printerName: "Default Printer", printerWidth: 80 } });

    // 4. Create ADMIN in public schema
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    const admin = await prisma.user.create({ data: { restaurantId: newRestaurant.id, name: adminName, email: adminEmail, phone: adminPhone, password: hashedPassword, role: "ADMIN" } });

    // 5. Create Subscription
    const defaultPlan = (await prisma.plan.findFirst({ where: { isDefault: true }, orderBy: { sortOrder: "asc" } })) || (await prisma.plan.findFirst({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }));
    if (!defaultPlan) throw new Error("No subscription plan found. Seed plans first.");
    const billingCycle = defaultPlan.billingCycle || "MONTHLY";
    const dates = computeDates(defaultPlan, billingCycle, new Date());
    const snapshot = planToSnapshot(defaultPlan, billingCycle);
    await prisma.subscription.create({ data: { restaurantId: newRestaurant.id, planId: defaultPlan.id, plan: defaultPlan.code, status: "ACTIVE", startDate: dates.startDate, expiryDate: dates.expiryDate, nextRenewalDate: dates.expiryDate, billingCycle, maxUsers: snapshot.maxUsers, maxTables: snapshot.maxTables, maxMenuItems: snapshot.maxMenuItems, maxOrdersPerMonth: snapshot.maxOrdersPerMonth, amount: snapshot.amount, autoRenew: snapshot.autoRenew, features: snapshot.features } });

    // 6. Create Walk-in Customer in tenant
    await tenantDb.customer.create({ data: { name: "Walk-in Customer", type: "WALK_IN", restaurantId: newRestaurant.id } });

    return successResponse(res, newRestaurant, "Restaurant created successfully");
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

const getRestaurants = async (req, res) => {
  try {
    if (req.user.role === "SUPER_ADMIN") {
      const restaurants = await prisma.restaurant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, include: { _count: { select: { users: true, orders: true, bills: true } }, subscription: { select: { plan: true, status: true, expiryDate: true } } } });
      return successResponse(res, restaurants, "Restaurants fetched successfully");
    }
    const restaurant = await prisma.restaurant.findFirst({ where: { id: req.user.restaurantId, deletedAt: null }, include: { _count: { select: { users: true, orders: true, bills: true } }, subscription: { select: { plan: true, status: true, expiryDate: true } } } });
    if (!restaurant) return errorResponse(res, "Restaurant not found", 404);
    return successResponse(res, [restaurant], "Restaurant fetched successfully");
  } catch (error) { return errorResponse(res, error.message); }
};

const getRestaurant = async (req, res) => {
  try {
    const whereClause = { id: Number(req.params.id), deletedAt: null };
    if (req.user.role !== "SUPER_ADMIN") whereClause.id = req.user.restaurantId;
    const restaurant = await prisma.restaurant.findFirst({ where: whereClause, include: { _count: { select: { users: true, orders: true, bills: true, menuItems: true, tables: true, customers: true } }, subscription: { select: { plan: true, status: true, startDate: true, expiryDate: true, amount: true } }, restaurantSetting: true } });
    if (!restaurant) return errorResponse(res, "Restaurant not found", 404);
    return successResponse(res, restaurant, "Restaurant details fetched successfully");
  } catch (error) { return errorResponse(res, error.message); }
};

const updateRestaurant = async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.role !== "SUPER_ADMIN" && Number(id) !== req.user.restaurantId) return errorResponse(res, "Unauthorized to update this restaurant", 403);
    const existing = await prisma.restaurant.findFirst({ where: { id: Number(id), deletedAt: null } });
    if (!existing) return errorResponse(res, "Restaurant not found", 404);
    const { name, ownerName, phone, email, gstNumber, fssaiNumber, address, city, state, country, pincode, logo, website, supportEmail, supportPhone, timezone, currency, language, status } = req.body;
    if (phone && phone !== existing.phone) { const pe = await prisma.restaurant.findUnique({ where: { phone } }); if (pe) return errorResponse(res, "A restaurant with this phone number already exists", 400); }
    if (email && email !== existing.email) { const ee = await prisma.restaurant.findUnique({ where: { email } }); if (ee) return errorResponse(res, "A restaurant with this email already exists", 400); }
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
    if (Object.keys(updateData).length === 0) return errorResponse(res, "No fields to update", 400);
    const restaurant = await prisma.restaurant.update({ where: { id: Number(id) }, data: updateData });
    if (name && name !== existing.name) {
      try {
        const schemaName = generateSchemaName(Number(id));
        const tenantClient = getTenantClient(schemaName);
        await tenantClient.restaurantSetting.updateMany({ where: { restaurantId: Number(id) }, data: { restaurantName: name } });
      } catch (tenantErr) { console.warn("Could not update RestaurantSetting:", tenantErr.message); }
    }
    return successResponse(res, restaurant, "Restaurant updated successfully");
  } catch (error) { return errorResponse(res, error.message); }
};

const deleteRestaurant = async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.role !== "SUPER_ADMIN") return errorResponse(res, "Unauthorized to delete restaurant", 403);
    const existing = await prisma.restaurant.findFirst({ where: { id: Number(id), deletedAt: null } });
    if (!existing) return errorResponse(res, "Restaurant not found", 404);
    await prisma.restaurant.update({ where: { id: Number(id) }, data: { deletedAt: new Date() } });
    await prisma.user.updateMany({ where: { restaurantId: Number(id) }, data: { isActive: false, deletedAt: new Date() } });
    try {
      const schemaName = generateSchemaName(Number(id));
      const tenantClient = getTenantClient(schemaName);
      await tenantClient.user.updateMany({ where: {}, data: { isActive: false, deletedAt: new Date() } });
    } catch (tenantErr) { console.warn("Could not soft-delete tenant users:", tenantErr.message); }
    return successResponse(res, null, "Restaurant deleted successfully");
  } catch (error) { return errorResponse(res, error.message); }
};

module.exports = { createRestaurant, getRestaurants, getRestaurant, updateRestaurant, deleteRestaurant };
