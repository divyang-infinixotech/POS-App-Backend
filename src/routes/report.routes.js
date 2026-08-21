const express=require("express");

const router=express.Router();
const audit = require("../middleware/audit.middleware");

const protect=require("../middleware/auth.middleware");
const authorize=require("../middleware/role.middleware");
const requireFeature=require("../middleware/feature.middleware");

const {

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
restaurantPerformance

}=require("../controllers/report.controller");

// ─── Sales Report ───
router.get("/sales",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    salesReport
);
router.get("/sales/excel",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    exportSalesToExcel
);
router.get("/sales/pdf",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    exportSalesToPDF
);
router.get("/sales/csv",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    exportSalesToCSV
);

// ─── Item & Category Sales ───
router.get("/item-sales",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    itemSalesReport
);
router.get("/category-sales",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    categorySalesReport
);

// ─── Payment Report ───
router.get("/payment",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    paymentReport
);

// ─── Order Report ───
router.get("/orders",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    orderReport
);
router.get("/orders/excel",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    exportOrderToExcel
);
router.get("/orders/csv",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    exportOrderToCSV
);

// ─── Revenue Trend Chart ───
router.get("/revenue-trend",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    revenueTrend
);

// ─── Daily Report ───
router.get("/daily",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    dailyReport
);

// ─── Extended Reports ───
router.get("/hourly-sales",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    hourlySalesReport
);
router.get("/comparison",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    salesComparisonReport
);
router.get("/discounts",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    discountReport
);
router.get("/cancellations",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    cancellationReport
);
router.get("/kot/register",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    kotRegister
);
router.get("/kot/summary",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    kotSummary
);
router.get("/kitchen/performance",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    kitchenPerformance
);
router.get("/menu/performance",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    menuPerformance
);
router.get("/menu/top-selling",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    topSellingItems
);
router.get("/menu/low-selling",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    lowSellingItems
);
router.get("/menu/category-performance",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    categoryPerformance
);
router.get("/tables/sales",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    tableSales
);
router.get("/tables/occupancy",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    tableOccupancy
);
router.get("/staff/sales",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    staffSales
);
router.get("/staff/activity",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    staffActivity
);
router.get("/staff/discount-cancellation",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    staffDiscountCancellation
);
router.get("/management/daily-closing",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    dailyClosing
);
router.get("/management/monthly-summary",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    monthlySummary
);
router.get("/management/performance",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("reports"),
    restaurantPerformance
);

module.exports=router;