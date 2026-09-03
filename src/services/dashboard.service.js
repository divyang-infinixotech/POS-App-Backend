const { platformPrisma } = require("../config/tenantPrisma");

function whereRestaurant(restaurantId) { return restaurantId ? { restaurantId } : {}; }

function getISTBusinessDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  const end = new Date(`${dateStr}T23:59:59.999+05:30`);
  return { start, end, dateStr };
}

const getOrderSummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  const [todayOrders, todayBills] = await Promise.all([
    prisma.order.count({ where: { ...whereRestaurant(restaurantId), createdAt: { gte: today }, isDeleted: false, status: { not: "CANCELLED" } } }),
    prisma.bill.count({ where: { ...whereRestaurant(restaurantId), createdAt: { gte: today }, isCancelled: false } })
  ]);
  return { todayOrders, todayBills };
};

const getRevenueSummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  const revenue = await prisma.bill.aggregate({ _sum: { grandTotal: true }, where: { ...whereRestaurant(restaurantId), createdAt: { gte: today }, status: "PAID", isCancelled: false } });
  return { todayRevenue: Number(revenue._sum.grandTotal ?? 0) };
};

const getMenuSummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const [totalMenu, totalCategories] = await Promise.all([
    prisma.menuItem.count({ where: whereRestaurant(restaurantId) }),
    prisma.category.count({ where: whereRestaurant(restaurantId) })
  ]);
  return { totalMenu, totalCategories };
};

const getUserSummary = async (restaurantId, tenantDb) => {
  let totalUsers = 0;
  if (tenantDb) { try { totalUsers = await tenantDb.user.count({ where: { isActive: true } }); } catch (err) { /* ignore */ } }
  if (restaurantId) { try { const adminCount = await platformPrisma.user.count({ where: { restaurantId, role: "ADMIN", isActive: true, deletedAt: null } }); totalUsers += adminCount; } catch (err) { /* ignore */ } }
  return { totalUsers };
};

const getTableStatusSummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const result = await prisma.restaurantTable.groupBy({ by: ["status"], where: whereRestaurant(restaurantId), _count: { status: true } });
  const summary = { AVAILABLE: 0, OCCUPIED: 0, RESERVED: 0, CLEANING: 0 };
  result.forEach((row) => { summary[row.status] = row._count.status; });
  return summary;
};

const getKitchenSummaryForDashboard = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  const pendingKOT = await prisma.kOT.count({ where: { ...whereRestaurant(restaurantId), status: "PENDING", createdAt: { gte: today } } });
  return { pendingKOT };
};

const getSummary = async (restaurantId, tenantDb) => {
  const [orders, revenue, menu, users, tables, kitchen] = await Promise.all([
    getOrderSummary(restaurantId, tenantDb), getRevenueSummary(restaurantId, tenantDb),
    getMenuSummary(restaurantId, tenantDb), getUserSummary(restaurantId, tenantDb),
    getTableStatusSummary(restaurantId, tenantDb), getKitchenSummaryForDashboard(restaurantId, tenantDb)
  ]);
  return { ...orders, ...revenue, ...menu, ...users, occupiedTables: tables.OCCUPIED, availableTables: tables.AVAILABLE, reservedTables: tables.RESERVED, cleaningTables: tables.CLEANING, ...kitchen };
};

const getSalesSummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today, dateStr } = getISTBusinessDate();
  const monthStart = new Date(`${dateStr.slice(0, 7)}-01T00:00:00+05:30`);
  const billWhere = { ...whereRestaurant(restaurantId), status: "PAID", isCancelled: false };
  const paymentWhere = { ...whereRestaurant(restaurantId), createdAt: { gte: today }, status: "PAID" };
  const [todayBills, monthBills, cash, upi, card] = await Promise.all([
    prisma.bill.findMany({ where: { ...billWhere, createdAt: { gte: today } }, select: { grandTotal: true } }),
    prisma.bill.findMany({ where: { ...billWhere, createdAt: { gte: monthStart } }, select: { grandTotal: true } }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: { ...paymentWhere, paymentMethod: "CASH" } }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: { ...paymentWhere, paymentMethod: "UPI" } }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: { ...paymentWhere, paymentMethod: "CARD" } })
  ]);
  const sumBills = (list) => list.reduce((s, b) => s + Number(b.grandTotal || 0), 0);
  return { totalSales: sumBills(todayBills), monthlySales: sumBills(monthBills), cashSales: cash._sum.amount || 0, upiSales: upi._sum.amount || 0, cardSales: card._sum.amount || 0 };
};

const getTableSummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const bw = whereRestaurant(restaurantId);
  const [available, occupied, reserved, cleaning] = await Promise.all([
    prisma.restaurantTable.count({ where: { ...bw, status: "AVAILABLE" } }),
    prisma.restaurantTable.count({ where: { ...bw, status: "OCCUPIED" } }),
    prisma.restaurantTable.count({ where: { ...bw, status: "RESERVED" } }),
    prisma.restaurantTable.count({ where: { ...bw, status: "CLEANING" } })
  ]);
  return { available, occupied, reserved, cleaning };
};

const getKitchenSummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  const [totalKOT, todayKOT] = await Promise.all([
    prisma.kOT.count({ where: whereRestaurant(restaurantId) }),
    prisma.kOT.count({ where: { ...whereRestaurant(restaurantId), createdAt: { gte: today } } })
  ]);
  return { totalKOT, todayKOT };
};

const getPaymentSummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  const bw = { ...whereRestaurant(restaurantId), status: "PAID", createdAt: { gte: today } };
  const [cash, card, upi] = await Promise.all([
    prisma.payment.aggregate({ _sum: { amount: true }, where: { ...bw, paymentMethod: "CASH" } }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: { ...bw, paymentMethod: "CARD" } }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: { ...bw, paymentMethod: "UPI" } })
  ]);
  return { cash: cash._sum.amount || 0, card: card._sum.amount || 0, upi: upi._sum.amount || 0 };
};

const getRecentOrders = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  return await prisma.order.findMany({ where: { ...whereRestaurant(restaurantId), isDeleted: false, createdAt: { gte: today } }, take: 10, orderBy: { createdAt: "desc" }, include: { table: true, orderItems: { include: { menuItem: true } } } });
};

const getHourlySales = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  const payments = await prisma.payment.findMany({ where: { ...whereRestaurant(restaurantId), createdAt: { gte: today }, status: "PAID" }, select: { amount: true, createdAt: true } });
  const hourlyBuckets = Array.from({ length: 24 }, (_, i) => ({ hour: String(i).padStart(2, "0"), label: i === 0 ? "12AM" : i < 12 ? `${i}AM` : i === 12 ? "12PM" : `${i - 12}PM`, value: 0 }));
  payments.forEach((p) => { const h = new Date(p.createdAt).getHours(); if (h >= 0 && h < 24) hourlyBuckets[h].value += Number(p.amount) || 0; });
  hourlyBuckets.forEach((b) => { b.value = Math.round(b.value * 100) / 100; });
  return hourlyBuckets;
};

const getTopItems = async (restaurantId, since, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const of = { isDeleted: false, status: { notIn: ["CANCELLED"] } };
  if (restaurantId) of.restaurantId = restaurantId;
  if (since) of.createdAt = { gte: since };
  const topItems = await prisma.orderItem.groupBy({ by: ["menuItemId"], _sum: { quantity: true, total: true }, where: { order: of }, orderBy: { _sum: { quantity: "desc" } }, take: 10 });
  const menus = await prisma.menuItem.findMany({ where: { id: { in: topItems.map(item => item.menuItemId) } }, select: { id: true, name: true, image: true, price: true } });
  const menuMap = new Map(menus.map(m => [m.id, m]));
  return topItems.map(item => ({ id: item.menuItemId, name: menuMap.get(item.menuItemId)?.name, image: menuMap.get(item.menuItemId)?.image, price: menuMap.get(item.menuItemId)?.price, quantity: item._sum.quantity || 0, revenue: item._sum.total || 0 }));
};

const getCategorySales = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const categories = await prisma.category.findMany({ where: whereRestaurant(restaurantId), include: { menuItems: { include: { orderItems: { where: { order: { isDeleted: false, status: { notIn: ["CANCELLED"] } } } } } } } });
  return categories.map(category => { let quantity = 0, revenue = 0; category.menuItems.forEach(menu => { menu.orderItems.forEach(item => { quantity += item.quantity; revenue += item.total; }); }); return { id: category.id, category: category.name, quantity, revenue }; });
};

const getRecentPayments = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  return await prisma.payment.findMany({ where: { ...whereRestaurant(restaurantId), status: "PAID", createdAt: { gte: today } }, take: 10, orderBy: { createdAt: "desc" }, include: { bill: { select: { billNo: true, grandTotal: true } } } });
};

const getLiveOrders = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  return await prisma.order.findMany({ where: { ...whereRestaurant(restaurantId), status: { in: ["PENDING", "PREPARING", "READY"] }, isDeleted: false, createdAt: { gte: today } }, include: { table: { select: { tableNo: true } }, orderItems: { include: { menuItem: { select: { name: true } } } } }, orderBy: { createdAt: "asc" } });
};

