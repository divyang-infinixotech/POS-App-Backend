const prisma = require("../config/prisma");
const logger = require("../logger/logger");

const {
    getSummary,
    getSalesSummary,
    getTableSummary,
    getKitchenSummary,
    getPaymentSummary,
    getRecentOrders,
    getTopItems,
    getCategorySales,
    getRecentPayments,
    getLiveOrders,
    getStaffDashboard,
    getHourlySales,
    getInventorySummary,
    getDashboard
} = require("../services/dashboard.service");

const {
    successResponse
} = require("../utils/response");

/**
 * Resolve a valid restaurantId for dashboard queries.
 *
 * - Non-SUPER_ADMIN users: use their assigned restaurantId.
 * - SUPER_ADMIN: if req.query.restaurantId is provided and valid, use it;
 *   otherwise, fall back to the first active restaurant.
 */
async function resolveRestaurantId(req) {
    const { role, restaurantId: userRestaurantId } = req.user;

    if (role !== "SUPER_ADMIN") {
        return userRestaurantId;
    }

    if (req.query.restaurantId) {
        const parsedId = parseInt(req.query.restaurantId, 10);
        if (!isNaN(parsedId)) {
            return parsedId;
        }
    }

    try {
        const firstRestaurant = await prisma.restaurant.findFirst({
            where: { status: "ACTIVE" },
            select: { id: true },
            orderBy: { id: "asc" }
        });
        if (firstRestaurant) {
            return firstRestaurant.id;
        }
    } catch (err) {
        logger.error({ message: "Failed to resolve restaurant for SUPER_ADMIN", error: err.message, userId: req.user.id });
    }

    return null;
}

function logDashboardRequest(req, endpoint) {
    logger.info({
        message: "Dashboard Request",
        userId: req.user.id,
        role: req.user.role,
        restaurantId: req.user.restaurantId,
        endpoint,
        queryRestaurantId: req.query.restaurantId || null
    });
}

function getEmptyDashboard() {
    return {
        summary: {
            todayOrders: 0, todayBills: 0, todayRevenue: 0,
            totalMenu: 0, totalCategories: 0, totalUsers: 0,
            occupiedTables: 0, availableTables: 0, reservedTables: 0, cleaningTables: 0, pendingKOT: 0
        },
        sales: { totalSales: 0, monthlySales: 0, cashSales: 0, upiSales: 0, cardSales: 0 },
        tables: { available: 0, occupied: 0, reserved: 0, cleaning: 0 },
        kitchen: { totalKOT: 0, todayKOT: 0 },
        payments: { cash: 0, card: 0, upi: 0 },
        recentOrders: [],
        topItems: [],
        categorySales: [],
        recentPayments: [],
        liveOrders: [],
        staff: { admins: 0, managers: 0, cashiers: 0, waiters: 0, kitchen: 0, total: 0 },
        inventory: {
            itemsSoldToday: 0,
            topSellingItem: null,
            topSellingCategory: null,
            lowStockItems: 0
        },
        hourlySales: Array.from({ length: 24 }, (_, i) => ({
            hour: String(i).padStart(2, "0"),
            label: i === 0 ? "12AM" : i < 12 ? `${i}AM` : i === 12 ? "12PM" : `${i - 12}PM`,
            value: 0
        }))
    };
}

const dashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "full");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, getEmptyDashboard(), "Dashboard (no restaurant data)");
        }
        const data = await getDashboard(restaurantId);
        return successResponse(res, data, "Dashboard");
    } catch (error) {
        logger.error({ message: "Dashboard error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, getEmptyDashboard(), "Dashboard (defaults)");
    }
};

const dashboardSummary = async (req, res) => {
    try {
        logDashboardRequest(req, "summary");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, getEmptyDashboard().summary, "Dashboard Summary (no data)");
        }
        const data = await getSummary(restaurantId);
        return successResponse(res, data, "Dashboard Summary");
    } catch (error) {
        logger.error({ message: "Dashboard Summary error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, getEmptyDashboard().summary, "Dashboard Summary (defaults)");
    }
};

const salesDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "sales");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, getEmptyDashboard().sales, "Sales Dashboard (no data)");
        }
        const data = await getSalesSummary(restaurantId);
        return successResponse(res, data, "Sales Dashboard");
    } catch (error) {
        logger.error({ message: "Sales Dashboard error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, getEmptyDashboard().sales, "Sales Dashboard (defaults)");
    }
};

const tableDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "tables");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, getEmptyDashboard().tables, "Table Dashboard (no data)");
        }
        const data = await getTableSummary(restaurantId);
        return successResponse(res, data, "Table Dashboard");
    } catch (error) {
        logger.error({ message: "Table Dashboard error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, getEmptyDashboard().tables, "Table Dashboard (defaults)");
    }
};

const kitchenDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "kitchen");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, getEmptyDashboard().kitchen, "Kitchen Dashboard (no data)");
        }
        const data = await getKitchenSummary(restaurantId);
        return successResponse(res, data, "Kitchen Dashboard");
    } catch (error) {
        logger.error({ message: "Kitchen Dashboard error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, getEmptyDashboard().kitchen, "Kitchen Dashboard (defaults)");
    }
};

const paymentDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "payments");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, getEmptyDashboard().payments, "Payment Dashboard (no data)");
        }
        const data = await getPaymentSummary(restaurantId);
        return successResponse(res, data, "Payment Dashboard");
    } catch (error) {
        logger.error({ message: "Payment Dashboard error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, getEmptyDashboard().payments, "Payment Dashboard (defaults)");
    }
};

const recentOrdersDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "recentOrders");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, [], "Recent Orders (no data)");
        }
        const data = await getRecentOrders(restaurantId);
        return successResponse(res, data, "Recent Orders");
    } catch (error) {
        logger.error({ message: "Recent Orders error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, [], "Recent Orders (defaults)");
    }
};

const topItemsDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "topItems");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, [], "Top Items (no data)");
        }
        const data = await getTopItems(restaurantId);
        return successResponse(res, data, "Top Selling Items");
    } catch (error) {
        logger.error({ message: "Top Items error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, [], "Top Items (defaults)");
    }
};

const categorySalesDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "categorySales");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, [], "Category Sales (no data)");
        }
        const data = await getCategorySales(restaurantId);
        return successResponse(res, data, "Category Sales");
    } catch (error) {
        logger.error({ message: "Category Sales error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, [], "Category Sales (defaults)");
    }
};

const recentPaymentsDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "recentPayments");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, [], "Recent Payments (no data)");
        }
        const data = await getRecentPayments(restaurantId);
        return successResponse(res, data, "Recent Payments");
    } catch (error) {
        logger.error({ message: "Recent Payments error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, [], "Recent Payments (defaults)");
    }
};

const liveOrdersDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "liveOrders");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, [], "Live Orders (no data)");
        }
        const data = await getLiveOrders(restaurantId);
        return successResponse(res, data, "Live Orders");
    } catch (error) {
        logger.error({ message: "Live Orders error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, [], "Live Orders (defaults)");
    }
};

const hourlySalesDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "hourlySales");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, getEmptyDashboard().hourlySales, "Hourly Sales (no data)");
        }
        const data = await getHourlySales(restaurantId);
        return successResponse(res, data, "Hourly Sales");
    } catch (error) {
        logger.error({ message: "Hourly Sales error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, getEmptyDashboard().hourlySales, "Hourly Sales (defaults)");
    }
};

const staffDashboard = async (req, res) => {
    try {
        logDashboardRequest(req, "staff");
        const restaurantId = await resolveRestaurantId(req);
        if (!restaurantId) {
            return successResponse(res, getEmptyDashboard().staff, "Staff Dashboard (no data)");
        }
        const data = await getStaffDashboard(restaurantId);
        return successResponse(res, data, "Staff Dashboard");
    } catch (error) {
        logger.error({ message: "Staff Dashboard error", error: error.message, stack: error.stack, userId: req.user.id, role: req.user.role });
        return successResponse(res, getEmptyDashboard().staff, "Staff Dashboard (defaults)");
    }
};

module.exports = {
    dashboardSummary,
    salesDashboard,
    tableDashboard,
    kitchenDashboard,
    paymentDashboard,
    recentOrdersDashboard,
    topItemsDashboard,
    categorySalesDashboard,
    recentPaymentsDashboard,
    liveOrdersDashboard,
    staffDashboard,
    hourlySalesDashboard,
    dashboard
};