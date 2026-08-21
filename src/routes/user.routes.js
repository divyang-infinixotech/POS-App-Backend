const express = require("express");

const router = express.Router();

const validate = require("../middleware/validate.middleware");
const audit = require("../middleware/audit.middleware");

const {
    createUserSchema
} = require("../validators/user.validator");

const protect =
require("../middleware/auth.middleware");

const authorize =
require("../middleware/role.middleware");

const requireFeature =
require("../middleware/feature.middleware");

const {
  createUser,
  getUsers,
  getUserById,
  updateUser,
  changeStatus,
  changePassword,
  deleteUser
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

router.get("/", protect, authorize("ADMIN", "MANAGER", "SUPER_ADMIN"), requireFeature("staff"), getUsers);

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