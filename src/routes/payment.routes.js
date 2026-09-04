const express = require("express");
const router = express.Router();
const audit = require("../middleware/audit.middleware");
const protect = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const authorize = require("../middleware/role.middleware");
const requireFeature = require("../middleware/feature.middleware");

const {
  createPaymentSchema,
  partialPaymentSchema,
  splitPaymentSchema,
  collectPaymentSchema,
} = require("../validators/payment.validator");

const {
  collectPayment,
  createPayment,
  partialPayment,
  splitPayment,
  getPayments,
  reprintReceipt,
  markPrinted,
  emailReceipt,
  generateUPIQrData,
  verifyUPIPayment,
} = require("../controllers/payment.controller");
const { BILLING_ROLES } = require("../utils/billing-roles");

// ─── Collect Payment (Combined: Create Bill + Process Payments + Complete Order) ───
// Payments are part of the core POS checkout flow — granted by either billing or pos.
// Billing-capable roles only (ADMIN / MANAGER / CASHIER) — KITCHEN and WAITER are rejected.
router.post(
  "/collect",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  validate(collectPaymentSchema),
  audit("PAYMENT", "CREATE", (req) =>
    `Collected payment ₹${req.body.payments?.reduce((s, p) => s + Number(p.amount), 0)} for Order ${req.body.orderId}`
  ),
  collectPayment
);

// ─── Single Payment ───
router.post(
  "/",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  validate(createPaymentSchema),
  audit("PAYMENT", "CREATE", (req) =>
    `Received payment ₹${req.body.amount} via ${req.body.paymentMethod}`
  ),
  createPayment
);

// ─── Partial Payment ───
router.post(
  "/partial",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  validate(partialPaymentSchema),
  audit("PAYMENT", "CREATE", (req) =>
    `Received partial payment ₹${req.body.amount}`
  ),
  partialPayment
);

// ─── Split Payment ───
router.post(
  "/split",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  validate(splitPaymentSchema),
  audit("PAYMENT", "CREATE", (req) =>
    `Split payment for Bill ${req.body.billId}`
  ),
  splitPayment
);

// ─── List Payments ───
// Reading payment records is part of the billing workflow — restricted to
// billing-capable roles (ADMIN/MANAGER/CASHIER). KITCHEN and WAITER are denied.
router.get(
  "/",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  getPayments
);

// ─── Reprint Receipt ───
router.post(
  "/:id/reprint",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  audit("PAYMENT", "REPRINT", (req) => `Reprinted receipt for Bill ${req.params.id}`),
  reprintReceipt
);

// ─── Mark Bill as Printed ───
router.post(
  "/:id/print",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  markPrinted
);

// ─── Email Receipt ───
router.post(
  "/:id/email",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  emailReceipt
);

// ─── Generate UPI QR Code Data ───
router.post(
  "/upi-qr",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  generateUPIQrData
);

// ─── Verify UPI Payment ───
router.post(
  "/verify-upi",
  protect,
  authorize(...BILLING_ROLES),
  requireFeature(["billing", "pos"]),
  verifyUPIPayment
);

module.exports = router;