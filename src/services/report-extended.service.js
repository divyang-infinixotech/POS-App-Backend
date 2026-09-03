const { platformPrisma } = require("../config/tenantPrisma");

// ── Shared date-range helper (same logic as report.service.js) ──
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function toDateFilterValue(value, isEndOfDay) {
  if (!value) return null;
  if (DATE_ONLY.test(String(value))) {
    const local = `${value}${isEndOfDay ? "T23:59:59.999" : "T00:00:00.000"}+05:30`;
    const d = new Date(local);
    return Number.isNaN(d.getTime()) ? new Date(value) : d;
  }
  const d = new Date(value);
  if (isEndOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

function dateWhere(restaurantId, from, to, dateField = "createdAt") {
  const where = {};
  if (restaurantId) where.restaurantId = restaurantId;
  const gte = toDateFilterValue(from, false);
  const lte = toDateFilterValue(to, true);
  if (gte || lte) {
    const dateFilter = {};
    if (gte) dateFilter.gte = gte;
    if (lte) dateFilter.lte = lte;
    where[dateField] = dateFilter;
  }
  return where;
}

// ══════════════════════════════════════════════════════════════
// 1. HOURLY SALES REPORT
// ══════════════════════════════════════════════════════════════
const getHourlySalesReport = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  const billWhere = dateWhere(restaurantId, from, to, "createdAt");
  billWhere.isCancelled = false;
  billWhere.status = "PAID";

  const bills = await prisma.bill.findMany({
    where: billWhere,
    select: { grandTotal: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  // Build all 24 hours
  const hourMap = {};
  for (let i = 0; i < 24; i++) {
    hourMap[i] = { hour: i, label: `${String(i).padStart(2, "0")}:00`, sales: 0, orders: 0 };
  }

  bills.forEach((b) => {
    const d = new Date(b.createdAt);
    const h = d.getHours();
    hourMap[h].sales += Number(b.grandTotal || 0);
    hourMap[h].orders += 1;
  });

  const hours = Object.values(hourMap);
  const totalSales = hours.reduce((s, h) => s + h.sales, 0);
  const totalOrders = hours.reduce((s, h) => s + h.orders, 0);
  const peakHour = hours.reduce((max, h) => h.sales > max.sales ? h : max, hours[0]);
  const lowHour = hours.reduce((min, h) => (h.sales < min.sales && h.sales > 0 ? h : min), { sales: Infinity });

  return {
    hours,
    summary: {
      totalSales,
      totalOrders,
      peakHour: peakHour.sales > 0 ? { hour: peakHour.hour, label: peakHour.label, sales: peakHour.sales, orders: peakHour.orders } : null,
      lowestHour: lowHour.sales < Infinity ? { hour: lowHour.hour, label: lowHour.label, sales: lowHour.sales, orders: lowHour.orders } : null,
    },
  };
};

// ══════════════════════════════════════════════════════════════
// 2. SALES COMPARISON REPORT
// ══════════════════════════════════════════════════════════════
const getSalesComparisonReport = async (restaurantId, from, to, prevFrom, prevTo, db) => {
    const prisma = db || platformPrisma;
  const buildSummary = async (f, t) => {
    const billWhere = dateWhere(restaurantId, f, t, "createdAt");
    billWhere.isCancelled = false;
    billWhere.status = "PAID";
    const bills = await prisma.bill.findMany({
      where: billWhere,
      select: { grandTotal: true, taxAmount: true, discount: true, createdAt: true },
    });

    const orderWhere = dateWhere(restaurantId, f, t, "createdAt");
    orderWhere.isDeleted = false;
    const totalOrders = await prisma.order.count({ where: orderWhere });

    const completedWhere = { ...orderWhere, status: "COMPLETED" };
    const completedOrders = await prisma.order.count({ where: completedWhere });

    let totalItemsSold = 0;
    if (bills.length > 0) {
      const orderIds = [...new Set(bills.map((_, i) => i))]; // we need order IDs
      // Get items from bills' orders
      const billOrders = await prisma.bill.findMany({
        where: billWhere,
        select: {
          orderId: true,
          grandTotal: true,
          taxAmount: true,
          discount: true,
          order: {
            select: {
              orderItems: { select: { quantity: true, total: true } },
            },
          },
        },
      });
      billOrders.forEach((b) => {
        (b.order?.orderItems || []).forEach((oi) => {
          totalItemsSold += oi.quantity || 0;
        });
      });
    }

    const totalSales = bills.reduce((s, b) => s + Number(b.grandTotal || 0), 0);
    const totalTax = bills.reduce((s, b) => s + Number(b.taxAmount || 0), 0);
    const totalDiscount = bills.reduce((s, b) => s + Number(b.discount || 0), 0);

    // AOV uses paid-bill count as denominator (same population as totalSales)
    // to keep numerator and denominator consistent. This matches the Sales
    // Report definition: totalSales / paidBills.length.
    return {
      totalSales,
      totalOrders,
      completedOrders,
      totalItemsSold,
      averageOrderValue: bills.length > 0 ? totalSales / bills.length : 0,
      totalTax,
      totalDiscount,
      netRevenue: totalSales,
    };
  };

  const [current, previous] = await Promise.all([
    buildSummary(from, to),
    buildSummary(prevFrom, prevTo),
  ]);

  const calcChange = (curr, prev) => {
    if (!prev || prev === 0) return null;
    return Math.round(((curr - prev) / prev) * 1000) / 10;
  };

  return {
    current,
    previous,
    comparison: {
      totalSales: { current: current.totalSales, previous: previous.totalSales, change: calcChange(current.totalSales, previous.totalSales) },
      totalOrders: { current: current.totalOrders, previous: previous.totalOrders, change: calcChange(current.totalOrders, previous.totalOrders) },
      averageOrderValue: { current: current.averageOrderValue, previous: previous.averageOrderValue, change: calcChange(current.averageOrderValue, previous.averageOrderValue) },
      totalItemsSold: { current: current.totalItemsSold, previous: previous.totalItemsSold, change: calcChange(current.totalItemsSold, previous.totalItemsSold) },
      totalDiscount: { current: current.totalDiscount, previous: previous.totalDiscount, change: calcChange(current.totalDiscount, previous.totalDiscount) },
      netRevenue: { current: current.netRevenue, previous: previous.netRevenue, change: calcChange(current.netRevenue, previous.netRevenue) },
    },
  };
};

// ══════════════════════════════════════════════════════════════
// 3. DISCOUNT REPORT
// ══════════════════════════════════════════════════════════════
const getDiscountReport = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  const billWhere = dateWhere(restaurantId, from, to, "createdAt");
  billWhere.isCancelled = false;
  billWhere.status = "PAID";
  billWhere.discount = { gt: 0 };

  const discountedBills = await prisma.bill.findMany({
    where: billWhere,
    include: {
      order: {
        select: { orderNo: true, orderType: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // All paid bills for total sales context
  const allBillWhere = dateWhere(restaurantId, from, to, "createdAt");
  allBillWhere.isCancelled = false;
  allBillWhere.status = "PAID";
  const allBills = await prisma.bill.findMany({
    where: allBillWhere,
    select: { grandTotal: true, discount: true },
  });

  const totalSalesBeforeDiscount = allBills.reduce((s, b) => s + Number(b.grandTotal || 0), 0);
  const totalDiscount = allBills.reduce((s, b) => s + Number(b.discount || 0), 0);
  const totalSalesAfterDiscount = totalSalesBeforeDiscount;

  // Aggregate discount types
  const discountByType = {};
  discountedBills.forEach((b) => {
    const type = b.discountType || "FLAT";
    if (!discountByType[type]) discountByType[type] = { count: 0, amount: 0 };
    discountByType[type].count += 1;
    discountByType[type].amount += Number(b.discount || 0);
  });

  return {
    summary: {
      totalDiscountedOrders: discountedBills.length,
      totalOrders: allBills.length,
      totalDiscount,
      averageDiscount: discountedBills.length > 0 ? totalDiscount / discountedBills.length : 0,
      discountPercentage: totalSalesBeforeDiscount > 0 ? (totalDiscount / totalSalesBeforeDiscount) * 100 : 0,
      salesBeforeDiscount: totalSalesBeforeDiscount,
      salesAfterDiscount: totalSalesAfterDiscount,
    },
    discountByType,
    bills: discountedBills,
  };
};

// ══════════════════════════════════════════════════════════════
// 4. CANCELLATION REPORT
// ══════════════════════════════════════════════════════════════
const getCancellationReport = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  const orderWhere = dateWhere(restaurantId, from, to, "createdAt");
  orderWhere.status = "CANCELLED";
  orderWhere.isDeleted = false;

  const cancelledOrders = await prisma.order.findMany({
    where: orderWhere,
    include: {
      customer: { select: { name: true } },
      table: { select: { tableNo: true } },
      orderItems: { select: { quantity: true, total: true } },
    },
    orderBy: { cancelledAt: "desc" },
  });

  const totalCancelledValue = cancelledOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0);

  // All orders for context
  const allOrderWhere = dateWhere(restaurantId, from, to, "createdAt");
  allOrderWhere.isDeleted = false;
  const totalOrders = await prisma.order.count({ where: allOrderWhere });

  const cancelledByUser = {};
  cancelledOrders.forEach((o) => {
    // We don't have a direct "cancelledBy" field on Order, but we have cancelReason
    const key = o.cancelReason || "Unknown Reason";
    if (!cancelledByUser[key]) cancelledByUser[key] = { count: 0, value: 0 };
    cancelledByUser[key].count += 1;
    cancelledByUser[key].value += Number(o.totalAmount || 0);
  });

  return {
    summary: {
      totalCancelled: cancelledOrders.length,
      totalOrders,
      cancellationRate: totalOrders > 0 ? (cancelledOrders.length / totalOrders) * 100 : 0,
      totalCancelledValue,
      averageCancelledValue: cancelledOrders.length > 0 ? totalCancelledValue / cancelledOrders.length : 0,
    },
    byReason: cancelledByUser,
    orders: cancelledOrders,
  };
};

// ══════════════════════════════════════════════════════════════
// 5. KOT REPORTS
// ══════════════════════════════════════════════════════════════
const getKotRegister = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  const kotWhere = dateWhere(restaurantId, from, to, "createdAt");

  const kots = await prisma.kOT.findMany({
    where: kotWhere,
    include: {
      order: {
        select: {
          orderNo: true,
          orderType: true,
          table: { select: { tableNo: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Calculate preparation times where timestamps exist
  const kotsWithTimes = kots.map((k) => {
    let prepTime = null;
    if (k.preparingAt && k.readyAt) {
      prepTime = (new Date(k.readyAt).getTime() - new Date(k.preparingAt).getTime()) / 1000 / 60; // minutes
    }

    return {
      id: k.id,
      kotNo: k.kotNo,
      status: k.status,
      orderNo: k.order?.orderNo || null,
      orderType: k.order?.orderType || null,
      tableNo: k.order?.table?.tableNo || null,
      createdAt: k.createdAt,
      acceptedAt: k.acceptedAt,
      preparingAt: k.preparingAt,
      readyAt: k.readyAt,
      servedAt: k.servedAt,
      cancelledAt: k.cancelledAt,
      printCount: k.printCount,
      cancelReason: k.cancelReason,
      prepTimeMinutes: prepTime !== null ? Math.round(prepTime * 10) / 10 : null,
    };
  });

  return { kots: kotsWithTimes };
};

const getKotSummary = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  const kotWhere = dateWhere(restaurantId, from, to, "createdAt");

  const [totalKots, statusGroups] = await Promise.all([
    prisma.kOT.count({ where: kotWhere }),
    prisma.kOT.groupBy({ by: ["status"], where: kotWhere, _count: { _all: true } }),
  ]);

  const statusCount = {};
  statusGroups.forEach((g) => { statusCount[g.status] = g._count._all; });

  // Average preparation time from KOTs that have both preparingAt and readyAt
  const completedKots = await prisma.kOT.findMany({
    where: { ...kotWhere, preparingAt: { not: null }, readyAt: { not: null } },
    select: { preparingAt: true, readyAt: true },
  });

  let avgPrepTime = null;
  let fastestPrepTime = null;
  let slowestPrepTime = null;

  if (completedKots.length > 0) {
    const times = completedKots.map((k) => {
      return (new Date(k.readyAt).getTime() - new Date(k.preparingAt).getTime()) / 1000 / 60;
    });
    avgPrepTime = times.reduce((s, t) => s + t, 0) / times.length;
    fastestPrepTime = Math.min(...times);
    slowestPrepTime = Math.max(...times);
  }

  return {
    summary: {
      totalKots,
      completed: statusCount.READY || 0,
      pending: statusCount.PENDING || 0,
      preparing: statusCount.PREPARING || 0,
      served: statusCount.SERVED || 0,
      cancelled: statusCount.CANCELLED || 0,
      accepted: statusCount.ACCEPTED || 0,
      averagePrepTimeMinutes: avgPrepTime !== null ? Math.round(avgPrepTime * 10) / 10 : null,
      fastestPrepTimeMinutes: fastestPrepTime !== null ? Math.round(fastestPrepTime * 10) / 10 : null,
      slowestPrepTimeMinutes: slowestPrepTime !== null ? Math.round(slowestPrepTime * 10) / 10 : null,
    },
  };
};

const getKitchenPerformance = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  const kotWhere = dateWhere(restaurantId, from, to, "createdAt");

  // Hourly KOT volume
  const allKots = await prisma.kOT.findMany({
    where: kotWhere,
    select: { createdAt: true, status: true, preparingAt: true, readyAt: true },
    orderBy: { createdAt: "asc" },
  });

  const hourlyVolume = {};
  for (let i = 0; i < 24; i++) {
    hourlyVolume[i] = { hour: i, label: `${String(i).padStart(2, "0")}:00`, total: 0, completed: 0, cancelled: 0 };
  }

  allKots.forEach((k) => {
    const h = new Date(k.createdAt).getHours();
    hourlyVolume[h].total += 1;
    if (k.status === "READY" || k.status === "SERVED") hourlyVolume[h].completed += 1;
    if (k.status === "CANCELLED") hourlyVolume[h].cancelled += 1;
  });

  // Prep times for completed KOTs
  const completedKots = allKots.filter((k) => k.preparingAt && k.readyAt);
  const prepTimes = completedKots.map((k) =>
    (new Date(k.readyAt).getTime() - new Date(k.preparingAt).getTime()) / 1000 / 60
  );

  const totalKots = allKots.length;
  const completedCount = allKots.filter((k) => k.status === "READY" || k.status === "SERVED").length;
  const cancelledCount = allKots.filter((k) => k.status === "CANCELLED").length;

  return {
    hourlyVolume: Object.values(hourlyVolume),
    summary: {
      totalKots,
      completedKots: completedCount,
      cancelledKots: cancelledCount,
      cancellationRate: totalKots > 0 ? (cancelledCount / totalKots) * 100 : 0,
      averagePrepTimeMinutes: prepTimes.length > 0 ? Math.round((prepTimes.reduce((s, t) => s + t, 0) / prepTimes.length) * 10) / 10 : null,
      delayedKots: prepTimes.filter((t) => t > 30).length, // > 30 min as "delayed"
    },
  };
};

// ══════════════════════════════════════════════════════════════
// 6. MENU PERFORMANCE REPORTS
// ══════════════════════════════════════════════════════════════
const getMenuPerformance = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  // Get all menu items for the restaurant
  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId },
    select: {
      id: true, name: true, price: true, image: true,
      category: { select: { id: true, name: true } },
    },
  });

  // Get sold items from PAID bills
  const billWhere = dateWhere(restaurantId, from, to, "createdAt");
  billWhere.isCancelled = false;
  billWhere.status = "PAID";

  const bills = await prisma.bill.findMany({
    where: billWhere,
    select: { id: true, orderId: true },
  });

  if (bills.length === 0) {
    return menuItems.map((mi) => ({
      menuItemId: mi.id,
      itemName: mi.name,
      currentPrice: mi.price,
      image: mi.image,
      category: mi.category?.name || "Uncategorized",
      categoryId: mi.category?.id || null,
      quantitySold: 0,
      revenue: 0,
      orderCount: 0,
      averageSellingPrice: 0,
      contributionPercentage: 0,
    }));
  }

  const orderIds = [...new Set(bills.map((b) => b.orderId))];
  const orderItems = await prisma.orderItem.findMany({
    where: { orderId: { in: orderIds } },
    select: {
      quantity: true, total: true, menuItemId: true,
      menuItem: { select: { id: true, name: true, image: true, category: { select: { id: true, name: true } } } },
    },
  });

  const agg = {};
  orderItems.forEach((oi) => {
    const id = oi.menuItemId;
    if (!agg[id]) agg[id] = { quantitySold: 0, revenue: 0, orderIds: new Set() };
    agg[id].quantitySold += oi.quantity || 0;
    agg[id].revenue += Number(oi.total || 0);
    agg[id].orderIds.add(oi.orderId);
  });

  const totalRevenue = Object.values(agg).reduce((s, a) => s + a.revenue, 0);

  const performance = menuItems.map((mi) => {
    const a = agg[mi.id] || { quantitySold: 0, revenue: 0, orderIds: new Set() };
    return {
      menuItemId: mi.id,
      itemName: mi.name,
      currentPrice: mi.price,
      image: mi.image,
      category: mi.category?.name || "Uncategorized",
      categoryId: mi.category?.id || null,
      quantitySold: a.quantitySold,
      revenue: a.revenue,
      orderCount: a.orderIds?.size || 0,
      averageSellingPrice: a.quantitySold > 0 ? Math.round((a.revenue / a.quantitySold) * 100) / 100 : 0,
      contributionPercentage: totalRevenue > 0 ? Math.round((a.revenue / totalRevenue) * 1000) / 10 : 0,
    };
  });

  return performance.sort((a, b) => b.quantitySold - a.quantitySold);
};

const getTopSellingItems = async (restaurantId, from, to, sortBy = "quantity", db) => {
  const items = await getMenuPerformance(restaurantId, from, to, db);
  const sorted = items.filter((i) => i.quantitySold > 0).sort((a, b) => {
    return sortBy === "revenue" ? b.revenue - a.revenue : b.quantitySold - a.quantitySold;
  });
  return { items: sorted, sortBy };
};

const getLowSellingItems = async (restaurantId, from, to, threshold = 5, db) => {
  const items = await getMenuPerformance(restaurantId, from, to, db);
  // Items with quantity sold <= threshold
  const lowItems = items.filter((i) => i.quantitySold > 0 && i.quantitySold <= threshold)
    .sort((a, b) => a.quantitySold - b.quantitySold);
  return { items: lowItems, threshold };
};

const getCategoryPerformance = async (restaurantId, from, to, db) => {
  const items = await getMenuPerformance(restaurantId, from, to, db);

  const catAgg = {};
  items.forEach((i) => {
    const catId = i.categoryId || "uncategorized";
    if (!catAgg[catId]) catAgg[catId] = { categoryId: i.categoryId, categoryName: i.category, quantitySold: 0, revenue: 0, orderCount: 0, itemCount: new Set() };
    catAgg[catId].quantitySold += i.quantitySold;
    catAgg[catId].revenue += i.revenue;
    catAgg[catId].orderCount += i.orderCount;
    catAgg[catId].itemCount.add(i.menuItemId);
  });

  const totalRevenue = Object.values(catAgg).reduce((s, c) => s + c.revenue, 0);

  return Object.values(catAgg)
    .map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      quantitySold: c.quantitySold,
      revenue: c.revenue,
      orderCount: c.orderCount,
      itemCount: c.itemCount.size,
      contributionPercentage: totalRevenue > 0 ? Math.round((c.revenue / totalRevenue) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
};

// ══════════════════════════════════════════════════════════════
// 7. TABLE REPORTS
// ══════════════════════════════════════════════════════════════
const getTableSales = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  const orderWhere = dateWhere(restaurantId, from, to, "createdAt");
  orderWhere.isDeleted = false;
  orderWhere.tableId = { not: null };

  const orders = await prisma.order.findMany({
    where: orderWhere,
    select: {
      tableId: true, totalAmount: true, createdAt: true, completedAt: true,
      table: { select: { id: true, tableNo: true, floor: { select: { name: true } } } },
      bill: { select: { grandTotal: true, status: true } },
    },
  });

  const tableAgg = {};
  orders.forEach((o) => {
    const tId = o.tableId;
    if (!tId || !o.table) return;
    if (!tableAgg[tId]) {
      tableAgg[tId] = {
        tableId: tId,
        tableNo: o.table.tableNo,
        floorName: o.table.floor?.name || "—",
        orderCount: 0,
        totalSales: 0,
        completedOrders: 0,
      };
    }
    tableAgg[tId].orderCount += 1;
    tableAgg[tId].totalSales += Number(o.bill?.grandTotal || o.totalAmount || 0);
    if (o.completedAt) tableAgg[tId].completedOrders += 1;
  });

  return Object.values(tableAgg)
    .map((t) => ({
      ...t,
      averageBill: t.orderCount > 0 ? Math.round((t.totalSales / t.orderCount) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.totalSales - a.totalSales);
};

const getTableOccupancy = async (restaurantId, db) => {
    const prisma = db || platformPrisma;
  const tables = await prisma.restaurantTable.findMany({
    where: { restaurantId },
    select: {
      id: true, tableNo: true, status: true, capacity: true,
      floor: { select: { name: true } },
    },
    orderBy: { tableNo: "asc" },
  });

  const summary = {
    total: tables.length,
    available: tables.filter((t) => t.status === "AVAILABLE").length,
    occupied: tables.filter((t) => t.status === "OCCUPIED").length,
    reserved: tables.filter((t) => t.status === "RESERVED").length,
    cleaning: tables.filter((t) => t.status === "CLEANING").length,
  };

  return {
    summary,
    tables: tables.map((t) => ({
      id: t.id,
      tableNo: t.tableNo,
      status: t.status,
      capacity: t.capacity,
      floorName: t.floor?.name || "—",
    })),
  };
};

// ══════════════════════════════════════════════════════════════
// 8. STAFF REPORTS
// ══════════════════════════════════════════════════════════════
const getStaffSales = async (restaurantId, from, to, db) => {
  // ── Staff users (MANAGER/CASHIER/KITCHEN/WAITER) live in the TENANT schema. ──
  const tenantPrisma = db || platformPrisma;
  // Inside a tenant schema every User row already belongs to this restaurant, but
  // the tenant User.restaurantId column is NULL for migrated staff. Filter by
  // restaurantId only when reading the legacy public store (SUPER_ADMIN fallback
  // without a tenant db), where the column is populated.
  const staffWhere = db
    ? { isActive: true, deletedAt: null }
    : { restaurantId, isActive: true, deletedAt: null };
  const staff = await tenantPrisma.user.findMany({
    where: staffWhere,
    select: { id: true, name: true, email: true, role: true },
  });

  if (!staff || staff.length === 0) return [];

  // ── Audit logs also live in the tenant schema. ──
  const auditWhere = dateWhere(restaurantId, from, to, "createdAt");
  auditWhere.module = "ORDER";
  auditWhere.action = "CREATE";

  const orderAudits = await tenantPrisma.auditLog.findMany({
    where: auditWhere,
    select: { userId: true, referenceId: true, createdAt: true },
  });

  // Group orders by staff
  const staffOrders = {};
  orderAudits.forEach((a) => {
    if (!a.userId) return;
    if (!staffOrders[a.userId]) staffOrders[a.userId] = new Set();
    if (a.referenceId) staffOrders[a.userId].add(a.referenceId);
  });

  const staffSales = [];
  for (const s of staff) {
    const orderIds = [...(staffOrders[s.id] || [])];
    let totalSales = 0;
    let orderCount = orderIds.length;

    if (orderIds.length > 0) {
      const billWhere = { orderId: { in: orderIds }, isCancelled: false, status: "PAID" };
      const bills = await tenantPrisma.bill.findMany({ where: billWhere, select: { grandTotal: true } });
      totalSales = bills.reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);
    }

    staffSales.push({
      staffId: s.id,
      name: s.name,
      role: s.role,
      orders: orderCount,
      totalSales,
      averageOrder: orderCount > 0 ? Math.round((totalSales / orderCount) * 100) / 100 : 0,
    });
  }

  return staffSales.sort((a, b) => b.totalSales - a.totalSales);
};

const getStaffActivity = async (restaurantId, from, to, db) => {
  // AuditLog and User live in the TENANT schema after staff migration.
  const tenantPrisma = db || platformPrisma;
  const auditWhere = dateWhere(restaurantId, from, to, "createdAt");
  auditWhere.userId = { not: null };

  const audits = await tenantPrisma.auditLog.findMany({
    where: auditWhere,
    include: { user: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // Group by staff
  const staffActivity = {};
  audits.forEach((a) => {
    const uid = a.userId;
    if (!uid || !a.user) return;
    if (!staffActivity[uid]) {
      staffActivity[uid] = { staffId: uid, name: a.user.name, role: a.user.role, actions: {} };
    }
    const key = `${a.module}:${a.action}`;
    if (!staffActivity[uid].actions[key]) staffActivity[uid].actions[key] = 0;
    staffActivity[uid].actions[key] += 1;
  });

  return Object.values(staffActivity);
};

const getStaffDiscountCancellation = async (restaurantId, from, to, db) => {
  const tenantPrisma = db || platformPrisma;
  // Bills with discounts — track who discounted (Bill is a tenant table)
  const billWhere = dateWhere(restaurantId, from, to, "createdAt");
  billWhere.isCancelled = false;
  billWhere.discount = { gt: 0 };
  billWhere.discountedBy = { not: null };

  const discountedBills = await tenantPrisma.bill.findMany({
    where: billWhere,
    select: { id: true, discount: true, discountedBy: true, createdAt: true },
  });

  // Cancelled orders — from audit logs (AuditLog is in the TENANT schema after migration)
  const cancelAudits = await (db || platformPrisma).auditLog.findMany({
    where: {
      ...dateWhere(restaurantId, from, to, "createdAt"),
      module: "ORDER",
      action: "CANCEL",
      userId: { not: null },
    },
    select: { userId: true, user: { select: { id: true, name: true, role: true } } },
  });

  // Aggregate discounts by staff
  const staffDiscounts = {};
  discountedBills.forEach((b) => {
    const uid = b.discountedBy;
    if (!staffDiscounts[uid]) staffDiscounts[uid] = { staffId: uid, name: "", discountCount: 0, totalDiscount: 0 };
    staffDiscounts[uid].discountCount += 1;
    staffDiscounts[uid].totalDiscount += Number(b.discount || 0);
  });

  // Enrich with names — User lives in the TENANT schema after staff migration.
  const staffPrisma = db || platformPrisma;
  for (const uid of Object.keys(staffDiscounts)) {
    const user = await staffPrisma.user.findUnique({ where: { id: Number(uid) }, select: { name: true, role: true } });
    if (user) {
      staffDiscounts[uid].name = user.name;
      staffDiscounts[uid].role = user.role;
    }
  }

  // Aggregate cancellations by staff
  const staffCancellations = {};
  cancelAudits.forEach((a) => {
    const uid = a.userId;
    if (!staffCancellations[uid]) staffCancellations[uid] = { staffId: uid, name: a.user?.name || "", role: a.user?.role || "", cancelCount: 0 };
    staffCancellations[uid].cancelCount += 1;
  });

  return {
    discounts: Object.values(staffDiscounts).sort((a, b) => b.totalDiscount - a.totalDiscount),
    cancellations: Object.values(staffCancellations).sort((a, b) => b.cancelCount - a.cancelCount),
  };
};

// ══════════════════════════════════════════════════════════════
// 9. MANAGEMENT REPORTS
// ══════════════════════════════════════════════════════════════
const getDailyClosing = async (restaurantId, date, db) => {
    const prisma = db || platformPrisma;
  // Determine business date in IST
  let reportDate;
  if (date && DATE_ONLY.test(String(date))) {
    reportDate = toDateFilterValue(date, false);
  } else if (date) {
    reportDate = new Date(date);
  } else {
    reportDate = new Date();
  }

  // Build IST-based start/end for the business day
  const dateStr = DATE_ONLY.test(String(date))
    ? date
    : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(reportDate);
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  const end = new Date(`${dateStr}T23:59:59.999+05:30`);

  const buildWhere = () => {
    const w = { createdAt: { gte: start, lte: end } };
    if (restaurantId) w.restaurantId = restaurantId;
    return w;
  };

  // Revenue section
  const billWhere = { ...buildWhere(), isCancelled: false, status: "PAID" };
  const bills = await prisma.bill.findMany({ where: billWhere });

  let grossSales = 0, totalTax = 0, totalDiscount = 0, totalServiceCharge = 0, totalRoundOff = 0;
  bills.forEach((b) => {
    grossSales += Number(b.grandTotal || 0);
    totalTax += Number(b.taxAmount || 0);
    totalDiscount += Number(b.discount || 0);
    totalServiceCharge += Number(b.serviceCharge || 0);
    totalRoundOff += Number(b.roundOff || 0);
  });

  // Orders section
  const orderWhere = { ...buildWhere(), isDeleted: false };
  const allOrders = await prisma.order.findMany({ where: orderWhere, select: { status: true } });
  const orderSummary = { total: allOrders.length, completed: 0, pending: 0, cancelled: 0 };
  allOrders.forEach((o) => {
    if (o.status === "COMPLETED") orderSummary.completed += 1;
    if (o.status === "CANCELLED") orderSummary.cancelled += 1;
    if (["PENDING", "PREPARING", "READY"].includes(o.status)) orderSummary.pending += 1;
  });

  // Payments section
  const paymentWhere = { ...buildWhere(), status: "PAID" };
  const payments = await prisma.payment.findMany({ where: paymentWhere, select: { paymentMethod: true, amount: true } });
  const paymentSummary = {};
  payments.forEach((p) => {
    const method = p.paymentMethod || "OTHER";
    if (!paymentSummary[method]) paymentSummary[method] = 0;
    paymentSummary[method] += Number(p.amount);
  });

  // Kitchen section
  const kotWhere = buildWhere();
  const [totalKots, kotStatusGroups] = await Promise.all([
    prisma.kOT.count({ where: kotWhere }),
    prisma.kOT.groupBy({ by: ["status"], where: kotWhere, _count: { _all: true } }),
  ]);
  const kotStatus = {};
  kotStatusGroups.forEach((g) => { kotStatus[g.status] = g._count._all; });

  // Top items
  const orderIds = [...new Set(bills.map((b) => b.orderId))];
  let topItems = [];
  if (orderIds.length > 0) {
    const orderItems = await prisma.orderItem.findMany({
      where: { orderId: { in: orderIds } },
      select: { quantity: true, total: true, menuItem: { select: { name: true } } },
    });
    const itemAgg = {};
    orderItems.forEach((oi) => {
      const name = oi.menuItem?.name || "Unknown";
      if (!itemAgg[name]) itemAgg[name] = { name, quantity: 0, revenue: 0 };
      itemAgg[name].quantity += oi.quantity || 0;
      itemAgg[name].revenue += Number(oi.total || 0);
    });
    topItems = Object.values(itemAgg).sort((a, b) => b.quantity - a.quantity).slice(0, 10);
  }

  return {
    date: dateStr,
    revenue: {
      grossSales,
      totalTax,
      totalDiscount,
      totalServiceCharge,
      totalRoundOff,
      netSales: grossSales,
      totalBills: bills.length,
      averageBillValue: bills.length > 0 ? grossSales / bills.length : 0,
    },
    orders: orderSummary,
    payments: paymentSummary,
    kitchen: {
      totalKots,
      completed: (kotStatus.READY || 0) + (kotStatus.SERVED || 0),
      pending: kotStatus.PENDING || 0,
      preparing: kotStatus.PREPARING || 0,
      cancelled: kotStatus.CANCELLED || 0,
    },
    topItems,
  };
};

const getMonthlySummary = async (restaurantId, from, to, db) => {
    const prisma = db || platformPrisma;
  const billWhere = dateWhere(restaurantId, from, to, "createdAt");
  billWhere.isCancelled = false;
  billWhere.status = "PAID";

  const bills = await prisma.bill.findMany({
    where: billWhere,
    select: { grandTotal: true, taxAmount: true, discount: true, serviceCharge: true, createdAt: true, orderId: true },
  });

  const orderWhere = dateWhere(restaurantId, from, to, "createdAt");
  orderWhere.isDeleted = false;
  const allOrders = await prisma.order.findMany({
    where: orderWhere,
    select: { id: true, status: true, totalAmount: true, createdAt: true },
  });

  const cancelledCount = allOrders.filter((o) => o.status === "CANCELLED").length;
  const completedCount = allOrders.filter((o) => o.status === "COMPLETED").length;

  // Items sold
  const billOrderIds = [...new Set(bills.map((b) => b.orderId))];
  let totalItemsSold = 0;
  let topItems = [];
  let topCategories = [];

  if (billOrderIds.length > 0) {
    const orderItems = await prisma.orderItem.findMany({
      where: { orderId: { in: billOrderIds } },
      select: { quantity: true, total: true, menuItem: { select: { id: true, name: true, category: { select: { id: true, name: true } } } } },
    });

    const itemAgg = {};
    const catAgg = {};
    orderItems.forEach((oi) => {
      totalItemsSold += oi.quantity || 0;
      const name = oi.menuItem?.name || "Unknown";
      if (!itemAgg[name]) itemAgg[name] = { name, quantity: 0, revenue: 0 };
      itemAgg[name].quantity += oi.quantity || 0;
      itemAgg[name].revenue += Number(oi.total || 0);

      if (oi.menuItem?.category) {
        const catName = oi.menuItem.category.name;
        if (!catAgg[catName]) catAgg[catName] = { name: catName, quantity: 0, revenue: 0 };
        catAgg[catName].quantity += oi.quantity || 0;
        catAgg[catName].revenue += Number(oi.total || 0);
      }
    });

    topItems = Object.values(itemAgg).sort((a, b) => b.quantity - a.quantity).slice(0, 10);
    topCategories = Object.values(catAgg).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  }

  // Payment distribution
  const paymentWhere = dateWhere(restaurantId, from, to, "createdAt");
  paymentWhere.status = "PAID";
  const payments = await prisma.payment.findMany({ where: paymentWhere, select: { paymentMethod: true, amount: true } });
  const paymentDist = {};
  payments.forEach((p) => {
    const method = p.paymentMethod || "OTHER";
    if (!paymentDist[method]) paymentDist[method] = 0;
    paymentDist[method] += Number(p.amount);
  });

  // Hourly distribution
  const hourlySales = {};
  for (let i = 0; i < 24; i++) hourlySales[i] = 0;
  bills.forEach((b) => {
    const h = new Date(b.createdAt).getHours();
    hourlySales[h] += Number(b.grandTotal || 0);
  });

  const totalSales = bills.reduce((s, b) => s + Number(b.grandTotal || 0), 0);
  const totalTax = bills.reduce((s, b) => s + Number(b.taxAmount || 0), 0);
  const totalDiscount = bills.reduce((s, b) => s + Number(b.discount || 0), 0);

  return {
    summary: {
      totalSales,
      totalOrders: allOrders.length,
      completedOrders: completedCount,
      cancelledOrders: cancelledCount,
      totalItemsSold,
      // AOV: totalSales / paid bills count (consistent with Sales Report)
      averageOrderValue: bills.length > 0 ? totalSales / bills.length : 0,
      totalTax,
      totalDiscount,
    },
    topItems,
    topCategories,
    paymentDistribution: paymentDist,
    hourlyDistribution: Object.entries(hourlySales).map(([h, v]) => ({ hour: Number(h), label: `${String(h).padStart(2, "0")}:00`, sales: v })),
  };
};

const getRestaurantPerformance = async (restaurantId, from, to, db) => {
  const [salesComparison, hourlySales, cancellation, categoryPerf] = await Promise.all([
    getSalesComparisonReport(restaurantId, from, to, from, to, db).catch(() => null),
    getHourlySalesReport(restaurantId, from, to, db).catch(() => null),
    getCancellationReport(restaurantId, from, to, db).catch(() => null),
    getCategoryPerformance(restaurantId, from, to, db).catch(() => []),
  ]);

  // Extract KPI totals from salesComparison so the frontend can read them
  // directly (perf.totalSales, perf.totalOrders, etc.).
  const current = salesComparison?.current || {};

  return {
    // Top-level KPI fields — the frontend reads perf.totalSales, perf.totalOrders, etc.
    totalSales: current.totalSales || 0,
    totalOrders: current.totalOrders || 0,
    totalItemsSold: current.totalItemsSold || 0,
    averageOrderValue: current.averageOrderValue || 0,
    totalTax: current.totalTax || 0,
    totalDiscount: current.totalDiscount || 0,
    // Nested summary for backwards compatibility
    summary: {
      totalSales: current.totalSales || 0,
      totalOrders: current.totalOrders || 0,
      totalItemsSold: current.totalItemsSold || 0,
      averageOrderValue: current.averageOrderValue || 0,
      totalTax: current.totalTax || 0,
      totalDiscount: current.totalDiscount || 0,
    },
    hourlySales: hourlySales || { hours: [], summary: {} },
    cancellation: cancellation || { summary: {}, byReason: {}, orders: [] },
    categoryPerformance: categoryPerf || [],
  };
};

module.exports = {
  getHourlySalesReport,
  getSalesComparisonReport,
  getDiscountReport,
  getCancellationReport,
  getKotRegister,
  getKotSummary,
  getKitchenPerformance,
  getMenuPerformance,
  getTopSellingItems,
  getLowSellingItems,
  getCategoryPerformance,
  getTableSales,
  getTableOccupancy,
  getStaffSales,
  getStaffActivity,
  getStaffDiscountCancellation,
  getDailyClosing,
  getMonthlySummary,
  getRestaurantPerformance,
};
