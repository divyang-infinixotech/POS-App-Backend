const express = require("express");
const audit = require("../middleware/audit.middleware");

const router = express.Router();

const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const requireFeature = require("../middleware/feature.middleware");

const {

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


} = require("../controllers/dashboard.controller");

// router.get(

//     "/summary",

//     protect,

//     dashboardSummary,
//     salesDashboard

// );
router.get(
    "/",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("dashboard"),
    dashboard
);
router.get("/summary", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), dashboardSummary);
router.get("/sales", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), salesDashboard);
router.get("/tables", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), tableDashboard);
router.get("/kitchen", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), kitchenDashboard);
router.get("/payments", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), paymentDashboard);
router.get("/recent-orders", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), recentOrdersDashboard);
router.get("/top-items", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), topItemsDashboard);
router.get("/category-sales", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), categorySalesDashboard);
router.get("/recent-payments", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), recentPaymentsDashboard);
router.get("/live-orders", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), liveOrdersDashboard);
router.get("/staff", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), staffDashboard);
router.get("/hourly-sales", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("dashboard"), hourlySalesDashboard);

module.exports = router;