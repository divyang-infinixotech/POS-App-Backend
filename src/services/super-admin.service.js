const prisma = require("../config/prisma");
const bcrypt = require("bcryptjs");
const { planToSnapshot, computeDates, computeExpiryDate, addDays } = require("../utils/subscription");
const { FEATURE_SETTINGS_MAP, AVAILABLE_RESTAURANT_MODULES } = require("../config/subscription.config");
const { encryptSecret, decryptSecret, isEncrypted } = require("../utils/encryption");
const { createAuditLog } = require("./audit.service");
const getPagination = require("../utils/pagination");

function buildRestaurantWhere(opts) {
  var where = { deletedAt: null };
  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: "insensitive" } },
      { ownerName: { contains: opts.search, mode: "insensitive" } },
      { email: { contains: opts.search, mode: "insensitive" } },
      { phone: { contains: opts.search, mode: "insensitive" } },
    ];
  }
  if (opts.status) where.status = opts.status;
  if (opts.plan) where.subscriptionPlan = opts.plan;
  if (opts.startDate || opts.endDate) {
    where.createdAt = {};
    if (opts.startDate) where.createdAt.gte = new Date(opts.startDate);
    if (opts.endDate) where.createdAt.lte = new Date(opts.endDate);
  }
  return where;
}

function buildSubscriptionWhere(opts) {
  var where = {};
  var now = new Date();
  var plus7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  var plus30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  if (opts.plan) where.plan = opts.plan;
  if (opts.billingCycle && ["MONTHLY", "YEARLY", "ONCE"].indexOf(String(opts.billingCycle).toUpperCase()) !== -1) {
    where.billingCycle = String(opts.billingCycle).toUpperCase();
  }

  // Status filter: EXPIRING_SOON is a derived view (active + expiry within 7
  // days); everything else maps straight to the stored Subscription.status.
  if (opts.status === "EXPIRING_SOON") {
    where.status = { in: ["ACTIVE", "TRIAL"] };
    where.expiryDate = { gt: now, lte: plus7 };
  } else if (opts.status) {
    where.status = opts.status;
  }

  // Expiry filter: next 7 days / next 30 days / already expired.
  // "expired" covers both persisted EXPIRED rows and active rows whose date
  // has passed but the cron has not persisted yet (logical expiry).
  if (opts.expiry === "next7") {
    if (!where.status) where.status = { in: ["ACTIVE", "TRIAL"] };
    where.expiryDate = { gte: now, lte: plus7 };
  } else if (opts.expiry === "next30") {
    if (!where.status) where.status = { in: ["ACTIVE", "TRIAL"] };
    where.expiryDate = { gte: now, lte: plus30 };
  } else if (opts.expiry === "expired") {
    where.expiryDate = { lt: now };
  }

  if (opts.search) {
    where.restaurant = {
      OR: [
        { name: { contains: opts.search, mode: "insensitive" } },
        { email: { contains: opts.search, mode: "insensitive" } },
      ],
    };
  }
  return where;
}

// ─── Subscription helpers (DB-driven) ───

/** Apply plan feature access to RestaurantSetting module flags immediately */
async function applyPlanFeaturesToSettings(tx, restaurantId, features) {
  var set = new Set(features || []);
  var updateData = {};
  Object.keys(FEATURE_SETTINGS_MAP).forEach(function (feature) {
    FEATURE_SETTINGS_MAP[feature].forEach(function (key) {
      updateData[key] = set.has(feature);
    });
  });
  if (Object.keys(updateData).length > 0) {
    await tx.restaurantSetting.updateMany({ where: { restaurantId: Number(restaurantId) }, data: updateData });
  }
}

/** Append-only plan history row (never overwritten) */
async function recordSubscriptionHistory(tx, d) {
  await tx.subscriptionHistory.create({
    data: {
      restaurantId: d.restaurantId,
      changeType: d.changeType,
      previousPlanId: d.previousPlanId ?? null,
      newPlanId: d.newPlanId ?? null,
      previousPlan: d.previousPlan ?? null,
      newPlan: d.newPlan ?? null,
      previousStatus: d.previousStatus ?? null,
      newStatus: d.newStatus ?? null,
      billingCycle: d.billingCycle ?? null,
      amount: d.amount ?? null,
      expiryDate: d.expiryDate ?? null,
      changedBy: d.changedBy ?? null,
      notes: d.notes ?? null,
      ipAddress: d.ipAddress ?? null,
    },
  });
}

/** Notify every active admin of a restaurant about a subscription change */
async function notifyRestaurantAdmins(tx, restaurantId, title, message, type) {
  var admins = await tx.user.findMany({ where: { restaurantId: Number(restaurantId), role: "ADMIN", isActive: true, deletedAt: null }, select: { id: true } });
  var rows = admins.map(function (a) { return { restaurantId: Number(restaurantId), userId: a.id, title: title, message: message, type: type || "SUBSCRIPTION" }; });
  if (rows.length > 0) await tx.notification.createMany({ data: rows });
  else await tx.notification.create({ data: { restaurantId: Number(restaurantId), title: title, message: message, type: type || "SUBSCRIPTION" } });
}

const getDashboard = async () => {
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  var [totalRestaurants, activeRestaurants, inactiveRestaurants, suspendedRestaurants, trialRestaurants, expiredSubscriptions, totalUsers, activeUsers, todayOrders, todayRevenueAgg, monthlyRevenueAgg, newRestaurantsThisMonth, activeSubscriptions, pendingRenewals] = await Promise.all([
    prisma.restaurant.count({ where: { deletedAt: null } }),
    prisma.restaurant.count({ where: { status: "ACTIVE" } }),
    prisma.restaurant.count({ where: { status: "INACTIVE" } }),
    prisma.restaurant.count({ where: { status: "SUSPENDED" } }),
    prisma.restaurant.count({ where: { subscriptionPlan: "TRIAL" } }),
    prisma.subscription.count({ where: { status: "EXPIRED" } }),
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { isActive: true } }),
    prisma.order.count({ where: { createdAt: { gte: today } } }),
    prisma.bill.aggregate({ _sum: { grandTotal: true }, where: { paymentStatus: "PAID", createdAt: { gte: today } } }),
    prisma.bill.aggregate({ _sum: { grandTotal: true }, where: { paymentStatus: "PAID", createdAt: { gte: firstOfMonth } } }),
    prisma.restaurant.count({ where: { createdAt: { gte: firstOfMonth } } }),
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
    prisma.subscription.count({ where: { status: { in: ["ACTIVE", "TRIAL"] }, expiryDate: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } } }),
  ]);

  var monthLabels = [];
  for (var i = 11; i >= 0; i--) {
    var d = new Date(); d.setMonth(d.getMonth() - i);
    var start = new Date(d.getFullYear(), d.getMonth(), 1);
    var end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    monthLabels.push({ start: start, end: end, label: start.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) });
  }

  var monthlyGrowthPromises = monthLabels.map(function(ml) {
    return prisma.restaurant.count({ where: { createdAt: { gte: ml.start, lt: ml.end } } });
  });
  var subscriptionRevenuePromises = monthLabels.map(function(ml) {
    return prisma.bill.aggregate({ _sum: { grandTotal: true }, where: { paymentStatus: "PAID", createdAt: { gte: ml.start, lt: ml.end } } });
  });

  var [growthCounts, revenueResults] = await Promise.all([
    Promise.all(monthlyGrowthPromises),
    Promise.all(subscriptionRevenuePromises),
  ]);

  var monthlyGrowth = monthLabels.map(function(ml, i) {
    return { label: ml.label, count: growthCounts[i] };
  });
  var subscriptionRevenue = monthLabels.map(function(ml, i) {
    return { label: ml.label, revenue: revenueResults[i]._sum.grandTotal || 0 };
  });

  var planDistribution = await prisma.subscription.groupBy({ by: ["plan", "status"], _count: { id: true }, orderBy: [{ plan: "asc" }] });

  var recentRestaurants = await prisma.restaurant.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 5,
    include: { _count: { select: { users: true } } },
  });

  return {
    totalRestaurants: totalRestaurants,
    activeRestaurants: activeRestaurants,
    inactiveRestaurants: inactiveRestaurants,
    suspendedRestaurants: suspendedRestaurants,
    trialRestaurants: trialRestaurants,
    expiredSubscriptions: expiredSubscriptions,
    totalUsers: totalUsers,
    activeUsers: activeUsers,
    todayOrders: todayOrders,
    todayRevenue: todayRevenueAgg._sum.grandTotal || 0,
    monthlyRevenue: monthlyRevenueAgg._sum.grandTotal || 0,
    newRestaurantsThisMonth: newRestaurantsThisMonth,
    activeSubscriptions: activeSubscriptions,
    pendingRenewals: pendingRenewals,
    monthlyGrowth: monthlyGrowth,
    subscriptionRevenue: subscriptionRevenue,
    planDistribution: planDistribution.map(function(p) { return { plan: p.plan, status: p.status, count: p._count.id }; }),
    recentRestaurants: recentRestaurants.map(function(r) {
      return { id: r.id, name: r.name, ownerName: r.ownerName, status: r.status, subscriptionPlan: r.subscriptionPlan, _count: { users: r._count.users }, createdAt: r.createdAt };
    }),
  };
};