const getInventorySummary = async (restaurantId, tenantDb) => {
  const prisma = tenantDb || platformPrisma;
  const { start: today } = getISTBusinessDate();
  const ct = { isDeleted: false, status: { notIn: ["CANCELLED"] }, completedAt: { gte: today } };
  const itemsSoldAgg = await prisma.orderItem.aggregate({ _sum: { quantity: true }, where: { order: { ...whereRestaurant(restaurantId), ...ct } } });
  const todayItems = await prisma.orderItem.findMany({ where: { order: { ...whereRestaurant(restaurantId), ...ct } }, select: { quantity: true, total: true, menuItem: { select: { id: true, name: true, category: { select: { id: true, name: true } } } } } });
  const itemAgg = {}, catAgg = {};
  todayItems.forEach((i) => { const qty = Number(i.quantity) || 0, rev = Number(i.total) || 0, mi = i.menuItem; if (!mi) return; if (!itemAgg[mi.id]) itemAgg[mi.id] = { name: mi.name, quantity: 0, revenue: 0 }; itemAgg[mi.id].quantity += qty; itemAgg[mi.id].revenue += rev; if (mi.category) { if (!catAgg[mi.category.id]) catAgg[mi.category.id] = { name: mi.category.name, quantity: 0, revenue: 0 }; catAgg[mi.category.id].quantity += qty; catAgg[mi.category.id].revenue += rev; } });
  const topItemList = Object.entries(itemAgg).sort((a, b) => b[1].quantity - a[1].quantity);
  const topCatList = Object.entries(catAgg).sort((a, b) => b[1].quantity - a[1].quantity);
  const lowStockItems = await prisma.menuItem.count({ where: { ...whereRestaurant(restaurantId), currentStock: { lt: 10 } } });
  return { itemsSoldToday: itemsSoldAgg._sum.quantity || 0, topSellingItem: topItemList[0] ? { menuItemId: Number(topItemList[0][0]), ...topItemList[0][1] } : null, topSellingCategory: topCatList[0] ? { categoryId: Number(topCatList[0][0]), ...topCatList[0][1] } : null, lowStockItems };
};

const getStaffDashboard = async (restaurantId, tenantDb) => {
  const result = { ADMIN: 0, MANAGER: 0, CASHIER: 0, WAITER: 0, KITCHEN: 0 };
  if (restaurantId) { try { result.ADMIN = await platformPrisma.user.count({ where: { restaurantId, role: "ADMIN", isActive: true, deletedAt: null } }); } catch (err) { /* ignore */ } }
  if (tenantDb) {
    try {
      const users = await tenantDb.user.groupBy({ by: ["role"], _count: { role: true }, where: { isActive: true } });
      users.forEach(user => { if (result[user.role] !== undefined) result[user.role] = user._count.role; });
    } catch (err) { console.warn("[Dashboard] Could not count tenant staff:", err.message); }
  }
  return { admins: result.ADMIN, managers: result.MANAGER, cashiers: result.CASHIER, waiters: result.WAITER, kitchen: result.KITCHEN, total: result.ADMIN + result.MANAGER + result.CASHIER + result.WAITER + result.KITCHEN };
};

const getDashboard = async (restaurantId, tenantDb) => {
  const { start: today } = getISTBusinessDate();
  const [summary, sales, tables, kitchen, payments, recentOrders, topItems, categorySales, recentPayments, liveOrders, staff, inventory, hourlySales] = await Promise.all([
    getSummary(restaurantId, tenantDb), getSalesSummary(restaurantId, tenantDb), getTableSummary(restaurantId, tenantDb), getKitchenSummary(restaurantId, tenantDb),
    getPaymentSummary(restaurantId, tenantDb), getRecentOrders(restaurantId, tenantDb), getTopItems(restaurantId, today, tenantDb), getCategorySales(restaurantId, tenantDb),
    getRecentPayments(restaurantId, tenantDb), getLiveOrders(restaurantId, tenantDb), getStaffDashboard(restaurantId, tenantDb), getInventorySummary(restaurantId, tenantDb), getHourlySales(restaurantId, tenantDb)
  ]);
  return { summary, sales, tables, kitchen, payments, recentOrders, topItems, categorySales, recentPayments, liveOrders, staff, inventory, hourlySales };
};

module.exports = { getSummary, getSalesSummary, getTableSummary, getKitchenSummary, getPaymentSummary, getRecentOrders, getTopItems, getCategorySales, getRecentPayments, getLiveOrders, getStaffDashboard, getHourlySales, getInventorySummary, getDashboard };
