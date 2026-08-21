const prisma = require("../config/prisma");

/**
 * Safely build a where clause with restaurantId.
 * Returns an empty object if restaurantId is falsy (SUPER_ADMIN case — handled upstream).
 */
function whereRestaurant(restaurantId) {
    if (!restaurantId) {
        return {};
    }
    return { restaurantId };
}

/**
 * Get today's business-date boundaries in IST (Asia/Kolkata).
 * Returns { start, end } Date objects representing IST midnight and 23:59:59.999.
 * All dashboard/report queries MUST use this instead of naive setHours(0,0,0,0)
 * (which yields UTC midnight — 5.5 hours off from IST midnight).
 */
function getISTBusinessDate() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
    const start = new Date(`${dateStr}T00:00:00+05:30`);
    const end = new Date(`${dateStr}T23:59:59.999+05:30`);
    return { start, end, dateStr };
}

const getOrderSummary = async (restaurantId) => {

    const { start: today } = getISTBusinessDate();

    // "Total Orders" uses the same qualifying definition as the Order Report:
    // non-cancelled, non-deleted orders. Cancelled orders are counted separately.
    const where = {
        ...whereRestaurant(restaurantId),
        createdAt: { gte: today },
        isDeleted: false,
        status: { not: "CANCELLED" }
    };
    const billWhere = {
        ...whereRestaurant(restaurantId),
        createdAt: { gte: today },
        isCancelled: false
    };

    const [todayOrders, todayBills] = await Promise.all([

        prisma.order.count({ where }),

        prisma.bill.count({ where: billWhere })

    ]);

    return {
        todayOrders,
        todayBills
    };
};
const getRevenueSummary = async (restaurantId) => {

    // todayRevenue must be scoped to TODAY — previously it summed every PAID
    // bill in the restaurant's history, so a day with no sales showed all-time
    // revenue as "today's sales".
    const { start: today } = getISTBusinessDate();

    const revenue = await prisma.bill.aggregate({

        _sum: {
            grandTotal: true
        },

        where: {
            ...whereRestaurant(restaurantId),
            createdAt: { gte: today },
            status: "PAID",
            isCancelled: false
        }

    });

    return {

        todayRevenue: Number(
            revenue._sum.grandTotal ?? 0
        )

    };

};
const getMenuSummary = async (restaurantId) => {

    const [

        totalMenu,

        totalCategories

    ] = await Promise.all([

        prisma.menuItem.count({
            where: whereRestaurant(restaurantId)
        }),

        prisma.category.count({
            where: whereRestaurant(restaurantId)
        })

    ]);

    return {

        totalMenu,

        totalCategories

    };

};
const getUserSummary = async (restaurantId) => {

    const totalUsers = await prisma.user.count({

        where: {
            ...whereRestaurant(restaurantId),
            isActive: true
        }

    });

    return {

        totalUsers

    };

};
const getTableStatusSummary = async (restaurantId) => {

    const result = await prisma.restaurantTable.groupBy({

        by: ["status"],

        where: whereRestaurant(restaurantId),

        _count: {

            status: true

        }

    });

    const summary = {

        AVAILABLE: 0,

        OCCUPIED: 0,

        RESERVED: 0,

        CLEANING: 0

    };

    result.forEach((row) => {

        summary[row.status] = row._count.status;

    });

    return summary;

};const getKitchenSummaryForDashboard = async (restaurantId) => {

    // Kitchen queue count must reflect TODAY's pending KOTs only — not all-time.
    const { start: today } = getISTBusinessDate();
    const pendingKOT = await prisma.kOT.count({
        where: {
            ...whereRestaurant(restaurantId),
            status: "PENDING",
            createdAt: { gte: today },
        }
    });

    return {

        pendingKOT

    };

};
const getSummary = async (restaurantId) => {

    const [

        orders,

        revenue,

        menu,

        users,

        tables,

        kitchen

    ] = await Promise.all([

        getOrderSummary(restaurantId),

        getRevenueSummary(restaurantId),

        getMenuSummary(restaurantId),

        getUserSummary(restaurantId),

        getTableStatusSummary(restaurantId),

        getKitchenSummaryForDashboard(restaurantId)

    ]);

    return {

        ...orders,

        ...revenue,

        ...menu,

        ...users,

        occupiedTables:
            tables.OCCUPIED,

        availableTables:
            tables.AVAILABLE,

        reservedTables:
            tables.RESERVED,

        cleaningTables:
            tables.CLEANING,

        ...kitchen

    };

};
const getSalesSummary = async (restaurantId) => {

    const { start: today, dateStr } = getISTBusinessDate();
    const monthStart = new Date(`${dateStr.slice(0, 7)}-01T00:00:00+05:30`);

    // Today's sales uses the SAME definition as the Sales Report: sum of
    // grandTotal of PAID, non-cancelled bills created today. This makes the
    // dashboard "Today's Sales" and "Monthly Sales" reconcile exactly with
    // /reports/sales for Today / This Month.
    const billWhere = {
        ...whereRestaurant(restaurantId),
        status: "PAID",
        isCancelled: false
    };
    const paymentWhere = {
        ...whereRestaurant(restaurantId),
        createdAt: { gte: today },
        status: "PAID"
    };

    const [todayBills, monthBills, cash, upi, card] = await Promise.all([
        prisma.bill.findMany({ where: { ...billWhere, createdAt: { gte: today } }, select: { grandTotal: true } }),
        prisma.bill.findMany({ where: { ...billWhere, createdAt: { gte: monthStart } }, select: { grandTotal: true } }),
        prisma.payment.aggregate({ _sum: { amount: true }, where: { ...paymentWhere, paymentMethod: "CASH" } }),
        prisma.payment.aggregate({ _sum: { amount: true }, where: { ...paymentWhere, paymentMethod: "UPI" } }),
        prisma.payment.aggregate({ _sum: { amount: true }, where: { ...paymentWhere, paymentMethod: "CARD" } })
    ]);

    const sumBills = (list) => list.reduce((s, b) => s + Number(b.grandTotal || 0), 0);

    return {
        totalSales: sumBills(todayBills),
        monthlySales: sumBills(monthBills),
        cashSales: cash._sum.amount || 0,
        upiSales: upi._sum.amount || 0,
        cardSales: card._sum.amount || 0
    };

};
const getTableSummary = async (restaurantId) => {

    const baseWhere = whereRestaurant(restaurantId);

    const [available, occupied, reserved, cleaning] = await Promise.all([
        prisma.restaurantTable.count({ where: { ...baseWhere, status: "AVAILABLE" } }),
        prisma.restaurantTable.count({ where: { ...baseWhere, status: "OCCUPIED" } }),
        prisma.restaurantTable.count({ where: { ...baseWhere, status: "RESERVED" } }),
        prisma.restaurantTable.count({ where: { ...baseWhere, status: "CLEANING" } })
    ]);

    return { available, occupied, reserved, cleaning };
};
const getKitchenSummary = async (restaurantId) => {

    const { start: today } = getISTBusinessDate();

    const [totalKOT, todayKOT] = await Promise.all([
        prisma.kOT.count({ where: whereRestaurant(restaurantId) }),
        prisma.kOT.count({ where: { ...whereRestaurant(restaurantId), createdAt: { gte: today } } })
    ]);

    return { totalKOT, todayKOT };

};
const getPaymentSummary = async (restaurantId) => {

    // Only PAID payments count toward collection — failed/refunded/pending
    // transactions must never inflate the dashboard payment breakdown.
    const baseWhere = {
        ...whereRestaurant(restaurantId),
        status: "PAID"
    };

    const [cash, card, upi] = await Promise.all([
        prisma.payment.aggregate({ _sum: { amount: true }, where: { ...baseWhere, paymentMethod: "CASH" } }),
        prisma.payment.aggregate({ _sum: { amount: true }, where: { ...baseWhere, paymentMethod: "CARD" } }),
        prisma.payment.aggregate({ _sum: { amount: true }, where: { ...baseWhere, paymentMethod: "UPI" } })
    ]);

    return {
        cash: cash._sum.amount || 0,
        card: card._sum.amount || 0,
        upi: upi._sum.amount || 0
    };

};