const listRestaurants = async function(opts) {
  if (!opts) opts = {};
  var where = buildRestaurantWhere({ search: opts.search, status: opts.status, plan: opts.plan, startDate: opts.startDate, endDate: opts.endDate });
  var pg = getPagination(opts.page || 1, opts.limit || 15);
  var [restaurants, total] = await Promise.all([
    prisma.restaurant.findMany({ where: where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { users: { select: { id: true, isActive: true } }, subscription: { include: { planDef: { select: { id: true, code: true, name: true } } } } } }),
    prisma.restaurant.count({ where: where }),
  ]);
  var now = new Date();
  return {
    restaurants: restaurants.map(function(r) {
      var totalUsers = r.users.length;
      var activeUsers = r.users.filter(function(u) { return u.isActive; }).length;
      var sub = r.subscription;
      var daysRemaining = sub && sub.expiryDate ? Math.max(0, Math.ceil((sub.expiryDate - now) / 86400000)) : null;
      return {
        id: r.id, name: r.name, ownerName: r.ownerName, email: r.email, phone: r.phone, city: r.city, state: r.state, country: r.country, logo: r.logo,
        plan: r.subscriptionPlan,
        planName: sub && sub.planDef ? sub.planDef.name : r.subscriptionPlan,
        subscriptionStatus: sub ? sub.status : null,
        startDate: sub ? sub.startDate : null,
        expiryDate: sub ? sub.expiryDate : null,
        daysRemaining: daysRemaining,
        billingCycle: sub ? sub.billingCycle : null,
        status: r.status, totalUsers: totalUsers, activeUsers: activeUsers, createdAt: r.createdAt,
      };
    }),
    pagination: { page: Number(opts.page || 1), limit: Number(opts.limit || 15), total: total, totalPages: Math.ceil(total / Number(opts.limit || 15)) },
  };
};

const restaurantDetails = async function(id) {
  var r = await prisma.restaurant.findUnique({
    where: { id: Number(id) },
    include: { users: { select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, lastLogin: true, createdAt: true } }, restaurantSetting: true, subscription: true },
  });
  if (!r) throw new Error("Restaurant not found");
  var [totalOrders, totalBills, totalCustomers, totalTables, totalCategories, totalMenu, totalPayments, revenue] = await Promise.all([
    prisma.order.count({ where: { restaurantId: r.id } }), prisma.bill.count({ where: { restaurantId: r.id } }),
    prisma.customer.count({ where: { restaurantId: r.id } }), prisma.restaurantTable.count({ where: { restaurantId: r.id } }),
    prisma.category.count({ where: { restaurantId: r.id } }), prisma.menuItem.count({ where: { restaurantId: r.id } }),
    prisma.payment.count({ where: { restaurantId: r.id } }),
    prisma.bill.aggregate({ where: { restaurantId: r.id, paymentStatus: "PAID" }, _sum: { grandTotal: true } }),
  ]);
  return Object.assign({}, r, {
    statistics: { totalUsers: r.users.length, totalOrders: totalOrders, totalBills: totalBills, totalCustomers: totalCustomers, totalTables: totalTables, totalCategories: totalCategories, totalMenu: totalMenu, totalPayments: totalPayments, totalRevenue: revenue._sum.grandTotal || 0 },
  });
};

var createRestaurant = async function(data, userId, ipAddress, userAgent) {
  var name = data.name, ownerName = data.ownerName, mobile = data.mobile, email = data.email, gstNumber = data.gstNumber, fssaiNumber = data.fssaiNumber, address = data.address, country = data.country || "India", state = data.state, city = data.city, pincode = data.pincode, timezone = data.timezone || "Asia/Kolkata", currency = data.currency || "INR", language = data.language || "en", logo = data.logo, status = data.status || "ACTIVE", adminName = data.adminName, adminEmail = data.adminEmail, adminPassword = data.adminPassword, businessType = data.businessType || "RESTAURANT", website = data.website;
  // Resolve the subscription plan from the database (by planId or code) — never hardcoded
  var plan = null;
  if (data.planId) {
    plan = await prisma.plan.findUnique({ where: { id: Number(data.planId) } });
  } else if (data.subscriptionPlan) {
    plan = await prisma.plan.findUnique({ where: { code: String(data.subscriptionPlan).toUpperCase() } });
  } else {
    plan = (await prisma.plan.findFirst({ where: { isDefault: true } })) || (await prisma.plan.findFirst({ where: { code: "TRIAL" } }));
  }
  if (!plan) throw new Error("Subscription plan not found. Create a plan in Plans Management first.");
  var billingCycle = plan.billingCycle || "MONTHLY";
  var dates = computeDates(plan, billingCycle, new Date());
  var snapshot = planToSnapshot(plan, billingCycle);
  var existingPhone = await prisma.restaurant.findUnique({ where: { phone: mobile } });
  if (existingPhone) throw new Error("A restaurant with this phone number already exists");
  if (email) { var existingEmail = await prisma.restaurant.findUnique({ where: { email: email } }); if (existingEmail) throw new Error("A restaurant with this email already exists"); }
  var hashedPassword = await bcrypt.hash(adminPassword, 10);
  return prisma.$transaction(async function(tx) {
    var restaurant = await tx.restaurant.create({ data: { name: name, ownerName: ownerName, phone: mobile, email: email || null, gstNumber: gstNumber || null, fssaiNumber: fssaiNumber || null, address: address || null, country: country || "India", state: state || null, city: city || null, pincode: pincode || null, timezone: timezone, currency: currency, language: language, logo: logo || null, subscriptionPlan: plan.code, status: status, businessType: businessType, website: website || null } });
    await tx.restaurantSetting.create({ data: { restaurantId: restaurant.id, restaurantName: name, currency: currency, timezone: timezone, language: language, taxPercentage: 0, serviceCharge: 0, roundOffEnabled: true, billPrefix: "BILL", invoicePrefix: "INV", kotPrefix: "KOT", receiptFooter: "Thank You! Visit Again." } });
    var sub = await tx.subscription.create({ data: { restaurantId: restaurant.id, planId: plan.id, plan: plan.code, status: plan.code === "TRIAL" ? "TRIAL" : "ACTIVE", startDate: dates.startDate, expiryDate: dates.expiryDate, nextRenewalDate: dates.expiryDate, billingCycle: billingCycle, autoRenew: snapshot.autoRenew, maxUsers: data.maxUsers != null ? Number(data.maxUsers) : snapshot.maxUsers, maxTables: data.maxTables != null ? Number(data.maxTables) : snapshot.maxTables, maxMenuItems: data.maxMenuItems != null ? Number(data.maxMenuItems) : snapshot.maxMenuItems, maxFloors: snapshot.maxFloors, maxPrinters: snapshot.maxPrinters, maxBranches: snapshot.maxBranches, maxOrdersPerMonth: snapshot.maxOrdersPerMonth, storageLimitMB: snapshot.storageLimitMB, features: snapshot.features, amount: snapshot.amount } });
    await applyPlanFeaturesToSettings(tx, restaurant.id, snapshot.features);
    var admin = await tx.user.create({ data: { restaurantId: restaurant.id, name: adminName, email: adminEmail, password: hashedPassword, role: "ADMIN", isActive: true } });
    await recordSubscriptionHistory(tx, { restaurantId: restaurant.id, changeType: "CREATION", previousPlanId: null, newPlanId: plan.id, previousPlan: null, newPlan: plan.code, previousStatus: null, newStatus: plan.code === "TRIAL" ? "TRIAL" : "ACTIVE", billingCycle: billingCycle, amount: snapshot.amount, expiryDate: dates.expiryDate, changedBy: userId, notes: "Restaurant created with the " + plan.name + " plan", ipAddress: ipAddress });
    await tx.notification.create({ data: { restaurantId: restaurant.id, userId: userId, title: "New Restaurant Created", message: "Restaurant " + name + " created on " + plan.name + " plan. Admin: " + adminName + " (" + adminEmail + ")", type: "SUCCESS" } });
    await createAuditLog({ restaurantId: restaurant.id, userId: userId, module: "USER", action: "CREATE", description: "Created restaurant " + name + " with admin " + adminName + " on " + plan.name + " plan", referenceId: restaurant.id, referenceNo: name, ipAddress: ipAddress, userAgent: userAgent }, tx);
    return { id: restaurant.id, name: restaurant.name, plan: plan.code, admin: { id: admin.id, name: admin.name, email: admin.email } };
  });
};

