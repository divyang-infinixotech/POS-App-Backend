const prisma = require("../config/prisma");
const logger = require("../logger/logger");
const {
  getSalesReport,
  getItemSalesReport,
  getCategorySalesReport,
  getPaymentReport,
  getOrderReport,
  getRevenueTrend,
  exportSalesExcel,
  exportSalesCSV,
  exportOrderExcel,
  exportOrderCSV,
  getSalesBills,
  getDailyReport
} = require("../services/report.service");
const {
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
} = require("../services/report-extended.service");
const {
  exportSalesPDF
} = require("../services/report-pdf.service");

const {
  successResponse,
  errorResponse
} = require("../utils/response");

/**
 * Resolve restaurantId for reports.
 * - Non-SUPER_ADMIN: use their assigned restaurantId.
 * - SUPER_ADMIN: use query param restaurantId or fall back to first active restaurant.
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
    logger.error({ message: "Failed to resolve restaurant for SUPER_ADMIN in report", error: err.message, userId: req.user.id });
  }

  return null;
}

function getQueryParams(req) {
  return {
    restaurantId: req.query.restaurantId || null,
    from: req.query.from || null,
    to: req.query.to || null,
    interval: req.query.interval || "daily",
    status: req.query.status || null,
    categoryId: req.query.categoryId ? parseInt(req.query.categoryId, 10) || null : null,
  };
}

const salesReport = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getSalesReport(restaurantId, from, to);
    return successResponse(res, report, "Sales Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const itemSalesReport = async (req, res) => {
  try {
    const { from, to, categoryId } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getItemSalesReport(restaurantId, from, to, categoryId);
    return successResponse(res, report, "Item Sales Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const categorySalesReport = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getCategorySalesReport(restaurantId, from, to);
    return successResponse(res, report, "Category Sales Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const paymentReport = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getPaymentReport(restaurantId, from, to);
    return successResponse(res, report, "Payment Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const orderReport = async (req, res) => {
  try {
    const { from, to, status } = getQueryParams(req);
    const page = parseInt(req.query.page, 10);
    const pageSize = parseInt(req.query.pageSize, 10);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getOrderReport(
      restaurantId, from, to, status,
      Number.isNaN(page) ? undefined : page,
      Number.isNaN(pageSize) ? undefined : pageSize
    );
    return successResponse(res, report, "Order Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const revenueTrend = async (req, res) => {
  try {
    const { from, to, interval } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const trend = await getRevenueTrend(restaurantId, from, to, interval);
    return successResponse(res, trend, "Revenue Trend");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const exportSalesToExcel = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const bills = await getSalesBills(restaurantId, from, to);
    const [categorySales, itemSales] = await Promise.all([
      getCategorySalesReport(restaurantId, from, to),
      getItemSalesReport(restaurantId, from, to),
    ]);
    const workbook = await exportSalesExcel(bills, { categorySales, itemSales });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Sales_Report.xlsx"
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const exportSalesToPDF = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const bills = await getSalesBills(restaurantId, from, to);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=Sales_Report.pdf");

    const settings = await prisma.restaurantSetting.findUnique({
      where: { restaurantId }
    });
    const restaurantName = settings?.restaurantName || "Restaurant";

    const [categorySales, itemSales] = await Promise.all([
      getCategorySalesReport(restaurantId, from, to),
      getItemSalesReport(restaurantId, from, to),
    ]);
    exportSalesPDF(bills, res, restaurantName, { categorySales, itemSales });
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const exportOrderToExcel = async (req, res) => {
  try {
    const { from, to, status } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getOrderReport(restaurantId, from, to, status);
    const workbook = await exportOrderExcel(report.orders);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=Order_Report.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const exportOrderToCSV = async (req, res) => {
  try {
    const { from, to, status } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getOrderReport(restaurantId, from, to, status);
    const csv = exportOrderCSV(report.orders);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=Order_Report.csv");
    res.send(csv);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const exportSalesToCSV = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const bills = await getSalesBills(restaurantId, from, to);
    const [categorySales, itemSales] = await Promise.all([
      getCategorySalesReport(restaurantId, from, to),
      getItemSalesReport(restaurantId, from, to),
    ]);
    const csv = exportSalesCSV(bills, { categorySales, itemSales });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=Sales_Report.csv");
    res.send(csv);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const dailyReport = async (req, res) => {
  try {
    const restaurantId = await resolveRestaurantId(req);
    const report = await getDailyReport(restaurantId, req.query.date);
    return successResponse(res, report, "Daily Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ── Extended Report Controllers ──

const hourlySalesReport = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getHourlySalesReport(restaurantId, from, to);
    return successResponse(res, report, "Hourly Sales Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const salesComparisonReport = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const prevFrom = req.query.prevFrom || null;
    const prevTo = req.query.prevTo || null;
    const report = await getSalesComparisonReport(restaurantId, from, to, prevFrom, prevTo);
    return successResponse(res, report, "Sales Comparison Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const discountReport = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getDiscountReport(restaurantId, from, to);
    return successResponse(res, report, "Discount Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const cancellationReport = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getCancellationReport(restaurantId, from, to);
    return successResponse(res, report, "Cancellation Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const kotRegister = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getKotRegister(restaurantId, from, to);
    return successResponse(res, report, "KOT Register");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const kotSummary = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getKotSummary(restaurantId, from, to);
    return successResponse(res, report, "KOT Summary");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const kitchenPerformance = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getKitchenPerformance(restaurantId, from, to);
    return successResponse(res, report, "Kitchen Performance");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const menuPerformance = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getMenuPerformance(restaurantId, from, to);
    return successResponse(res, report, "Menu Performance");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const topSellingItems = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const sortBy = req.query.sortBy || "quantity";
    const report = await getTopSellingItems(restaurantId, from, to, sortBy);
    return successResponse(res, report, "Top Selling Items");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const lowSellingItems = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const threshold = parseInt(req.query.threshold, 10) || 5;
    const report = await getLowSellingItems(restaurantId, from, to, threshold);
    return successResponse(res, report, "Low Selling Items");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const categoryPerformance = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getCategoryPerformance(restaurantId, from, to);
    return successResponse(res, report, "Category Performance");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const tableSales = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getTableSales(restaurantId, from, to);
    return successResponse(res, report, "Table Sales");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const tableOccupancy = async (req, res) => {
  try {
    const restaurantId = await resolveRestaurantId(req);
    const report = await getTableOccupancy(restaurantId);
    return successResponse(res, report, "Table Occupancy");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const staffSales = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getStaffSales(restaurantId, from, to);
    return successResponse(res, report, "Staff Sales");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const staffActivity = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getStaffActivity(restaurantId, from, to);
    return successResponse(res, report, "Staff Activity");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const staffDiscountCancellation = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getStaffDiscountCancellation(restaurantId, from, to);
    return successResponse(res, report, "Staff Discount/Cancellation Activity");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const dailyClosing = async (req, res) => {
  try {
    const restaurantId = await resolveRestaurantId(req);
    const date = req.query.date || null;
    const report = await getDailyClosing(restaurantId, date);
    return successResponse(res, report, "Daily Closing Report");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const monthlySummary = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getMonthlySummary(restaurantId, from, to);
    return successResponse(res, report, "Monthly Summary");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const restaurantPerformance = async (req, res) => {
  try {
    const { from, to } = getQueryParams(req);
    const restaurantId = await resolveRestaurantId(req);
    const report = await getRestaurantPerformance(restaurantId, from, to);
    return successResponse(res, report, "Restaurant Performance");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

module.exports = {
  salesReport,
  itemSalesReport,
  categorySalesReport,
  paymentReport,
  orderReport,
  revenueTrend,
  exportSalesToExcel,
  exportSalesToPDF,
  exportSalesToCSV,
  exportOrderToExcel,
  exportOrderToCSV,
  dailyReport,
  hourlySalesReport,
  salesComparisonReport,
  discountReport,
  cancellationReport,
  kotRegister,
  kotSummary,
  kitchenPerformance,
  menuPerformance,
  topSellingItems,
  lowSellingItems,
  categoryPerformance,
  tableSales,
  tableOccupancy,
  staffSales,
  staffActivity,
  staffDiscountCancellation,
  dailyClosing,
  monthlySummary,
  restaurantPerformance,
};