const getRecentOrders = async (restaurantId) => {

    return await prisma.order.findMany({

        where: {
            ...whereRestaurant(restaurantId),
            isDeleted: false
        },

        take: 10,

        orderBy: {
            createdAt: "desc"
        },

        include: {
            table: true,
            orderItems: {
                include: {
                    menuItem: true
                }
            }
        }

    });

};
const getHourlySales = async (restaurantId) => {
  const { start: today } = getISTBusinessDate();

  // Fetch today's PAID payments only — failed/refunded payments must never
  // contribute to a sales-by-hour chart.
  const payments = await prisma.payment.findMany({
    where: {
      ...whereRestaurant(restaurantId),
      createdAt: { gte: today },
      status: "PAID",
    },
    select: { amount: true, createdAt: true },
  });

  // Build 24-hour buckets
  const hourlyBuckets = Array.from({ length: 24 }, (_, i) => ({
    hour: String(i).padStart(2, "0"),
    label: i === 0 ? "12AM" : i < 12 ? `${i}AM` : i === 12 ? "12PM" : `${i - 12}PM`,
    value: 0,
  }));

  payments.forEach((p) => {
    const h = new Date(p.createdAt).getHours();
    if (h >= 0 && h < 24) {
      hourlyBuckets[h].value += Number(p.amount) || 0;
    }
  });

  // Round values and trim trailing zero-hours for a cleaner chart
  hourlyBuckets.forEach((b) => {
    b.value = Math.round(b.value * 100) / 100;
  });

  return hourlyBuckets;
};

