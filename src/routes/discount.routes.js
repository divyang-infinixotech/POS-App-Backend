const express = require("express");
const audit = require("../middleware/audit.middleware");

const router = express.Router();

const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const validate = require("../middleware/validate.middleware");
const requireFeature = require("../middleware/feature.middleware");
const { requirePermission } = require("../middleware/permission.middleware");

const {
  createDiscountSchema,
  updateDiscountSchema,
  applyDiscountSchema,
  removeDiscountSchema,
} = require("../validators/discount.validator");

const {
  getDiscounts,
  getDiscountById,
  createDiscount,
  updateDiscount,
  setDiscountStatus,
  archiveDiscount,
  getEligibleDiscounts,
  applyDiscount,
  removeDiscount,
  applyManualDiscount,
  previewDiscount,
  getUsageStats,
  getReferenceCategories,
  getReferenceProducts,
  getReferenceStaff,
} = require("../controllers/discount.controller");

// ─── Management (ADMIN / MANAGER) — Discounts & Promotions screen ───────────
// Plan gate follows the existing billing module (the discounts surface lives
// inside the POS/billing flow). Existing RBAC only — no parallel system (§27).

router.get(
  "/",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature(["billing", "pos"]),
  getDiscounts
);

// ─── Reference lookups (§14) — tenant-scoped, MUST precede /:id ───────────
router.get(
  "/reference/categories",
  protect,
  authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
  requireFeature(["billing", "pos"]),
  getReferenceCategories
);

router.get(
  "/reference/products",
  protect,
  authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
  requireFeature(["billing", "pos"]),
  getReferenceProducts
);

router.get(
  "/reference/staff",
  protect,
  authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
  requireFeature(["billing", "pos"]),
  getReferenceStaff
);

router.get(
  "/usage-stats",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature(["billing", "pos"]),
  getUsageStats
);

router.get(
  "/:id",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature(["billing", "pos"]),
  getDiscountById
);

router.post(
  "/",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature(["billing", "pos"]),
  requirePermission("billing.discount"),
  validate(createDiscountSchema),
  audit("DISCOUNT", "CREATE", (req) => `Created discount ${req.body?.name || ""}`),
  createDiscount
);

router.put(
  "/:id",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature(["billing", "pos"]),
  requirePermission("billing.discount"),
  validate(updateDiscountSchema),
  audit("DISCOUNT", "UPDATE", (req) => `Updated discount ${req.params.id}`),
  updateDiscount
);

router.patch(
  "/:id/status",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature(["billing", "pos"]),
  requirePermission("billing.discount"),
  validate(require("../validators/discount.validator").listEligibleSchema),
  setDiscountStatus
);

router.delete(
  "/:id",
  protect,
  authorize("ADMIN"),
  requireFeature(["billing", "pos"]),
  requirePermission("billing.discount"),
  audit("DISCOUNT", "DELETE", (req) => `Archived discount ${req.params.id}`),
  archiveDiscount
);

router.post(
  "/preview",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature(["billing", "pos"]),
  validate(require("../validators/discount.validator").listEligibleSchema),
  previewDiscount
);

// ─── Apply / remove (billing-capable roles) ─────────────────────────────────

router.get(
  "/eligible/:orderId",
  protect,
  authorize("ADMIN", "MANAGER", "CASHIER"),
  requireFeature(["billing", "pos"]),
  getEligibleDiscounts
);

router.post(
  "/apply/:orderId",
  protect,
  authorize("ADMIN", "MANAGER", "CASHIER"),
  requireFeature(["billing", "pos"]),
  validate(applyDiscountSchema),
  applyDiscount
);

router.post(
  "/apply/:orderId/manual",
  protect,
  authorize("ADMIN", "MANAGER", "CASHIER"),
  requireFeature(["billing", "pos"]),
  applyManualDiscount
);

router.delete(
  "/applied/:orderDiscountId",
  protect,
  authorize("ADMIN", "MANAGER", "CASHIER"),
  requireFeature(["billing", "pos"]),
  validate(removeDiscountSchema),
  removeDiscount
);

module.exports = router;
