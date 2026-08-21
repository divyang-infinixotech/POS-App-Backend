const express = require("express");
const router = express.Router();
const audit = require("../middleware/audit.middleware");
const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const requireFeature = require("../middleware/feature.middleware");

const {
  getFloors,
  getFloorById,
  createFloor,
  updateFloor,
  deleteFloor,
} = require("../controllers/floor.controller");

// Get floors (read is shared with POS Ordering — the floor panel needs it)
router.get("/", protect, requireFeature(["floors", "pos"]), getFloors);

// Get single floor
router.get("/:id", protect, requireFeature(["floors", "pos"]), getFloorById);

// Create floor
router.post(
  "/",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature("floors"),
  audit("FLOOR", "CREATE", (req) => `Created floor "${req.body.name}"`),
  createFloor
);

// Update floor
router.put(
  "/:id",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature("floors"),
  audit("FLOOR", "UPDATE", (req) => `Updated floor ID ${req.params.id}`),
  updateFloor
);

// Delete floor
router.delete(
  "/:id",
  protect,
  authorize("ADMIN", "MANAGER"),
  requireFeature("floors"),
  audit("FLOOR", "DELETE", (req) => `Deleted floor ID ${req.params.id}`),
  deleteFloor
);

module.exports = router;
