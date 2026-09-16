const express = require("express");

const router = express.Router();

const validate = require("../middleware/validate.middleware");
const audit = require("../middleware/audit.middleware");const {
  createUserSchema
} = require("../validators/user.validator");

const { requirePermission } = require("../middleware/permission.middleware");

const protect =
require("../middleware/auth.middleware");

const authorize =
require("../middleware/role.middleware");

const requireFeature =
require("../middleware/feature.middleware");
const requireModuleEnabled = require("../middleware/feature.middleware").requireModuleEnabled;

const {
  createUser,
  getUsers,
  getUserById,
  updateUser,
  changeStatus,
  changePassword,
  deleteUser,
  getUserPermissions,
  getMyPermissions,
  updateUserPermissions,
  resetUserPermissions,
  getUserFloorAssignments,
  updateUserFloorAssignments,
  getMyFloors
} = require("../controllers/user.controller");

router.post(
    "/",
    protect,
    authorize("ADMIN"),
    requireFeature("staff"),
    validate(createUserSchema),
    audit(
        "USER",
        "CREATE",
        (req) =>
            `Created user "${req.body.name}" (${req.body.email}) as ${req.body.role}`
    ),
    createUser
);

router.get("/", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("staff"), requireModuleEnabled("enableStaffRoster", "Staff Roster"), getUsers);

// Waiter directory used by the Take Order wizard — any role that can place
// orders (ADMIN/MANAGER/CASHIER/WAITER) may list the ACTIVE WAITER staff of
// their OWN restaurant. Narrower than the staff-management GET /users list,
// so cashiers/waiters can pick a service staff member without full staff access.
// MUST be registered before "/:id" so "waiters" is not captured as an ID.
router.get(
    "/waiters",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature(["pos", "active_orders"]),
    require("../controllers/user.controller").getWaiters
);

// ─── Per-staff permissions (tenant UserPermission; ADMIN-only management) ───
// "me" routes MUST be registered before "/:id/..." so "me" is not captured as an ID.
router.get(
    "/me/permissions",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "KITCHEN", "WAITER", "SUPER_ADMIN"),
    getMyPermissions
);
router.get(
    "/:id/permissions",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("staff"),
    getUserPermissions
);

// ─── Per-staff floor assignment (tenant UserFloorAssignment) ───
// "me" route MUST be registered before "/:id/..." so "me" is not captured as an ID.
// Floors & Tables read for the current user (restricted staff see only their floors).
router.get(
    "/me/floors",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "KITCHEN", "WAITER"),
    requireFeature(["floors", "pos", "tables", "active_orders"]),
    getMyFloors
);
router.get(
    "/:id/floors",
    protect,
    authorize("ADMIN", "MANAGER", "SUPER_ADMIN"),
    requireFeature("staff"),
    getUserFloorAssignments
);
router.put(
    "/:id/floors",
    protect,
    authorize("ADMIN", "SUPER_ADMIN"),
    requireFeature("staff"),
    requirePermission("staff.edit"),
    audit(
        "USER",
        "UPDATE",
        (req) =>
            `Updated floor assignments for user ID ${req.params.id}`
    ),
    updateUserFloorAssignments
);

router.put(
    "/:id/permissions",
    protect,
    authorize("ADMIN", "SUPER_ADMIN"),
    requireFeature("staff"),
    requirePermission("staff.edit"),
    audit(
        "USER",
        "UPDATE",
        (req) =>
            `Updated screen/action permissions for user ID ${req.params.id}`
    ),
    updateUserPermissions
);

router.delete(
    "/:id/permissions",
    protect,
    authorize("ADMIN", "SUPER_ADMIN"),
    requireFeature("staff"),
    requirePermission("staff.edit"),
    audit(
        "USER",
        "UPDATE",
        (req) =>
            `Reset permissions to role defaults for user ID ${req.params.id}`
    ),
    resetUserPermissions
);

router.get("/:id", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("staff"), getUserById);

router.put(
    "/:id",
    protect,
    authorize("ADMIN"),
    requireFeature("staff"),
    audit(
        "USER",
        "UPDATE",
        (req) =>
            `Updated user ID ${req.params.id}`
    ),
    updateUser
);

router.patch(
    "/:id/status",
    protect,
    authorize("ADMIN"),
    requireFeature("staff"),
    audit(
        "USER",
        "UPDATE",
        (req, body) =>
            `Changed user "${body?.user?.name || `ID ${req.params.id}`}" status to ${req.body.isActive ? 'enabled' : 'disabled'}`
    ),
    changeStatus
);

router.patch(
    "/:id/password",
    protect,
    authorize("ADMIN"),
    requireFeature("staff"),
    audit(
        "USER",
        "UPDATE",
        (req) =>
            `Changed password for user ${req.params.id}`
    ),
    changePassword
);

router.delete(
    "/:id",
    protect,
    authorize("ADMIN"),
    requireFeature("staff"),
    audit(
        "USER",
        "DELETE",
        (req) =>
            `Deleted user ID ${req.params.id}`
    ),
    deleteUser
);

module.exports = router;