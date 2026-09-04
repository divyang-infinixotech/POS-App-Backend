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
const { BILLING_ROLES } = require("../utils/billing-roles");

// Billing is part of the core POS checkout flow — granted by either billing or pos.
// Bill creation (checkout) is restricted to billing-capable roles (ADMIN/MANAGER/CASHIER).
router.post(
    "/",
    protect,
    authorize(...BILLING_ROLES),
    requireFeature(["billing", "pos"]),
    validate(createBillSchema),
    createBill
);

// Reading bills/receipts is part of the billing workflow — restricted to
// billing-capable roles (ADMIN/MANAGER/CASHIER). KITCHEN and WAITER are denied.
router.get(
    "/",
    protect,
    authorize(...BILLING_ROLES),
    requireFeature(["billing", "pos"]),
    getBills
);

router.get(
    "/:id",
    protect,
    authorize(...BILLING_ROLES),
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