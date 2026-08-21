const express = require("express");

const router = express.Router();
const audit = require("../middleware/audit.middleware");
const validate = require("../middleware/validate.middleware");

const protect =
require("../middleware/auth.middleware");

const authorize =
require("../middleware/role.middleware");
const requireFeature = require("../middleware/feature.middleware");

const {
  createTableSchema,
  updateTableSchema
} = require("../validators/table.validator");

const {
  createTable,
  getTables,
  updateTableStatus,
  updateTable,
  deleteTable
} = require("../controllers/table.controller");

router.post(
    "/",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("tables"),
    validate(createTableSchema),
    audit(
        "TABLE",
        "CREATE",
        (req) => `Created table ${req.body.tableNo}`
    ),
    createTable
);

// Get Tables (read is shared with POS Ordering — the table panel needs it)
router.get(
    "/",
    protect,
    requireFeature(["tables", "pos"]),
    getTables
);

// Update Table Status (specific route before parameterized route)
router.put(
    "/:id/status",
    protect,
    authorize("ADMIN", "MANAGER", "WAITER"),
    requireFeature("tables"),
    audit(
        "TABLE",
        "UPDATE",
        (req) => `Updated table ${req.params.id} status to ${req.body.status}`
    ),
    updateTableStatus
);

// Update Table (full update)
router.put(
    "/:id",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("tables"),
    validate(updateTableSchema),
    audit(
        "TABLE",
        "UPDATE",
        (req) => `Updated table ${req.params.id}`
    ),
    updateTable
);

// Delete Table
router.delete(
    "/:id",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("tables"),
    audit(
        "TABLE",
        "DELETE",
        (req) => `Deleted table ID ${req.params.id}`
    ),
    deleteTable
);

module.exports = router;