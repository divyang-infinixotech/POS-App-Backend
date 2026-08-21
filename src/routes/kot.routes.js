const express = require("express");
const audit = require("../middleware/audit.middleware");

const router = express.Router();

const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const validate = require("../middleware/validate.middleware");
const requireFeature = require("../middleware/feature.middleware");

const {
    createKOTSchema,
    updateKOTSchema,
    prioritySchema,
    cancelKOTSchema
} = require("../validators/kot.validator");

const {

    createKOT,

    getKOTList,

    updateKOTStatus,
    updateKOT,
    reprintKOT,
    reprintKOTByOrder,
    updatePriority,
    getKOTHistory,
    cancelKOT,
    cancelKOTByOrder

} = require("../controllers/kot.controller");

router.post(
    "/",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER"),
    validate(createKOTSchema),
    createKOT
);

router.get(
    "/",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER", "KITCHEN"),
    getKOTList
);
router.get(
    "/history",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER"),
    audit("KOT", "VIEW", () => "Viewed KOT History"),
    getKOTHistory
);
router.get(
    "/reprint/:id",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER"),
    audit("KOT", "REPRINT", (req) => `Reprinted KOT ${req.params.id}`),
    reprintKOT
);

// Reprint KOT by order ID (finds the latest KOT for the order)
router.get(
    "/reprint-by-order/:orderId",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER"),
    audit("KOT", "REPRINT", (req) => `Reprinted KOT for order ${req.params.orderId}`),
    reprintKOTByOrder
);
router.patch(
    "/:id/status",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER", "KITCHEN"),
    updateKOTStatus
);
router.put(
    "/:id",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER"),
    validate(updateKOTSchema),
    audit("KOT", "UPDATE", (req) => `Updated KOT ${req.params.id}`),
    updateKOT
);
router.patch(
    "/:id/priority",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER"),
    validate(prioritySchema),
    audit("KOT", "UPDATE", (req) => `Changed priority of KOT ${req.params.id} to ${req.body.priority}`),
    updatePriority
);
router.patch(
    "/:id/cancel",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER"),
    validate(cancelKOTSchema),
    audit("KOT", "CANCEL", (req) => `Cancelled KOT ${req.params.id}`),
    cancelKOT
);

// Cancel all KOTs by order ID
router.patch(
    "/cancel-by-order/:orderId",
    protect,
    requireFeature("kitchen"),
    authorize("ADMIN", "MANAGER"),
    audit("KOT", "CANCEL", (req) => `Cancelled all KOTs for order ${req.params.orderId}`),
    cancelKOTByOrder
);

module.exports = router;