var updateRestaurant = async function(id, data) {
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(id) } });
  if (!restaurant) throw new Error("Restaurant not found");
  var updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.ownerName !== undefined) updateData.ownerName = data.ownerName;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.mobile !== undefined) updateData.phone = data.mobile;
  if (data.gstNumber !== undefined) updateData.gstNumber = data.gstNumber;
  if (data.fssaiNumber !== undefined) updateData.fssaiNumber = data.fssaiNumber;
  if (data.address !== undefined) updateData.address = data.address;
  if (data.country !== undefined) updateData.country = data.country;
  if (data.state !== undefined) updateData.state = data.state;
  if (data.city !== undefined) updateData.city = data.city;
  if (data.pincode !== undefined) updateData.pincode = data.pincode;
  if (data.timezone !== undefined) updateData.timezone = data.timezone;
  if (data.currency !== undefined) updateData.currency = data.currency;
  if (data.language !== undefined) updateData.language = data.language;
  if (data.logo !== undefined) updateData.logo = data.logo;
  if (data.status !== undefined) updateData.status = data.status;
  return prisma.$transaction(async function(tx) {
    var updated = await tx.restaurant.update({ where: { id: Number(id) }, data: updateData });
    if (data.name) { await tx.restaurantSetting.updateMany({ where: { restaurantId: Number(id) }, data: { restaurantName: data.name } }); }
    return updated;
  });
};

var changeRestaurantStatus = async function(id, status) {
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(id) } });
  if (!restaurant) throw new Error("Restaurant not found");
  if (["ACTIVE", "INACTIVE", "SUSPENDED"].indexOf(status) === -1) throw new Error("Invalid restaurant status");
  return prisma.$transaction(async function(tx) {
    await tx.restaurant.update({ where: { id: Number(id) }, data: { status: status } });
    if (status === "SUSPENDED" || status === "INACTIVE") { await tx.user.updateMany({ where: { restaurantId: Number(id) }, data: { isActive: false } }); }
    if (status === "ACTIVE") { await tx.user.updateMany({ where: { restaurantId: Number(id) }, data: { isActive: true } }); }
    return { message: "Restaurant " + status.toLowerCase() + " successfully" };
  });
};

var removeRestaurant = async function(id) {
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(id) } });
  if (!restaurant) throw new Error("Restaurant not found");
  if (restaurant.deletedAt) return { message: "Restaurant is already deleted." };
  return prisma.$transaction(async function(tx) {
    await tx.restaurant.update({ where: { id: Number(id) }, data: { deletedAt: new Date(), status: "INACTIVE" } });
    await tx.user.updateMany({ where: { restaurantId: Number(id) }, data: { deletedAt: new Date(), isActive: false } });
    await recordSubscriptionHistory(tx, { restaurantId: Number(id), changeType: "CANCELLATION", previousPlanId: null, newPlanId: null, previousPlan: restaurant.subscriptionPlan, newPlan: null, previousStatus: restaurant.status, newStatus: "INACTIVE", changedBy: null, notes: "Restaurant soft-deleted by Super Admin", ipAddress: null });
    return { message: "Restaurant soft-deleted successfully. All data preserved for audit." };
  });
};

var restoreRestaurant = async function(id) {
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(id) } });
  if (!restaurant) throw new Error("Restaurant not found");
  return prisma.$transaction(async function(tx) {
    await tx.restaurant.update({ where: { id: Number(id) }, data: { deletedAt: null, status: "ACTIVE" } });
    await tx.user.updateMany({ where: { restaurantId: Number(id) }, data: { deletedAt: null, isActive: true } });
    return { message: "Restaurant restored successfully." };
  });
};

// ─── USERS ───

var listUsers = async function(opts) {
  if (!opts) opts = {};
  var where = { deletedAt: null, role: { not: "SUPER_ADMIN" } };
  if (opts.search) { where.OR = [{ name: { contains: opts.search, mode: "insensitive" } }, { email: { contains: opts.search, mode: "insensitive" } }]; }
  if (opts.role) where.role = opts.role;
  if (opts.status === "active") where.isActive = true;
  if (opts.status === "inactive") where.isActive = false;
  var pg = getPagination(opts.page || 1, opts.limit || 20);
  var [users, total] = await Promise.all([
    prisma.user.findMany({ where: where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { restaurant: { select: { id: true, name: true } } } }),
    prisma.user.count({ where: where }),
  ]);
  return {
    users: users.map(function(u) { return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, isActive: u.isActive, avatar: u.avatar, lastLogin: u.lastLogin, createdAt: u.createdAt, restaurant: u.restaurant ? { id: u.restaurant.id, name: u.restaurant.name } : null }; }),
    pagination: { page: Number(opts.page || 1), limit: Number(opts.limit || 20), total: total, totalPages: Math.ceil(total / Number(opts.limit || 20)) },
  };
};

var adminCreateUser = async function(data, userId, ipAddress, userAgent) {
  var restaurantId = data.restaurantId, name = data.name, email = data.email, password = data.password, role = data.role, phone = data.phone, avatar = data.avatar, isActive = data.isActive !== undefined ? data.isActive : true;
  if (!restaurantId) throw new Error("restaurantId is required");
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(restaurantId) } });
  if (!restaurant) throw new Error("Restaurant not found");
  var existing = await prisma.user.findUnique({ where: { email: email } });
  if (existing) throw new Error("A user with this email already exists");
  var hashedPassword = await bcrypt.hash(password, 10);
  var user = await prisma.user.create({ data: { restaurantId: Number(restaurantId), name: name, email: email, password: hashedPassword, role: role, phone: phone || null, avatar: avatar || null, isActive: isActive } });
  await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "USER", action: "CREATE", description: "Created user " + name + " (" + email + ") with role " + role, referenceId: user.id, referenceNo: email, ipAddress: ipAddress, userAgent: userAgent });
  return { id: user.id, name: user.name, email: user.email, role: user.role };
};

var adminUpdateUser = async function(id, data) {
  var user = await prisma.user.findUnique({ where: { id: Number(id) } });
  if (!user) throw new Error("User not found");
  var updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.email !== undefined) {
    var existing = await prisma.user.findFirst({ where: { email: data.email, id: { not: Number(id) } } });
    if (existing) throw new Error("Email already in use by another user");
    updateData.email = data.email;
  }
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.avatar !== undefined) updateData.avatar = data.avatar;
  return prisma.user.update({ where: { id: Number(id) }, data: updateData });
};

var adminResetPassword = async function(id) {
  var user = await prisma.user.findUnique({ where: { id: Number(id) } });
  if (!user) throw new Error("User not found");
  var newPassword = "reset123";
  var hashedPassword = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: Number(id) }, data: { password: hashedPassword, passwordChangedAt: new Date() } });
  return { newPassword: newPassword };
};

var adminToggleUserStatus = async function(id) {
  var user = await prisma.user.findUnique({ where: { id: Number(id) } });
  if (!user) throw new Error("User not found");
  return prisma.user.update({ where: { id: Number(id) }, data: { isActive: !user.isActive } });
};

var adminDeleteUser = async function(id) {
  var user = await prisma.user.findUnique({ where: { id: Number(id) } });
  if (!user) throw new Error("User not found");
  return prisma.user.update({ where: { id: Number(id) }, data: { deletedAt: new Date(), isActive: false } });
};

var adminChangeUserRole = async function(id, role) {
  var user = await prisma.user.findUnique({ where: { id: Number(id) } });
  if (!user) throw new Error("User not found");
  if (["ADMIN", "MANAGER", "CASHIER", "WAITER", "KITCHEN"].indexOf(role) === -1) throw new Error("Invalid role");
  return prisma.user.update({ where: { id: Number(id) }, data: { role: role } });
};

// ─── SUBSCRIPTIONS ───

var listSubscriptions = async function(opts) {
  if (!opts) opts = {};
  var where = buildSubscriptionWhere({ search: opts.search, plan: opts.plan, status: opts.status, expiry: opts.expiry, billingCycle: opts.billingCycle });
  var pg = getPagination(opts.page || 1, opts.limit || 20);
  var [subscriptions, total] = await Promise.all([
    prisma.subscription.findMany({ where: where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { restaurant: { select: { id: true, name: true, email: true, phone: true, status: true } }, planDef: { select: { id: true, code: true, name: true } } } }),
    prisma.subscription.count({ where: where }),
  ]);
  var now = new Date();
  return {
    subscriptions: subscriptions.map(function(s) {
      // Backend-authoritative days/lifecycle (never client-calculated)
      var lifecycle = computeSubscriptionLifecycle(s, now);
      var daysRemaining = lifecycle.daysRemaining;
      return {
        id: s.id, restaurantId: s.restaurantId, plan: s.plan, planId: s.planId,
        planName: s.planDef ? s.planDef.name : s.plan,
        status: lifecycle.status, lifecycle: lifecycle.lifecycle, expiryMessage: lifecycle.expiryMessage,
        startDate: s.startDate, expiryDate: s.expiryDate, nextRenewalDate: s.nextRenewalDate,
        billingCycle: s.billingCycle, maxUsers: s.maxUsers, maxTables: s.maxTables, maxFloors: s.maxFloors,
        maxMenuItems: s.maxMenuItems, maxPrinters: s.maxPrinters, maxBranches: s.maxBranches,
        maxOrdersPerMonth: s.maxOrdersPerMonth, storageLimitMB: s.storageLimitMB, features: s.features || [],
        amount: s.amount, autoRenew: s.autoRenew, daysRemaining: daysRemaining, createdAt: s.createdAt,
        restaurant: s.restaurant,
      };
    }),
    pagination: { page: Number(opts.page || 1), limit: Number(opts.limit || 20), total: total, totalPages: Math.ceil(total / Number(opts.limit || 20)) },
  };
};