const getTopItems = async (restaurantId, since) => {

    // orderItem does not have restaurantId directly; filter through order relation.
    // `since` (optional) scopes to a date window — the dashboard passes today's
    // start so top items reconcile with the Sales Report's "Today" range.
    const orderFilter = {
        isDeleted: false,
        status: { notIn: ["CANCELLED"] }
    };
    if (restaurantId) orderFilter.restaurantId = restaurantId;
    if (since) orderFilter.createdAt = { gte: since };

    const topItems = await prisma.orderItem.groupBy({

        by: ["menuItemId"],

        _sum: {

            quantity: true,

            total: true

        },

        where: { order: orderFilter },

        orderBy: {
            _sum: { quantity: "desc" }
        },

        take: 10

    });

    const menuIds = topItems.map(item => item.menuItemId);

    const menus = await prisma.menuItem.findMany({

        where: {

            id: {

                in: menuIds

            }

        },

        select: {

            id: true,

            name: true,

            image: true,

            price: true

        }

    });

    const menuMap = new Map();

    menus.forEach(menu => {

        menuMap.set(menu.id, menu);

    });

    return topItems.map(item => ({

        id: item.menuItemId,

        name: menuMap.get(item.menuItemId)?.name,

        image: menuMap.get(item.menuItemId)?.image,

        price: menuMap.get(item.menuItemId)?.price,

        quantity: item._sum.quantity || 0,

        revenue: item._sum.total || 0

    }));

};
const getCategorySales = async (restaurantId) => {

    const categories = await prisma.category.findMany({
        where: whereRestaurant(restaurantId),
        include: {

            menuItems: {

                include: {

                    orderItems: {
                        where: {
                            order: {
                                isDeleted: false,
                                status: { notIn: ["CANCELLED"] }
                            }
                        }
                    }

                }

            }

        }

    });

    return categories.map(category => {

        let quantity = 0;

        let revenue = 0;

        category.menuItems.forEach(menu => {

            menu.orderItems.forEach(item => {

                quantity += item.quantity;

                revenue += item.total;

            });

        });

        return {

            id: category.id,

            category: category.name,

            quantity,

            revenue

        };

    });

};
const getRecentPayments = async (restaurantId) => {

    return await prisma.payment.findMany({
        where: {
            ...whereRestaurant(restaurantId),
            status: "PAID"
        },
        take: 10,

        orderBy: {

            createdAt: "desc"

        },

        include: {

            bill: {

                select: {

                    billNo: true,

                    grandTotal: true

                }

            }

        }

    });

};
const getLiveOrders = async (restaurantId) => {

    // Active orders for the dashboard must be scoped to TODAY's business
    // date — not all-time. Stale PENDING orders from yesterday must not
    // inflate the Active Orders / Kitchen Queue KPIs.
    const { start: today } = getISTBusinessDate();

    return await prisma.order.findMany({

        where: {
            ...whereRestaurant(restaurantId),
            status: { in: ["PENDING", "PREPARING", "READY"] },
            isDeleted: false,
            createdAt: { gte: today },
        },

        include: {

            table: {

                select: {

                    tableNo: true

                }

            },

            orderItems: {

                include: {

                    menuItem: {

                        select: {

                            name: true

                        }

                    }

                }

            }

        },

        orderBy: {

            createdAt: "asc"

        }

    });

};
const getInventorySummary = async (restaurantId) => {

  const { start: today } = getISTBusinessDate();

  const completedToday = {
    isDeleted: false,
    status: { notIn: ["CANCELLED"] },
    completedAt: { gte: today },
  };

  // Items sold today = quantities from non-cancelled orders completed today
  const itemsSoldAgg = await prisma.orderItem.aggregate({
    _sum: { quantity: true },
    where: {
      order: {
        ...whereRestaurant(restaurantId),
        ...completedToday,
      },
    },
  });

  // Top selling item & category today (quantity-based, from completed orders)
  const todayItems = await prisma.orderItem.findMany({
    where: {
      order: {
        ...whereRestaurant(restaurantId),
        ...completedToday,
      },
    },
    select: {
      quantity: true,
      total: true,
      menuItem: {
        select: {
          id: true,
          name: true,
          category: { select: { id: true, name: true } },
        },
      },
    },
  });

  const itemAgg = {};
  const catAgg = {};
  todayItems.forEach((i) => {
    const qty = Number(i.quantity) || 0;
    const rev = Number(i.total) || 0;
    const mi = i.menuItem;
    if (!mi) return;
    if (!itemAgg[mi.id]) itemAgg[mi.id] = { name: mi.name, quantity: 0, revenue: 0 };
    itemAgg[mi.id].quantity += qty;
    itemAgg[mi.id].revenue += rev;
    if (mi.category) {
      if (!catAgg[mi.category.id]) catAgg[mi.category.id] = { name: mi.category.name, quantity: 0, revenue: 0 };
      catAgg[mi.category.id].quantity += qty;
      catAgg[mi.category.id].revenue += rev;
    }
  });

  const topItemList = Object.entries(itemAgg).sort((a, b) => b[1].quantity - a[1].quantity);
  const topCatList = Object.entries(catAgg).sort((a, b) => b[1].quantity - a[1].quantity);

  const topSellingItem = topItemList[0]
    ? { menuItemId: Number(topItemList[0][0]), ...topItemList[0][1] }
    : null;
  const topSellingCategory = topCatList[0]
    ? { categoryId: Number(topCatList[0][0]), ...topCatList[0][1] }
    : null;

  // Low stock items: currentStock < 10 (null = not tracked, excluded automatically)
  const lowStockItems = await prisma.menuItem.count({
    where: {
      ...whereRestaurant(restaurantId),
      currentStock: { lt: 10 },
    },
  });

  return {
    itemsSoldToday: itemsSoldAgg._sum.quantity || 0,
    topSellingItem,
    topSellingCategory,
    lowStockItems,
  };
};

