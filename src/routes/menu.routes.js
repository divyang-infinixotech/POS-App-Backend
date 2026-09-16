const express = require("express");
const multer = require("multer");

const router = express.Router();
const validate = require("../middleware/validate.middleware");

const {
    createMenuSchema,
    updateMenuSchema
} = require("../validators/menu.validator");

const protect =
require("../middleware/auth.middleware");

const authorize =
require("../middleware/role.middleware");
const audit = require("../middleware/audit.middleware");
const requireFeature = require("../middleware/feature.middleware");
const { requirePermission } = require("../middleware/permission.middleware");

const {
  createMenuItem,
  getMenuItems,
  getMenuItemById,
  updateMenuItem,
  deleteMenuItem,
  toggleAvailability,
  duplicateMenuItem,
  uploadMenuItemImage,
  deleteMenuItemImage,
  getMenuItemByBarcode,
  getSubcategories,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory
} = require("../controllers/menu.controller");

// ─── Menu item image upload (multer in-memory → validated + processed server-side) ───
const menuImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG or WebP images are allowed"));
    }
  }
});

// These image routes MUST be registered before the /:id routes so that
// POST /image and DELETE /image are not captured by parameterised routes.
router.post(
  "/image",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature("menu"),
  (req, res, next) => {
    menuImageUpload.single("image")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ success: false, message: "File too large. Maximum size is 5MB." });
        }
        return res.status(400).json({ success: false, message: err.message });
      }
      next();
    });
  },
  audit("MENU", "CREATE", () => "Uploaded a menu item image"),
  uploadMenuItemImage
);

router.delete(
  "/image",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature("menu"),
  audit("MENU", "UPDATE", () => "Deleted an unbound menu item image"),
  deleteMenuItemImage
);

router.post(
    "/",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("menu"),
    requirePermission("menu.create"),
    validate(createMenuSchema),
    audit(
        "MENU",
        "CREATE",
        (req) =>
            `Created menu item "${req.body.name}" (SKU: ${req.body.sku}) Price: ₹${req.body.price}`
    ),
    createMenuItem
);

// Reads are shared with the POS Ordering screen (menu catalog is required to take orders)
router.get(
  "/",
  protect,
  requireFeature(["menu", "pos"]),
  getMenuItems
);

// ─── Barcode lookup (Part 11) — MUST be registered BEFORE any /:id route
// (same Express ordering rule as /subcategories). Plan entitlement comes from
// requireFeature("barcode_scanner"); the restaurant's own scanner toggle is
// enforced inside the controller chain below.
router.get(
  "/barcode/:barcode",
  protect,
  requireFeature("barcode_scanner"),
  getMenuItemByBarcode
);

// ─── Subcategories (Part 15) — MUST be registered BEFORE any /:id route.
// Express matches routes in registration order, so a literal path like
// "/subcategories" registered after "/:id" would be captured as id="subcategories"
// and routed into getMenuItemById (Prisma: Argument `id` is missing → 500).
router.get(
    "/subcategories",
    protect,
    requireFeature(["menu", "pos"]),
    getSubcategories
);

router.post(
    "/subcategories",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("menu"),
    requirePermission("subcategory.manage"),
    audit(
        "MENU",
        "CREATE",
        (req) =>
            `Created subcategory "${req.body.name}" under category ID ${req.body.categoryId}`
    ),
    createSubcategory
);

router.put(
    "/subcategories/:id",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("menu"),
    requirePermission("subcategory.manage"),
    audit(
        "MENU",
        "UPDATE",
        (req) =>
            `Updated subcategory ID ${req.params.id}`
    ),
    updateSubcategory
);

router.delete(
    "/subcategories/:id",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("menu"),
    requirePermission("subcategory.manage"),
    audit(
        "MENU",
        "DELETE",
        (req) =>
            `Deleted subcategory ID ${req.params.id}`
    ),
    deleteSubcategory
);

router.get(
  "/:id",
  protect,
  requireFeature(["menu", "pos"]),
  getMenuItemById
);

router.put(
    "/:id",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("menu"),
    requirePermission("menu.edit"),
    validate(updateMenuSchema),
    audit(
        "MENU",
        "UPDATE",
        (req) =>
            `Updated menu item ID ${req.params.id}`
    ),
    updateMenuItem
);
router.patch(
    "/:id/status",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("menu"),
    audit(
        "MENU",
        "UPDATE",
        (req) =>
            `Changed availability of menu item ID ${req.params.id}`
    ),
    toggleAvailability
);

router.post(
    "/:id/duplicate",
    protect,
    authorize("ADMIN"),
    requireFeature("menu"),
    audit(
        "MENU",
        "CREATE",
        (req) =>
            `Duplicated menu item ID ${req.params.id}`
    ),
    duplicateMenuItem
);

router.delete(
    "/:id",
    protect,
    authorize("ADMIN"),
    requireFeature("menu"),
    requirePermission("menu.delete"),
    audit(
        "MENU",
        "DELETE",
        (req) =>
            `Deleted menu item ID ${req.params.id}`
    ),
    deleteMenuItem
);

module.exports = router;