/**
 * Change (upgrade/downgrade) a restaurant's subscription plan.
 * data: { planId, action: 'upgrade'|'downgrade'|'change', billingCycle, effectiveDate, notes }
 */
var changeSubscriptionPlan = async function(restaurantId, data, userId, ipAddress, userAgent) {
  var badRequest = function(message) { var err = new Error(message); err.statusCode = 400; throw err; };
  if (!data || !data.planId) badRequest("planId is required");
  var subscription = await prisma.subscription.findUnique({ where: { restaurantId: Number(restaurantId) } });
  if (!subscription) badRequest("Subscription not found");
  var plan = await prisma.plan.findUnique({ where: { id: Number(data.planId) } });
  if (!plan) badRequest("Plan not found");
  if (!plan.isActive) badRequest("Selected plan is inactive. Activate it before assigning.");

  var billingCycle = data.billingCycle || plan.billingCycle || "MONTHLY";
  if (["MONTHLY", "YEARLY", "ONCE"].indexOf(billingCycle) === -1) badRequest("Invalid billing cycle");
  var dates = computeDates(plan, billingCycle, data.effectiveDate || new Date());
  var snapshot = planToSnapshot(plan, billingCycle);

  var action = String(data.action || "change").toLowerCase();
  var changeType;
  if (action === "upgrade") changeType = "UPGRADE";
  else if (action === "downgrade") changeType = "DOWNGRADE";
  else if (plan.code === subscription.plan) changeType = "RENEWAL";
  else changeType = Number(plan.monthlyPrice) >= Number(subscription.amount || 0) ? "UPGRADE" : "DOWNGRADE";

  return prisma.$transaction(async function(tx) {
    var updated = await tx.subscription.update({
      where: { restaurantId: Number(restaurantId) },
      data: {
        planId: plan.id, plan: plan.code, status: "ACTIVE", startDate: dates.startDate, expiryDate: dates.expiryDate,
        nextRenewalDate: dates.expiryDate, billingCycle: billingCycle, autoRenew: snapshot.autoRenew,
        maxUsers: snapshot.maxUsers, maxTables: snapshot.maxTables, maxFloors: snapshot.maxFloors,
        maxMenuItems: snapshot.maxMenuItems, maxPrinters: snapshot.maxPrinters, maxBranches: snapshot.maxBranches,
        maxOrdersPerMonth: snapshot.maxOrdersPerMonth, storageLimitMB: snapshot.storageLimitMB,
        features: snapshot.features, amount: snapshot.amount, updatedBy: userId, cancelledAt: null, cancelledReason: null,
      },
    });
    await tx.restaurant.update({ where: { id: Number(restaurantId) }, data: { subscriptionPlan: plan.code, status: "ACTIVE" } });
    await tx.user.updateMany({ where: { restaurantId: Number(restaurantId) }, data: { isActive: true } });
    await applyPlanFeaturesToSettings(tx, Number(restaurantId), snapshot.features);
    await recordSubscriptionHistory(tx, {
      restaurantId: Number(restaurantId), changeType: changeType,
      previousPlanId: subscription.planId, newPlanId: plan.id,
      previousPlan: subscription.plan, newPlan: plan.code,
      previousStatus: subscription.status, newStatus: "ACTIVE",
      billingCycle: billingCycle, amount: snapshot.amount, expiryDate: dates.expiryDate,
      changedBy: userId, notes: data.notes || null, ipAddress: ipAddress,
    });
    await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "SUBSCRIPTION", action: "UPDATE", description: "Subscription " + changeType.toLowerCase() + " from " + subscription.plan + " to " + plan.code + (data.notes ? " (" + data.notes + ")" : ""), referenceId: updated.id, referenceNo: plan.code, ipAddress: ipAddress, userAgent: userAgent }, tx);
    await notifyRestaurantAdmins(tx, Number(restaurantId), changeType === "UPGRADE" ? "Subscription Upgraded" : changeType === "DOWNGRADE" ? "Subscription Downgraded" : "Subscription Updated", "Your subscription plan changed from " + subscription.plan + " to " + plan.code + ". New expiry: " + dates.expiryDate.toDateString() + ".", "SUBSCRIPTION");
    return updated;
  });
};

var renewSubscription = async function(restaurantId, userId, ipAddress, userAgent, notes) {
  var existing = await prisma.subscription.findUnique({ where: { restaurantId: Number(restaurantId) }, include: { planDef: true } });
  if (!existing) throw new Error("Subscription not found");
  var plan = existing.planDef || (await prisma.plan.findFirst({ where: { code: existing.plan } }));
  if (!plan) throw new Error("Plan definition not found");
  var billingCycle = existing.billingCycle || plan.billingCycle || "MONTHLY";
  var now = new Date();
  var base = existing.expiryDate && existing.expiryDate > now ? existing.expiryDate : now;
  var expiryDate = plan.code === "TRIAL" && Number(plan.trialDays) > 0 ? addDays(now, Number(plan.trialDays)) : computeExpiryDate(base, billingCycle);
  var amount = billingCycle === "YEARLY" ? Number(plan.yearlyPrice || 0) : Number(plan.monthlyPrice || 0);
  return prisma.$transaction(async function(tx) {
    var updated = await tx.subscription.update({ where: { restaurantId: Number(restaurantId) }, data: { status: "ACTIVE", startDate: now, expiryDate: expiryDate, nextRenewalDate: expiryDate, billingCycle: billingCycle, amount: amount || existing.amount, autoRenew: existing.autoRenew, updatedBy: userId, cancelledAt: null, cancelledReason: null } });
    await tx.restaurant.update({ where: { id: Number(restaurantId) }, data: { status: "ACTIVE" } });
    await tx.user.updateMany({ where: { restaurantId: Number(restaurantId) }, data: { isActive: true } });
    await recordSubscriptionHistory(tx, { restaurantId: Number(restaurantId), changeType: "RENEWAL", previousPlanId: existing.planId, newPlanId: existing.planId, previousPlan: existing.plan, newPlan: existing.plan, previousStatus: existing.status, newStatus: "ACTIVE", billingCycle: billingCycle, amount: amount || existing.amount, expiryDate: expiryDate, changedBy: userId, notes: notes || null, ipAddress: ipAddress });
    await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "SUBSCRIPTION", action: "UPDATE", description: "Subscription renewed (" + existing.plan + "). New expiry: " + expiryDate.toDateString(), referenceId: updated.id, referenceNo: existing.plan, ipAddress: ipAddress, userAgent: userAgent }, tx);
    await notifyRestaurantAdmins(tx, Number(restaurantId), "Subscription Renewed", "Your " + existing.plan + " subscription has been renewed. New expiry: " + expiryDate.toDateString() + ".", "SUBSCRIPTION");
    return updated;
  });
};

var cancelSubscription = async function(restaurantId, userId, ipAddress, userAgent, notes) {
  var existing = await prisma.subscription.findUnique({ where: { restaurantId: Number(restaurantId) } });
  if (!existing) throw new Error("Subscription not found");
  return prisma.$transaction(async function(tx) {
    var updated = await tx.subscription.update({ where: { restaurantId: Number(restaurantId) }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledReason: notes || null, updatedBy: userId } });
    await tx.restaurant.update({ where: { id: Number(restaurantId) }, data: { status: "INACTIVE" } });
    await tx.user.updateMany({ where: { restaurantId: Number(restaurantId) }, data: { isActive: false } });
    await recordSubscriptionHistory(tx, { restaurantId: Number(restaurantId), changeType: "CANCELLATION", previousPlanId: existing.planId, newPlanId: null, previousPlan: existing.plan, newPlan: null, previousStatus: existing.status, newStatus: "CANCELLED", billingCycle: existing.billingCycle, amount: existing.amount, changedBy: userId, notes: notes || null, ipAddress: ipAddress });
    await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "SUBSCRIPTION", action: "UPDATE", description: "Subscription cancelled (" + existing.plan + ")" + (notes ? " — " + notes : ""), referenceId: updated.id, referenceNo: existing.plan, ipAddress: ipAddress, userAgent: userAgent }, tx);
    await notifyRestaurantAdmins(tx, Number(restaurantId), "Subscription Cancelled", "Your subscription has been cancelled. Contact support to renew.", "SUBSCRIPTION");
    return updated;
  });
};

