const express = require("express");
const audit = require("../middleware/audit.middleware");
const {

    loginLimiter

} = require("../middleware/rate-limit.middleware");

const router = express.Router();

const {
  login,
  register,
  changePassword,
  profile,
  verifyPassword
} = require("../controllers/auth.controller");

const protect = require(
  "../middleware/auth.middleware"
);

const validate = require("../middleware/validate.middleware");
const { registerSchema } = require("../validators/onboarding.validator");

// NOTE: This replaces the original POST /auth/register which was removed as a
// privilege-escalation hole (it let anyone pick a role + restaurantId). The
// new endpoint is SAFE: it only creates a role=ADMIN account with no
// restaurantId, reads whitelisted fields only, and the resulting account has
// no restaurant/subscription/tenant until the self-serve onboarding flow
// (business details → documents → legal → plan → verified payment) completes.
router.post(
    "/register",
    validate(registerSchema),
    loginLimiter,
    register
);

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