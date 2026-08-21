const express = require("express");
const audit = require("../middleware/audit.middleware");

const router = express.Router();

const protect =
require("../middleware/auth.middleware");

const authorize =
require("../middleware/role.middleware");
const requireFeature = require("../middleware/feature.middleware");
const validate = require("../middleware/validate.middleware");
const {
  createCategorySchema,
  updateCategorySchema
} = require("../validators/category.validator");

const {
  createCategory,
  getCategories,
  updateCategory,
  deleteCategory
} = require("../controllers/category.controller");

// Category reads are shared with POS Ordering (category grid); writes are Menu & Stock management
router.post(
    "/",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("menu"),
    validate(createCategorySchema),
    audit(
        "CATEGORY",
        "CREATE",
        (req) => `Created category "${req.body.name}"`
    ),
    createCategory
);

router.get(
    "/",
    protect,
    requireFeature(["menu", "pos"]),
    getCategories
);

router.put(
    "/:id",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("menu"),
    validate(updateCategorySchema),
    audit(
        "CATEGORY",
        "UPDATE",
        (req) => `Updated category ID ${req.params.id}`
    ),
    updateCategory
);

router.delete(
    "/:id",
    protect,
    authorize("ADMIN"),
    requireFeature("menu"),
    audit(
        "CATEGORY",
        "DELETE",
        (req) => `Deleted category ID ${req.params.id}`
    ),
    deleteCategory
);

module.exports = router;