var suspendSubscription = async function(restaurantId, userId, ipAddress, userAgent, notes) {
  var existing = await prisma.subscription.findUnique({ where: { restaurantId: Number(restaurantId) } });
  if (!existing) throw new Error("Subscription not found");
  return prisma.$transaction(async function(tx) {
    var updated = await tx.subscription.update({ where: { restaurantId: Number(restaurantId) }, data: { status: "SUSPENDED", updatedBy: userId } });
    await tx.restaurant.update({ where: { id: Number(restaurantId) }, data: { status: "SUSPENDED" } });
    await tx.user.updateMany({ where: { restaurantId: Number(restaurantId) }, data: { isActive: false } });
    await recordSubscriptionHistory(tx, { restaurantId: Number(restaurantId), changeType: "SUSPENSION", previousPlanId: existing.planId, newPlanId: existing.planId, previousPlan: existing.plan, newPlan: existing.plan, previousStatus: existing.status, newStatus: "SUSPENDED", changedBy: userId, notes: notes || null, ipAddress: ipAddress });
    await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "SUBSCRIPTION", action: "UPDATE", description: "Subscription suspended (" + existing.plan + ")" + (notes ? " — " + notes : ""), referenceId: updated.id, referenceNo: existing.plan, ipAddress: ipAddress, userAgent: userAgent }, tx);
    await notifyRestaurantAdmins(tx, Number(restaurantId), "Subscription Suspended", "Your subscription has been suspended. Contact support to resolve.", "SUBSCRIPTION");
    return updated;
  });
};

/** Reactivate a suspended / cancelled / expired subscription (resets cycle from today) */
var activateSubscription = async function(restaurantId, userId, ipAddress, userAgent, notes) {
  var existing = await prisma.subscription.findUnique({ where: { restaurantId: Number(restaurantId) }, include: { planDef: true } });
  if (!existing) throw new Error("Subscription not found");
  var plan = existing.planDef || (await prisma.plan.findFirst({ where: { code: existing.plan } }));
  if (!plan) throw new Error("Plan definition not found");
  var billingCycle = existing.billingCycle || plan.billingCycle || "MONTHLY";
  var now = new Date();
  var expiryDate = plan.code === "TRIAL" && Number(plan.trialDays) > 0 ? addDays(now, Number(plan.trialDays)) : computeExpiryDate(now, billingCycle);
  return prisma.$transaction(async function(tx) {
    var updated = await tx.subscription.update({ where: { restaurantId: Number(restaurantId) }, data: { status: "ACTIVE", startDate: now, expiryDate: expiryDate, nextRenewalDate: expiryDate, billingCycle: billingCycle, updatedBy: userId, cancelledAt: null, cancelledReason: null } });
    await tx.restaurant.update({ where: { id: Number(restaurantId) }, data: { status: "ACTIVE" } });
    await tx.user.updateMany({ where: { restaurantId: Number(restaurantId) }, data: { isActive: true } });
    await recordSubscriptionHistory(tx, { restaurantId: Number(restaurantId), changeType: "REACTIVATION", previousPlanId: existing.planId, newPlanId: plan.id, previousPlan: existing.plan, newPlan: existing.plan, previousStatus: existing.status, newStatus: "ACTIVE", billingCycle: billingCycle, amount: existing.amount, expiryDate: expiryDate, changedBy: userId, notes: notes || null, ipAddress: ipAddress });
    await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "SUBSCRIPTION", action: "UPDATE", description: "Subscription reactivated (" + existing.plan + ")" + (notes ? " — " + notes : ""), referenceId: updated.id, referenceNo: existing.plan, ipAddress: ipAddress, userAgent: userAgent }, tx);
    await notifyRestaurantAdmins(tx, Number(restaurantId), "Subscription Activated", "Your subscription has been reactivated. New expiry: " + expiryDate.toDateString() + ".", "SUBSCRIPTION");
    return updated;
  });
};

/** Append-only plan history for a restaurant */
var getSubscriptionHistory = async function(restaurantId) {
  return prisma.subscriptionHistory.findMany({
    where: { restaurantId: Number(restaurantId) },
    orderBy: { createdAt: "desc" },
    include: {
      previousPlanDef: { select: { id: true, code: true, name: true } },
      newPlanDef: { select: { id: true, code: true, name: true } },
    },
    take: 100,
  });
};

/**
 * Real gateway payment records for a restaurant (SubscriptionPayment rows).
 * Returned alongside plan history so Super Admin sees the actual purchase trail
 * — amount, status, method, Razorpay reference — straight from the database.
 */
