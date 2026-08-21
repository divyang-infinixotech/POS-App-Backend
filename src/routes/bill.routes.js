const express = require("express");
const audit = require("../middleware/audit.middleware");

const router = express.Router();

const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const validate = require("../middleware/validate.middleware");
const requireFeature = require("../middleware/feature.middleware");

const {
    createBillSchema,
    applyBillDiscountSchema,
    cancelBillSchema
} = require("../validators/bill.validator");

const {

    createBill,

    getBills,

    getBillById,

    cancelBill,
    updateBillDiscount

} = require("../controllers/bill.controller");

// Billing is part of the core POS checkout flow — granted by either billing or pos
router.post(
    "/",
    protect,
    authorize("ADMIN", "CASHIER"),
    requireFeature(["billing", "pos"]),
    validate(createBillSchema),
    createBill
);

router.get(
    "/",
    protect,
    requireFeature(["billing", "pos"]),
    getBills
);

router.get(
    "/:id",
    protect,
    requireFeature(["billing", "pos"]),
    getBillById
);

// ─── Apply Discount to Bill ───
router.post(
    "/:id/discount",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER"),
    requireFeature(["billing", "pos"]),
    validate(applyBillDiscountSchema),
    updateBillDiscount
);

router.post(
    "/:id/cancel",
    protect,
    authorize("ADMIN"),
    requireFeature(["billing", "pos"]),
    validate(cancelBillSchema),
    audit("BILL", "UPDATE", (req) => `Cancelled Bill ${req.params.id}`),
    cancelBill
);

module.exports = router;