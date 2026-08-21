const express = require("express");
const audit = require("../middleware/audit.middleware");
const {

    loginLimiter

} = require("../middleware/rate-limit.middleware");

const router = express.Router();

const {
  login,
  changePassword,
  profile,
  verifyPassword
} = require("../controllers/auth.controller");

const protect = require(
  "../middleware/auth.middleware"
);

// NOTE: POST /auth/register was removed. It was a PUBLIC endpoint that let
// anyone create a user (with any role, for any restaurantId) — a privilege
// escalation hole. Account provisioning goes through the super-admin flow
// (/super-admin/restaurants, /super-admin/users) instead.

router.post(
    "/login",
    audit(
        "AUTH",
        "LOGIN",
        "User logged in"
    ),
    loginLimiter,
    login
);
// router.post(
//     "/logout",
//     protect,
//     audit(
//         "AUTH",
//         "LOGOUT",
//         "User logged out"
//     ),
//     logout
// );

router.get(
  "/profile",
  protect,
  profile
);

router.post(
    "/verify-password",
    protect,
    audit(
        "AUTH",
        "LOGIN",
        (req) =>
            `Password verification attempt by user ID ${req.user?.id}`
    ),
    verifyPassword
);

// Self-service password change (Restaurant Admin changing their own password).
// Verifies the current password, hashes the new one, then the frontend forces logout.
router.post(
    "/change-password",
    protect,
    audit(
        "AUTH",
        "UPDATE",
        (req) =>
            `Password changed for user ID ${req.user?.id}`
    ),
    // Brute-force guard on the current-password comparison
    loginLimiter,
    changePassword
);

module.exports = router;