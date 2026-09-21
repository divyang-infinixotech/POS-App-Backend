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
  getEmailSettings, updateEmailSettings, verifyEmailSettings, sendTestEmailHandler, getEmailProvider, updateEmailProvider,
  getEmailLogs, resendEmailHandler, retryEmailQueueHandler,
} = require("../controllers/super-admin.controller");

const { createRestaurantSchema, updateRestaurantSchema, createUserSchema, createPlanSchema, updatePlanSchema, changePlanSchema } = require("../validators/super-admin.validator");

const {
  docUpload, uploadDocument, getDocuments, verifyDocument, rejectDocument, deleteDocument,
  createPolicyAgreement, getPolicyAgreements,
  getBusinessApplications, getBusinessApplication, getReviewMode, setReviewMode,
  approveBusinessApplication, rejectBusinessApplication, downloadRestaurantDocument,
  // Manual payment flow (new simplified onboarding) — QR generation removed:
  // payment is verified manually, no checkout/QR is ever exposed.
  getManualApplications, getManualApplication, markManualPaymentReceived,
  approveManualApplication, rejectManualApplication,
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

// ─── Self-serve Business Applications (new-user onboarding) ───
// Order matters: literal segments (review-mode) before :id routes.
router.get("/business-applications", getBusinessApplications);
router.get("/business-applications/review-mode", getReviewMode);
router.put("/business-applications/review-mode", setReviewMode);
router.get("/business-applications/:id", getBusinessApplication);
router.post("/business-applications/:id/approve", approveBusinessApplication);
router.post("/business-applications/:id/reject", rejectBusinessApplication);

// ─── Manual Payment Applications (new simplified onboarding flow) ─────────────
router.get("/manual-applications", getManualApplications);
router.get("/manual-applications/:id", getManualApplication);
// NOTE: GET /manual-applications/:id/qr (Generate Payment QR) was removed —
// the approval flow is fully manual: Super Admin verifies the payment
// reference and uses "Mark Payment Received"; no QR/checkout is generated.
router.post("/manual-applications/:id/mark-payment", markManualPaymentReceived);
router.post("/manual-applications/:id/approve", approveManualApplication);
router.post("/manual-applications/:id/reject", rejectManualApplication);

// ─── Restaurant Documents ───
router.post("/restaurants/:id/documents", docUpload.single("file"), uploadDocument);
router.get("/restaurants/:id/documents", getDocuments);
// Authorized document download (documents are never served from public /uploads)
router.get("/restaurants/:id/documents/:documentId/download", downloadRestaurantDocument);
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

// ─── Email settings + delivery log (SUPER_ADMIN only — route-level authorize) ───
router.get("/email/settings", getEmailSettings);
router.put("/email/settings", updateEmailSettings);
// Active provider selection (GRAPH | SMTP) — persisted in SystemSetting.
router.get("/email/provider", getEmailProvider);
router.put("/email/provider", updateEmailProvider);
router.post("/email/verify", verifyEmailSettings);
router.post("/email/test", sendTestEmailHandler);
router.get("/email/logs", getEmailLogs);
router.post("/email/logs/:id/resend", resendEmailHandler);
router.post("/email/queue/retry", retryEmailQueueHandler);

// ─── Audit Logs ───
router.get("/audit-logs", getAuditLogs);

// ─── Support Tickets ───
router.get("/support-tickets", getSupportTickets);
router.patch("/support-tickets/:id", updateSupportTicket);

// ─── Notifications ───
router.get("/notifications", getPlatformNotifications);

module.exports = router;