var getSubscriptionPayments = async function(restaurantId) {
  return prisma.subscriptionPayment.findMany({
    where: { restaurantId: Number(restaurantId) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
};

// ─── PLANS (database-driven, no hardcoded config) ───

/**
 * Resolve the list of enabled module keys from a plan payload.
 * `modules` (preferred): [{ moduleKey, enabled }] — full toggle state.
 * `features` (legacy): plain array of enabled keys.
 */
function resolveEnabledModuleKeys(modules, features) {
  if (Array.isArray(modules) && modules.length > 0) {
    return modules.filter(function (m) { return m && m.enabled; }).map(function (m) { return String(m.moduleKey); });
  }
  return Array.isArray(features) ? features.filter(Boolean) : [];
}

/**
 * Persist a plan's module permissions (full replace against the active catalog)
 * and return the normalized list of ENABLED module keys (source of truth for
 * Plan.features and the subscription snapshot).
 */
async function syncPlanModulePermissions(tx, planId, modules, features) {
  var catalog = await tx.planModule.findMany({ where: { isActive: true }, select: { id: true, key: true } });
  if (catalog.length === 0) return [];
  var enabled = new Set(resolveEnabledModuleKeys(modules, features));
  var enabledKeys = catalog.map(function (m) { return m.key; }).filter(function (k) { return enabled.has(k); });
  await tx.planModulePermission.deleteMany({ where: { planId: Number(planId) } });
  await tx.planModulePermission.createMany({
    data: catalog.map(function (m) { return { planId: Number(planId), moduleId: m.id, isEnabled: enabledKeys.indexOf(m.key) !== -1 }; }),
  });
  return enabledKeys;
}

/** Module catalog (used by the plan editor to render ON/OFF toggles) */
var listPlanModules = async function(opts) {
  var where = {};
  if (!(opts && opts.includeInactive === "true")) where.isActive = true;
  var modules = await prisma.planModule.findMany({ where: where, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return modules.map(function (m) {
    return {
      id: m.id,
      key: m.key,
      name: m.name,
      icon: m.icon,
      isActive: m.isActive,
      sortOrder: m.sortOrder,
      // Only modules backed by a real restaurant feature may be toggled on a
      // plan. The plan editor hides available:false rows entirely.
      available: AVAILABLE_RESTAURANT_MODULES.indexOf(m.key) !== -1,
    };
  });
};

/** Shared lifecycle view for the SA subscription listing (same semantics as the restaurant snapshot). */
function computeSubscriptionLifecycle(s, now) {
  var ref = now || new Date();
  var status = s.status;
  if ((status === "ACTIVE" || status === "TRIAL") && s.expiryDate && new Date(s.expiryDate) < ref) {
    status = "EXPIRED"; // logical expiry — persisted by the cron shortly after
  }
  var blocked = status === "EXPIRED" || status === "CANCELLED" || status === "SUSPENDED";
  var daysRemaining = s.expiryDate ? Math.max(0, Math.ceil((new Date(s.expiryDate) - ref) / 86400000)) : null;
  var lifecycle = blocked ? "EXPIRED" : daysRemaining !== null && daysRemaining <= 7 ? "EXPIRING_SOON" : "ACTIVE";
  return { status: status, lifecycle: lifecycle, daysRemaining: daysRemaining };
}

var listPlans = async function(opts) {
  if (!opts) opts = {};
  var where = {};
  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: "insensitive" } },
      { code: { contains: opts.search, mode: "insensitive" } },
    ];
  }
  if (opts.status === "active") where.isActive = true;
  if (opts.status === "inactive") where.isActive = false;
  if (opts.active === "true" || opts.active === true) where.isActive = true;
  var sortField = ["name", "code", "monthlyPrice", "yearlyPrice", "sortOrder", "createdAt"].indexOf(opts.sortBy) !== -1 ? opts.sortBy : "sortOrder";
  var sortDir = opts.sortOrder === "desc" ? "desc" : "asc";
  var plans = await prisma.plan.findMany({
    where: where,
    orderBy: [{ [sortField]: sortDir }, { sortOrder: "asc" }],
    include: {
      modulePermissions: {
        select: { moduleId: true, isEnabled: true, module: { select: { key: true, name: true, icon: true } } },
      },
      _count: { select: { subscriptions: true } },
    },
  });
  return plans.map(function (p) {
    return {
      id: p.id, code: p.code, name: p.name, description: p.description,
      monthlyPrice: p.monthlyPrice, yearlyPrice: p.yearlyPrice, billingCycle: p.billingCycle,
      trialDays: p.trialDays, maxUsers: p.maxUsers, maxTables: p.maxTables, maxFloors: p.maxFloors,
      maxMenuItems: p.maxMenuItems, maxPrinters: p.maxPrinters, maxBranches: p.maxBranches,
      maxOrdersPerMonth: p.maxOrdersPerMonth, storageLimitMB: p.storageLimitMB,
      features: p.features || [],
      modules: (p.modulePermissions || []).map(function (mp) {
        return { moduleKey: mp.module.key, name: mp.module.name, icon: mp.module.icon, enabled: mp.isEnabled };
      }),
      isActive: p.isActive, isDefault: p.isDefault, sortOrder: p.sortOrder,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
      restaurantCount: p._count ? p._count.subscriptions || 0 : 0,
    };
  });
};

var createPlan = async function(data) {
  if (!data.code || !data.name) throw new Error("code and name are required");
  var code = String(data.code).toUpperCase().replace(/\s+/g, "_");
  var existing = await prisma.plan.findUnique({ where: { code: code } });
  if (existing) throw new Error("A plan with this code already exists");
  return prisma.$transaction(async function (tx) {
    var plan = await tx.plan.create({
      data: {
        code: code, name: data.name, description: data.description || null,
        monthlyPrice: Number(data.monthlyPrice || 0), yearlyPrice: Number(data.yearlyPrice || 0),
        billingCycle: data.billingCycle || "MONTHLY", trialDays: Number(data.trialDays || 0),
        maxUsers: data.maxUsers != null ? Number(data.maxUsers) : null,
        maxTables: data.maxTables != null ? Number(data.maxTables) : null,
        maxFloors: data.maxFloors != null ? Number(data.maxFloors) : null,
        maxMenuItems: data.maxMenuItems != null ? Number(data.maxMenuItems) : null,
        maxPrinters: data.maxPrinters != null ? Number(data.maxPrinters) : null,
        maxBranches: data.maxBranches != null ? Number(data.maxBranches) : null,
        maxOrdersPerMonth: data.maxOrdersPerMonth != null ? Number(data.maxOrdersPerMonth) : null,
        storageLimitMB: data.storageLimitMB != null ? Number(data.storageLimitMB) : null,
        features: [],
        isActive: data.isActive !== undefined ? !!data.isActive : true,
        isDefault: !!data.isDefault, sortOrder: Number(data.sortOrder || 0),
      },
    });
    var enabledKeys = await syncPlanModulePermissions(tx, plan.id, data.modules, data.features);
    await tx.plan.update({ where: { id: plan.id }, data: { features: enabledKeys } });
    return plan;
  });
};

var updatePlan = async function(id, data) {
  var plan = await prisma.plan.findUnique({ where: { id: Number(id) } });
  if (!plan) throw new Error("Plan not found");
  var updateData = {};
  if (data.code !== undefined) {
    var code = String(data.code).toUpperCase().replace(/\s+/g, "_");
    var dup = await prisma.plan.findFirst({ where: { code: code, id: { not: Number(id) } } });
    if (dup) throw new Error("A plan with this code already exists");
    updateData.code = code;
  }
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.monthlyPrice !== undefined) updateData.monthlyPrice = Number(data.monthlyPrice);
  if (data.yearlyPrice !== undefined) updateData.yearlyPrice = Number(data.yearlyPrice);
  if (data.billingCycle !== undefined) updateData.billingCycle = data.billingCycle;
  if (data.trialDays !== undefined) updateData.trialDays = Number(data.trialDays);
  ["maxUsers", "maxTables", "maxFloors", "maxMenuItems", "maxPrinters", "maxBranches", "maxOrdersPerMonth", "storageLimitMB"].forEach(function (k) {
    if (data[k] !== undefined) updateData[k] = data[k] === null || data[k] === "" ? null : Number(data[k]);
  });
  if (data.features !== undefined) updateData.features = Array.isArray(data.features) ? data.features : [];
  if (data.isActive !== undefined) updateData.isActive = !!data.isActive;
  if (data.isDefault !== undefined) updateData.isDefault = !!data.isDefault;
  if (data.sortOrder !== undefined) updateData.sortOrder = Number(data.sortOrder);
  // Cascade plan code changes to live subscriptions/restaurants so no stale codes remain.
  // Also propagate feature edits to existing subscribers immediately (spec: instant feature access).
  return prisma.$transaction(async function (tx) {
    if (Array.isArray(data.modules)) {
      // Full module-permission sync (relational source of truth) → recompute features
      updateData.features = await syncPlanModulePermissions(tx, Number(id), data.modules, data.features);
    } else if (Array.isArray(data.features)) {
      // Legacy: keep permissions in sync with the provided feature list
      updateData.features = await syncPlanModulePermissions(tx, Number(id), null, data.features);
    }
    if (updateData.code && updateData.code !== plan.code) {
      await tx.subscription.updateMany({ where: { planId: Number(id) }, data: { plan: updateData.code } });
      await tx.restaurant.updateMany({ where: { subscriptionPlan: plan.code }, data: { subscriptionPlan: updateData.code } });
    }
    if (Array.isArray(updateData.features)) {
      var subs = await tx.subscription.findMany({ where: { planId: Number(id) }, select: { restaurantId: true } });
      await tx.subscription.updateMany({ where: { planId: Number(id) }, data: { features: updateData.features } });
      for (var i = 0; i < subs.length; i++) {
        await applyPlanFeaturesToSettings(tx, subs[i].restaurantId, updateData.features);
      }
    }
    return tx.plan.update({ where: { id: Number(id) }, data: updateData });
  });
};

var togglePlanActive = async function(id) {
  var plan = await prisma.plan.findUnique({ where: { id: Number(id) } });
  if (!plan) throw new Error("Plan not found");
  return prisma.plan.update({ where: { id: Number(id) }, data: { isActive: !plan.isActive } });
};

/** Duplicate a plan (including its module permissions) into a new plan. */
var duplicatePlan = async function(id) {
  var plan = await prisma.plan.findUnique({
    where: { id: Number(id) },
    include: { modulePermissions: { select: { moduleId: true, isEnabled: true } } },
  });
  if (!plan) throw new Error("Plan not found");
  var baseCode = plan.code + "_COPY";
  var code = baseCode;
  var suffix = 2;
  while (await prisma.plan.findUnique({ where: { code: code } })) {
    code = baseCode + "_" + suffix;
    suffix++;
  }
  return prisma.$transaction(async function (tx) {
    var copy = await tx.plan.create({
      data: {
        code: code, name: plan.name + " (Copy)", description: plan.description,
        monthlyPrice: plan.monthlyPrice, yearlyPrice: plan.yearlyPrice, billingCycle: plan.billingCycle,
        trialDays: plan.trialDays, maxUsers: plan.maxUsers, maxTables: plan.maxTables,
        maxFloors: plan.maxFloors, maxMenuItems: plan.maxMenuItems, maxPrinters: plan.maxPrinters,
        maxBranches: plan.maxBranches, maxOrdersPerMonth: plan.maxOrdersPerMonth,
        storageLimitMB: plan.storageLimitMB, features: plan.features || [],
        isActive: plan.isActive !== false, isDefault: false, sortOrder: (plan.sortOrder || 0) + 1,
      },
    });
    if (plan.modulePermissions && plan.modulePermissions.length > 0) {
      await tx.planModulePermission.createMany({
        data: plan.modulePermissions.map(function (mp) { return { planId: copy.id, moduleId: mp.moduleId, isEnabled: mp.isEnabled }; }),
      });
    }
    return copy;
  });
};

var deletePlan = async function(id) {
  var plan = await prisma.plan.findUnique({ where: { id: Number(id) } });
  if (!plan) throw new Error("Plan not found");
  var inUse = await prisma.subscription.count({ where: { planId: Number(id) } });
  if (inUse > 0) {
    throw new Error("This plan is currently assigned to " + inUse + " restaurant(s). Reassign them before deleting.");
  }
  // PlanModulePermission rows are removed via ON DELETE CASCADE
  await prisma.plan.delete({ where: { id: Number(id) } });
  return { message: "Plan deleted successfully" };
};

// ─── REPORTS ───

var getReports = async function(opts) {
  if (!opts) opts = {};
  switch (opts.type) {
    case "restaurant_growth": return getRestaurantGrowthReport();
    case "subscription_revenue": return getSubscriptionRevenueReport();
    case "user_growth": return getUserGrowthReport();
    case "expired_plans": return getExpiredPlansReport();
    case "upcoming_renewals": return getUpcomingRenewalsReport();
    case "restaurant_activity": return getRestaurantActivityReport();
    default: return getRestaurantGrowthReport();
  }
};

