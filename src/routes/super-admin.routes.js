const express = require("express");
const router = express.Router();
const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const validate = require("../middleware/validate.middleware");

const {
  dashboard, getOwnProfile, updateOwnProfile, getRestaurants, createRestaurant, onboardingCreateRestaurant, getRestaurant, updateRestaurant, updateRestaurantStatus, deleteRestaurant, getRestaurantLoginAs,
  getUsers, createUser, updateUser, resetUserPassword, toggleUserStatus, deleteUser, changeUserRole,
  getSubscriptions, changePlan, renewSubscription, cancelSubscription, suspendSubscription, activateSubscription, getSubscriptionHistory, getSubscriptionPayments,
  getPlans, getPlanModules, createPlan, updatePlan, togglePlanActive, duplicatePlan, deletePlan,
  getPlatformReports, getPlatformSettings, updatePlatformSetting, updatePlatformSettings, getAuditLogs, getSupportTickets, updateSupportTicket, getPlatformNotifications,
  getGatewayStatus, saveGatewayConfig, testGateway, toggleGateway, getPaymentMetrics, listPayments,
} = require("../controllers/super-admin.controller");

const { createRestaurantSchema, updateRestaurantSchema, createUserSchema, createPlanSchema, updatePlanSchema, changePlanSchema } = require("../validators/super-admin.validator");

const {
  docUpload, uploadDocument, getDocuments, verifyDocument, rejectDocument, deleteDocument,
  createPolicyAgreement, getPolicyAgreements,
} = require("../controllers/super-admin.controller");

// All routes require authentication + SUPER_ADMIN role
router.use(protect, authorize("SUPER_ADMIN"));

// ─── Dashboard ───
router.get("/dashboard", dashboard);

// ─── Own Profile (Super Admin only — restaurant roles get 403 from authorize) ───
router.get("/profile", getOwnProfile);
router.put("/profile", updateOwnProfile);

// ─── Restaurants ───
router.get("/restaurants", getRestaurants);
router.post("/restaurants", validate(createRestaurantSchema), createRestaurant);
router.post("/restaurants/onboarding", onboardingCreateRestaurant);
router.get("/restaurants/:id", getRestaurant);
router.put("/restaurants/:id", validate(updateRestaurantSchema), updateRestaurant);
router.patch("/restaurants/:id/status", updateRestaurantStatus);
router.get("/restaurants/:id/login-as", getRestaurantLoginAs);
router.delete("/restaurants/:id", deleteRestaurant);

// ─── Restaurant Documents ───
router.post("/restaurants/:id/documents", docUpload.single("file"), uploadDocument);
router.get("/restaurants/:id/documents", getDocuments);
router.patch("/restaurants/:id/documents/:documentId/verify", verifyDocument);
router.patch("/restaurants/:id/documents/:documentId/reject", rejectDocument);
router.delete("/restaurants/:id/documents/:documentId", deleteDocument);

// ─── Restaurant Policy Agreements ───
router.post("/restaurants/:id/policy-agreements", createPolicyAgreement);
router.get("/restaurants/:id/policy-agreements", getPolicyAgreements);

// ─── Users ───
router.get("/users", getUsers);
router.post("/users", validate(createUserSchema), createUser);
router.put("/users/:id", updateUser);
router.patch("/users/:id/reset-password", resetUserPassword);
router.patch("/users/:id/toggle-status", toggleUserStatus);
router.patch("/users/:id/change-role", changeUserRole);
router.delete("/users/:id", deleteUser);

// ─── Subscriptions ───
router.get("/subscriptions", getSubscriptions);
router.get("/subscriptions/:restaurantId/history", getSubscriptionHistory);
router.get("/subscriptions/:restaurantId/payments", getSubscriptionPayments);

// ─── Payment Gateway (platform-level) ───
router.get("/payments/gateway", getGatewayStatus);
router.put("/payments/gateway", saveGatewayConfig);
router.post("/payments/gateway/test", testGateway);
router.post("/payments/gateway/toggle", toggleGateway);
router.get("/payments/metrics", getPaymentMetrics);
router.get("/payments", listPayments);
router.put("/subscriptions/:restaurantId/plan", validate(changePlanSchema), changePlan);
router.post("/subscriptions/:restaurantId/renew", renewSubscription);
router.post("/subscriptions/:restaurantId/cancel", cancelSubscription);
router.post("/subscriptions/:restaurantId/suspend", suspendSubscription);
router.post("/subscriptions/:restaurantId/activate", activateSubscription);

// ─── Plans (database-driven) ───
router.get("/plans", getPlans);
router.get("/plans/modules", getPlanModules);
router.post("/plans", validate(createPlanSchema), createPlan);
router.put("/plans/:id", validate(updatePlanSchema), updatePlan);
router.patch("/plans/:id/toggle", togglePlanActive);
router.post("/plans/:id/duplicate", duplicatePlan);
router.delete("/plans/:id", deletePlan);

// ─── Reports ───
router.get("/reports", getPlatformReports);

// ─── Settings ───
router.get("/settings", getPlatformSettings);
router.put("/settings", updatePlatformSettings);

// ─── Audit Logs ───
router.get("/audit-logs", getAuditLogs);

// ─── Support Tickets ───
router.get("/support-tickets", getSupportTickets);
router.patch("/support-tickets/:id", updateSupportTicket);

// ─── Notifications ───
router.get("/notifications", getPlatformNotifications);

module.exports = router;