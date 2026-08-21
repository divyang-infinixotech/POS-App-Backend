const express = require("express");
const router = express.Router();

const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const validate = require("../middleware/validate.middleware");

const {
  upgradePlan,
  renewPlan,
  getMySubscription,
  refreshSubscription,
  listPlans,
  createCheckout,
  verifyPayment,
  webhook,
  getPaymentHistory,
  getPayment,
  getGatewayStatus,
  scheduleDowngrade,
  cancelScheduledDowngrade,
} = require("../controllers/subscription.controller");

const {
  checkoutSchema,
  verifyPaymentSchema,
  scheduleDowngradeSchema,
} = require("../validators/subscription.validator");

// ─── Restaurant self-service (restaurant-scoped by req.user.restaurantId) ───

// Any authenticated restaurant user can view their own subscription
router.get("/me", protect, getMySubscription);

// Re-read the live subscription snapshot (used after a successful purchase)
router.get("/refresh", protect, refreshSubscription);

// Active purchasable plans (read-only — pricing/modules come from the DB)
router.get("/plans", protect, listPlans);

// Restaurant-safe gateway readiness — drives the “payments unavailable” banner
router.get("/gateway-status", protect, getGatewayStatus);

// Real payment history for this restaurant (real gateway references only)
router.get("/payments", protect, getPaymentHistory);
router.get("/payments/:id", protect, getPayment);

// Create a Razorpay order + record a CREATED SubscriptionPayment
router.post(
  "/checkout",
  protect,
  authorize("ADMIN"),
  validate(checkoutSchema),
  createCheckout
);

// Server-side payment verification → activates the subscription (idempotent)
router.post(
  "/verify",
  protect,
  authorize("ADMIN"),
  validate(verifyPaymentSchema),
  verifyPayment
);

// Schedule a lower-priced plan for the next renewal (no payment now)
router.post(
  "/downgrade",
  protect,
  authorize("ADMIN"),
  validate(scheduleDowngradeSchema),
  scheduleDowngrade
);

router.delete("/downgrade", protect, authorize("ADMIN"), cancelScheduledDowngrade);

// Razorpay webhook — signature verified, NO auth token (server-to-server)
router.post("/webhook", express.raw({ type: "application/json" }), webhook);

// ─── Super Admin: assign / renew any restaurant's plan (existing behavior) ───
router.put("/:restaurantId", protect, authorize("SUPER_ADMIN"), upgradePlan);
router.patch("/:restaurantId/renew", protect, authorize("SUPER_ADMIN"), renewPlan);

module.exports = router;