var getRestaurantGrowthReport = async function() {
  var months = [];
  for (var i = 11; i >= 0; i--) {
    var d = new Date(); d.setMonth(d.getMonth() - i);
    var start = new Date(d.getFullYear(), d.getMonth(), 1);
    var end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    var count = await prisma.restaurant.count({ where: { createdAt: { gte: start, lt: end } } });
    months.push({ label: start.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), count: count });
  }
  return months;
};

var getSubscriptionRevenueReport = async function() {
  var subscriptions = await prisma.subscription.findMany({ where: { status: { in: ["ACTIVE", "TRIAL"] } }, include: { restaurant: { select: { name: true, email: true } } }, orderBy: { amount: "desc" } });
  var totalRevenue = subscriptions.reduce(function(sum, s) { return sum + s.amount; }, 0);
  return { totalRevenue: totalRevenue, count: subscriptions.filter(function(s) { return s.status === "ACTIVE"; }).length, subscriptions: subscriptions.slice(0, 20) };
};

var getUserGrowthReport = async function() {
  var months = [];
  for (var i = 11; i >= 0; i--) {
    var d = new Date(); d.setMonth(d.getMonth() - i);
    var start = new Date(d.getFullYear(), d.getMonth(), 1);
    var end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    var count = await prisma.user.count({ where: { createdAt: { gte: start, lt: end } } });
    months.push({ label: start.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), count: count });
  }
  return months;
};

var getExpiredPlansReport = async function() {
  var subscriptions = await prisma.subscription.findMany({ where: { status: "EXPIRED" }, include: { restaurant: { select: { name: true, email: true } } }, orderBy: { expiryDate: "desc" }, take: 50 });
  return { subscriptions: subscriptions };
};

var getUpcomingRenewalsReport = async function() {
  var thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  var subscriptions = await prisma.subscription.findMany({ where: { status: { in: ["ACTIVE", "TRIAL"] }, expiryDate: { lte: thirtyDays, gte: new Date() } }, include: { restaurant: { select: { name: true, email: true } } }, orderBy: { expiryDate: "asc" }, take: 50 });
  return { subscriptions: subscriptions };
};

var getRestaurantActivityReport = async function() {
  var restaurants = await prisma.restaurant.findMany({ where: { deletedAt: null }, include: { _count: { select: { orders: true, bills: true, users: true } } }, orderBy: { createdAt: "desc" }, take: 50 });
  var sorted = [].concat(restaurants).sort(function(a, b) { return b._count.orders - a._count.orders; });
  return { mostActive: sorted.slice(0, 10).map(function(r) { return { name: r.name, orderCount: r._count.orders }; }), leastActive: sorted.slice(-10).reverse().map(function(r) { return { name: r.name, orderCount: r._count.orders }; }) };
};

// ─── SETTINGS ───

// Keys whose values are secrets — never returned to the frontend, encrypted at
// rest with the same AES-256-GCM helper the payment gateway uses. Matching is
// intentionally broad (anything ending in _pass or containing secret) so a
// future key added to the System Settings screen is safe by default.
var isSensitiveSettingKey = function(key) {
  return typeof key === "string" && /(_pass$|secret|_key$|password)/i.test(key);
};

// Frontend-visible mask for a configured secret (never the real value).
var SECRET_MASK = "********";

var getSystemSettings = async function() {
  var settings = await prisma.systemSetting.findMany();
  var result = {};
  settings.forEach(function(s) {
    if (isSensitiveSettingKey(s.key)) {
      // Legacy plaintext values are treated as "not safely stored" → masked.
      result[s.key] = isEncrypted(s.value) && decryptSecret(s.value) !== "" ? SECRET_MASK : "";
    } else {
      result[s.key] = s.value;
    }
  });
  return result;
};

// Keys the System Settings screen may write. Everything else is rejected so
// the bulk endpoint can never touch unrelated records (e.g. gateway config
// stored under payment_gateway_razorpay is managed by the dedicated flow).
var ALLOWED_SETTING_KEYS = [
  "platform_name",
  "default_trial_days",
  "maintenance_mode",
  "max_file_upload_mb",
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_pass",
  "smtp_from_email",
  "payment_gateway",
  "razorpay_key",
  "razorpay_secret",
  "tax_percentage",
  "currency",
];

var updateSystemSetting = async function(key, value) {
  if (isSensitiveSettingKey(key)) {
    // Secrets are encrypted at rest; a mask sent back from the UI means
    // "keep the existing value" (no change).
    if (value === SECRET_MASK) {
      var existing = await prisma.systemSetting.findUnique({ where: { key: key } });
      if (existing) return existing;
    }
    value = encryptSecret(value == null ? "" : String(value));
  }
  return prisma.systemSetting.upsert({ where: { key: key }, update: { value: value }, create: { key: key, value: value } });
};

/**
 * Bulk update for the System Settings screen — one atomic operation.
 * Only allowlisted keys are touched; omitted keys are preserved; sensitive
 * values are encrypted at rest (a SECRET_MASK value preserves the stored
 * secret). Returns the sanitized settings map (never plaintext secrets).
 */
var updateSystemSettings = async function(bulk) {
  var entries = Object.keys(bulk || {}).filter(function (k) { return ALLOWED_SETTING_KEYS.indexOf(k) !== -1; });
  if (entries.length === 0) {
    var err = new Error("No valid settings provided");
    err.statusCode = 400;
    throw err;
  }
  await prisma.$transaction(async function (tx) {
    for (var i = 0; i < entries.length; i++) {
      var key = entries[i];
      var value = bulk[key];
      if (isSensitiveSettingKey(key)) {
        if (value === SECRET_MASK) {
          var existing = await tx.systemSetting.findUnique({ where: { key: key } });
          if (existing) continue; // preserve the stored secret untouched
        }
        value = encryptSecret(value == null ? "" : String(value));
      }
      await tx.systemSetting.upsert({ where: { key: key }, update: { value: value }, create: { key: key, value: value } });
    }
  });
  return getSystemSettings(); // sanitized map — never plaintext secrets
};

// ─── AUDIT LOGS ───

var getAuditLogs = async function(opts) {
  if (!opts) opts = {};
  var where = {};
  if (opts.module) where.module = opts.module;
  var pg = getPagination(opts.page || 1, opts.limit || 25);
  var [logs, total] = await Promise.all([
    prisma.auditLog.findMany({ where: where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { user: { select: { id: true, name: true, email: true, role: true } }, restaurant: { select: { id: true, name: true } } } }),
    prisma.auditLog.count({ where: where }),
  ]);
  return { logs: logs, pagination: { page: Number(opts.page || 1), limit: Number(opts.limit || 25), total: total, totalPages: Math.ceil(total / Number(opts.limit || 25)) } };
};

// ─── SUPPORT TICKETS ───

var listSupportTickets = async function(opts) {
  if (!opts) opts = {};
  var where = {};
  if (opts.status) where.status = opts.status;
  if (opts.priority) where.priority = opts.priority;
  var pg = getPagination(opts.page || 1, opts.limit || 20);
  var [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({ where: where, orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { restaurant: { select: { id: true, name: true } }, user: { select: { id: true, name: true } }, assignee: { select: { id: true, name: true } } } }),
    prisma.supportTicket.count({ where: where }),
  ]);
  return { tickets: tickets, pagination: { page: Number(opts.page || 1), limit: Number(opts.limit || 20), total: total, totalPages: Math.ceil(total / Number(opts.limit || 20)) } };
};

var updateSupportTicket = async function(id, data) {
  var ticket = await prisma.supportTicket.findUnique({ where: { id: Number(id) } });
  if (!ticket) throw new Error("Support ticket not found");
  var updateData = {};
  if (data.status) updateData.status = data.status;
  if (data.priority) updateData.priority = data.priority;
  if (data.assignedTo !== undefined) updateData.assignedTo = data.assignedTo ? Number(data.assignedTo) : null;
  if (data.resolution !== undefined) updateData.resolution = data.resolution;
  return prisma.supportTicket.update({ where: { id: Number(id) }, data: updateData, include: { restaurant: { select: { id: true, name: true } }, assignee: { select: { id: true, name: true } } } });
};

// ─── NOTIFICATIONS ───

var getNotifications = async function(opts) {
  if (!opts) opts = {};
  var pg = getPagination(opts.page || 1, opts.limit || 20);
  var [notifications, total] = await Promise.all([
    prisma.notification.findMany({ orderBy: { createdAt: "desc" }, skip: pg.skip, take: pg.take, include: { restaurant: { select: { id: true, name: true } } } }),
    prisma.notification.count(),
  ]);
  return { notifications: notifications, pagination: { page: Number(opts.page || 1), limit: Number(opts.limit || 20), total: total, totalPages: Math.ceil(total / Number(opts.limit || 20)) } };
};