const getStaffDashboard = async (restaurantId) => {

    const users = await prisma.user.groupBy({

        by: ["role"],

        _count: { role: true },

        where: {
            ...whereRestaurant(restaurantId),
            isActive: true
        }

    });

    const result = {

        ADMIN: 0,

        MANAGER: 0,

        CASHIER: 0,

        WAITER: 0,

        KITCHEN: 0

    };

    users.forEach(user => {

        result[user.role] = user._count.role;

    });

    return {

        admins: result.ADMIN,

        managers: result.MANAGER,

        cashiers: result.CASHIER,

        waiters: result.WAITER,

        kitchen: result.KITCHEN,

        total:

            result.ADMIN +

            result.MANAGER +

            result.CASHIER +

            result.WAITER +

            result.KITCHEN

    };

};
const getDashboard = async (restaurantId) => {

    const { start: today } = getISTBusinessDate();

    const [

        summary,

        sales,

        tables,

        kitchen,

        payments,

        recentOrders,

        topItems,

        categorySales,

        recentPayments,

        liveOrders,

        staff,

        inventory,

        hourlySales

    ] = await Promise.all([

        getSummary(restaurantId),

        getSalesSummary(restaurantId),

        getTableSummary(restaurantId),

        getKitchenSummary(restaurantId),

        getPaymentSummary(restaurantId),

        getRecentOrders(restaurantId),

        getTopItems(restaurantId, today),

        getCategorySales(restaurantId),

        getRecentPayments(restaurantId),

        getLiveOrders(restaurantId),

        getStaffDashboard(restaurantId),

        getInventorySummary(restaurantId),

        getHourlySales(restaurantId)

    ]);

    return {

        summary,

        sales,

        tables,

        kitchen,

        payments,

        recentOrders,

        topItems,

        categorySales,

        recentPayments,

        liveOrders,

        staff,

        inventory,

        hourlySales

    };

};

module.exports = {

    getSummary,
    getSalesSummary,
    getTableSummary,
    getKitchenSummary,    getPaymentSummary,

    getRecentOrders,
    getTopItems,

    getCategorySales,

    getRecentPayments,
    getLiveOrders,
    getStaffDashboard,
    getHourlySales,
    getInventorySummary,
    getDashboard

};