// ─── DOCUMENTS ───

/** Allowed document types */
var ALLOWED_DOC_TYPES = [
  "GST_CERTIFICATE", "FSSAI_LICENSE", "BUSINESS_REGISTRATION",
  "PAN", "OWNER_ID", "ADDRESS_PROOF", "OTHER"
];

/** Upload a document for a restaurant (called after multer processes the file) */
var uploadDocument = async function(restaurantId, data, userId, ipAddress, userAgent) {
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(restaurantId) } });
  if (!restaurant) throw new Error("Restaurant not found");
  if (!data.documentType || ALLOWED_DOC_TYPES.indexOf(data.documentType) === -1) {
    throw new Error("Invalid document type. Allowed: " + ALLOWED_DOC_TYPES.join(", "));
  }
  if (!data.fileReference) throw new Error("File reference is required");
  var doc = await prisma.restaurantDocument.create({
    data: {
      restaurantId: Number(restaurantId),
      documentType: data.documentType,
      fileReference: data.fileReference,
      originalFileName: data.originalFileName || null,
      mimeType: data.mimeType || null,
      fileSize: data.fileSize ? Number(data.fileSize) : null,
      status: "PENDING",
      uploadedBy: userId || null,
    },
  });
  await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "USER", action: "CREATE", description: "Document uploaded: " + data.documentType, referenceId: doc.id, ipAddress: ipAddress, userAgent: userAgent });
  return doc;
};

/** List all documents for a restaurant */
var listDocuments = async function(restaurantId) {
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(restaurantId) } });
  if (!restaurant) throw new Error("Restaurant not found");
  return prisma.restaurantDocument.findMany({
    where: { restaurantId: Number(restaurantId) },
    orderBy: { createdAt: "desc" },
    include: {
      uploader: { select: { id: true, name: true, email: true } },
      verifier: { select: { id: true, name: true, email: true } },
    },
  });
};

/** Verify a document */
var verifyDocument = async function(restaurantId, documentId, userId, ipAddress, userAgent) {
  var doc = await prisma.restaurantDocument.findUnique({ where: { id: Number(documentId) } });
  if (!doc) throw new Error("Document not found");
  if (doc.restaurantId !== Number(restaurantId)) throw new Error("Document does not belong to this restaurant");
  var updated = await prisma.restaurantDocument.update({
    where: { id: Number(documentId) },
    data: { status: "VERIFIED", verifiedBy: userId, verifiedAt: new Date() },
  });
  await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "USER", action: "UPDATE", description: "Document verified: " + doc.documentType, referenceId: doc.id, ipAddress: ipAddress, userAgent: userAgent });
  return updated;
};

/** Reject a document with a reason */
var rejectDocument = async function(restaurantId, documentId, reason, userId, ipAddress, userAgent) {
  var doc = await prisma.restaurantDocument.findUnique({ where: { id: Number(documentId) } });
  if (!doc) throw new Error("Document not found");
  if (doc.restaurantId !== Number(restaurantId)) throw new Error("Document does not belong to this restaurant");
  if (!reason || !reason.trim()) throw new Error("Rejection reason is required");
  var updated = await prisma.restaurantDocument.update({
    where: { id: Number(documentId) },
    data: { status: "REJECTED", rejectionReason: reason.trim(), verifiedBy: userId, verifiedAt: new Date() },
  });
  await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "USER", action: "UPDATE", description: "Document rejected: " + doc.documentType + " - " + reason.trim(), referenceId: doc.id, ipAddress: ipAddress, userAgent: userAgent });
  return updated;
};

/** Delete a document */
var deleteDocument = async function(restaurantId, documentId) {
  var doc = await prisma.restaurantDocument.findUnique({ where: { id: Number(documentId) } });
  if (!doc) throw new Error("Document not found");
  if (doc.restaurantId !== Number(restaurantId)) throw new Error("Document does not belong to this restaurant");
  await prisma.restaurantDocument.delete({ where: { id: Number(documentId) } });
  return { message: "Document deleted successfully" };
};

// ─── POLICY AGREEMENTS ───

/** Store a policy agreement record */
var createPolicyAgreement = async function(restaurantId, data, userId, ipAddress, userAgent) {
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(restaurantId) } });
  if (!restaurant) throw new Error("Restaurant not found");
  if (!data.policyType || !data.policyVersion) throw new Error("policyType and policyVersion are required");
  var agreement = await prisma.policyAgreement.create({
    data: {
      restaurantId: Number(restaurantId),
      policyType: data.policyType,
      policyVersion: data.policyVersion,
      acceptedBy: userId,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    },
  });
  await createAuditLog({ restaurantId: Number(restaurantId), userId: userId, module: "USER", action: "CREATE", description: "Policy accepted: " + data.policyType + " v" + data.policyVersion, referenceId: agreement.id, ipAddress: ipAddress, userAgent: userAgent });
  return agreement;
};

/** List policy agreements for a restaurant */
var listPolicyAgreements = async function(restaurantId) {
  var restaurant = await prisma.restaurant.findUnique({ where: { id: Number(restaurantId) } });
  if (!restaurant) throw new Error("Restaurant not found");
  return prisma.policyAgreement.findMany({
    where: { restaurantId: Number(restaurantId) },
    orderBy: { createdAt: "desc" },
    include: {
      accepter: { select: { id: true, name: true, email: true } },
    },
  });
};

// ─── ENHANCED RESTAURANT CREATION (ONBOARDING) ───

/**
 * Create restaurant with onboarding data (documents, policies, owner info).
 * Wraps the existing createRestaurant logic with additional document/policy storage.
 */
var createRestaurantOnboarding = async function(data, userId, ipAddress, userAgent) {
  // Step 1: Create the restaurant using the existing flow
  var result = await createRestaurant(data, userId, ipAddress, userAgent);
  var restaurantId = result.id;

  // Step 2: Store policy agreements if provided
  if (Array.isArray(data.policyAgreements)) {
    for (var i = 0; i < data.policyAgreements.length; i++) {
      var pa = data.policyAgreements[i];
      if (pa.policyType && pa.policyVersion) {
        await createPolicyAgreement(restaurantId, pa, userId, ipAddress, userAgent);
      }
    }
  }

  // Step 3: Update onboarding status
  await prisma.restaurant.update({
    where: { id: restaurantId },
    data: { onboardingStatus: "ACTIVE" },
  });

  // Step 4: Audit the onboarding completion
  await createAuditLog({ restaurantId: restaurantId, userId: userId, module: "USER", action: "CREATE", description: "Restaurant onboarding completed: " + data.name, referenceId: restaurantId, referenceNo: data.name, ipAddress: ipAddress, userAgent: userAgent });

  return result;
};

module.exports = {
  getDashboard: getDashboard,
  listRestaurants: listRestaurants,
  createRestaurant: createRestaurant,
  restaurantDetails: restaurantDetails,
  updateRestaurant: updateRestaurant,
  changeRestaurantStatus: changeRestaurantStatus,
  removeRestaurant: removeRestaurant,
  restoreRestaurant: restoreRestaurant,
  listUsers: listUsers,
  adminCreateUser: adminCreateUser,
  adminUpdateUser: adminUpdateUser,
  adminResetPassword: adminResetPassword,
  adminToggleUserStatus: adminToggleUserStatus,
  adminDeleteUser: adminDeleteUser,
  adminChangeUserRole: adminChangeUserRole,
  listSubscriptions: listSubscriptions,
  changeSubscriptionPlan: changeSubscriptionPlan,
  renewSubscription: renewSubscription,
  cancelSubscription: cancelSubscription,
  suspendSubscription: suspendSubscription,
  activateSubscription: activateSubscription,
  getSubscriptionHistory: getSubscriptionHistory,
  getSubscriptionPayments: getSubscriptionPayments,
  listPlans: listPlans,
  listPlanModules: listPlanModules,
  createPlan: createPlan,
  updatePlan: updatePlan,
  togglePlanActive: togglePlanActive,
  duplicatePlan: duplicatePlan,
  deletePlan: deletePlan,
  getReports: getReports,
  getSystemSettings: getSystemSettings,
  updateSystemSetting: updateSystemSetting,
  updateSystemSettings: updateSystemSettings,
  getAuditLogs: getAuditLogs,
  listSupportTickets: listSupportTickets,
  updateSupportTicket: updateSupportTicket,
  getNotifications: getNotifications,
  uploadDocument: uploadDocument,
  listDocuments: listDocuments,
  verifyDocument: verifyDocument,
  rejectDocument: rejectDocument,
  deleteDocument: deleteDocument,
  createPolicyAgreement: createPolicyAgreement,
  listPolicyAgreements: listPolicyAgreements,
  createRestaurantOnboarding: createRestaurantOnboarding,
  ALLOWED_DOC_TYPES: ALLOWED_DOC_TYPES,
};