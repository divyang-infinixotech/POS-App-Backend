const {
  upgradeSubscription,
  renewSubscription,
} = require("../services/subscription.service");
const {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  activateSubscriptionPayment,
  computeBaseExpiry,
} = require("../services/razorpay.service");
const { computeExpiryDate, getRestaurantSubscription, planPrice, classifyAction, isActionAvailableForCycle, yearlyBillingError } = require("../utils/subscription");
const { successResponse, errorResponse } = require("../utils/response");
const prisma = require("../config/prisma");
const { isGatewayReady, recordWebhookActivity } = require("../services/gateway-config.service");
const { AVAILABLE_RESTAURANT_MODULES } = require("../config/subscription.config");

// ─── Super Admin: assign / renew any restaurant's plan (existing behavior) ───
const upgradePlan = async (req, res) => {
  try {
    const subscription = await upgradeSubscription(
      req.params.restaurantId,
      req.body.planId,
      req.user.id,
      { billingCycle: req.body.billingCycle, effectiveDate: req.body.effectiveDate, notes: req.body.notes }
    );
    return successResponse(res, subscription, "Subscription upgraded successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const renewPlan = async (req, res) => {
  try {
    const subscription = await renewSubscription(req.params.restaurantId, req.user.id);
    return successResponse(res, subscription, "Subscription renewed successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Restaurant admin: view own subscription ───
const getMySubscription = async (req, res) => {
  try {
    if (!req.user.restaurantId) {
      return errorResponse(res, "No restaurant associated with this account");
    }
    const subscription = await getRestaurantSubscription(req.user.restaurantId);
    return successResponse(res, subscription, "Subscription fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** POST /subscriptions/refresh — re-read the live snapshot after a plan change */
const refreshSubscription = async (req, res) => {
  try {
    if (!req.user.restaurantId) {
      return errorResponse(res, "No restaurant associated with this account");
    }
    const subscription = await getRestaurantSubscription(req.user.restaurantId);
    return successResponse(res, subscription, "Subscription refreshed");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/**
 * Backend-authoritative action for selecting `plan` given the restaurant's
 * current subscription. Same-cycle price comparison — the client never decides
 * UPGRADE/RENEWAL/SWITCH itself.
 *
 * Every plan is purchasable immediately: same plan → RENEWAL, higher-priced
 * different plan → UPGRADE, equal- or lower-priced different plan → SWITCH.
 * Lower-priced plans are a direct purchase the moment the restaurant chooses
 * them — there is no scheduled-downgrade flow for paid plan changes.
 * (Implementation lives in utils/subscription.js so it is unit-testable.)
 */

/**
 * GET /subscriptions/plans?cycle=MONTHLY|YEARLY
 * Active purchasable plans with module permissions AND the backend-computed
 * action (RENEWAL/UPGRADE/SWITCH/DOWNGRADE), price and expected expiry for
 * the requested cycle relative to the calling restaurant's subscription.
 */
const listPlans = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const subscription = restaurantId
      ? await prisma.subscription.findUnique({ where: { restaurantId: Number(restaurantId) } })
      : null;
    const currentPlan = subscription
      ? await prisma.plan.findUnique({ where: { id: subscription.planId } })
      : null;

    // Yearly-only billing rule: the restaurant purchase flow offers YEARLY
    // exclusively. A legacy ?cycle=MONTHLY query is tolerated for backward
    // compatibility but is ignored — the response is always yearly pricing and
    // actions (monthly purchases are rejected at checkout).
    const cycle = "YEARLY";

    const plans = await prisma.plan.findMany({
      where: { isActive: true, code: { not: "TRIAL" } },
      include: {
        modulePermissions: {
          include: { module: { select: { key: true, name: true } } },
          orderBy: { module: { sortOrder: "asc" } },
        },
      },
      orderBy: { sortOrder: "asc" },
    });

    const base = subscription ? computeBaseExpiry(subscription) : new Date();

    const data = plans.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      monthlyPrice: p.monthlyPrice, // kept for Super Admin / legacy data — never used for purchase
      yearlyPrice: p.yearlyPrice,
      billingCycle: cycle, // "YEARLY" — the only purchasable cycle
      trialDays: p.trialDays,
      price: planPrice(p, cycle), // price for the displayed cycle (backend-calculated)
      action: subscription ? classifyAction(subscription, currentPlan, p, cycle) : "RENEWAL",
      // Backend-driven availability: yearly makes every classified action
      // purchasable (SWITCH included). Kept for forward-compat safety.
      available: subscription ? isActionAvailableForCycle(classifyAction(subscription, currentPlan, p, cycle), cycle) : true,
      unavailableReason: null,
      expectedExpiry: computeExpiryDate(base, cycle), // same math as checkout/activation
      limits: {
        maxUsers: p.maxUsers,
        maxTables: p.maxTables,
        maxFloors: p.maxFloors,
        maxMenuItems: p.maxMenuItems,
        maxPrinters: p.maxPrinters,
        maxBranches: p.maxBranches,
        maxOrdersPerMonth: p.maxOrdersPerMonth,
        storageLimitMB: p.storageLimitMB,
      },
      // Only modules backed by a real restaurant feature are shown to the
      // restaurant (legacy catalog rows like qr_ordering / api_access are never
      // presented as plan features).
      modules: p.modulePermissions
        .filter((mp) => AVAILABLE_RESTAURANT_MODULES.indexOf(mp.module.key) !== -1)
        .map((mp) => ({
          key: mp.module.key,
          name: mp.module.name,
          enabled: mp.isEnabled,
        })),
    }));

    return successResponse(res, data, "Plans loaded");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/**
 * POST /subscriptions/checkout
 * Body: { planId, billingCycle: 'MONTHLY'|'YEARLY', action: 'UPGRADE'|'RENEWAL'|'SWITCH' }
 * Creates a Razorpay order + records a CREATED SubscriptionPayment. The plan is
 * NOT changed here — activation happens only after verified payment.
 */
const createCheckout = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { planId, billingCycle, action } = req.body;
    if (!planId) return errorResponse(res, "planId is required", 400);

    // Yearly-only billing rule: MONTHLY (or any non-YEARLY cycle) is rejected
    // BEFORE any plan lookup, order creation or payment row — no Razorpay
    // order, no SubscriptionPayment, no SubscriptionHistory, no subscription
    // change. Omitted billingCycle defaults to YEARLY.
    const yearlyError = yearlyBillingError(billingCycle);
    if (yearlyError) return errorResponse(res, yearlyError, 400);
    const cycle = "YEARLY";

    const plan = await prisma.plan.findUnique({ where: { id: Number(planId) } });
    if (!plan || !plan.isActive) return errorResponse(res, "Selected plan is not available", 400);
    if (plan.code === "TRIAL") return errorResponse(res, "The Trial plan cannot be purchased", 400);

    const subscription = await prisma.subscription.findUnique({ where: { restaurantId } });
    if (!subscription) return errorResponse(res, "No subscription found for this restaurant", 404);

    const currentPlan = await prisma.plan.findUnique({ where: { id: subscription.planId } });

    // The backend is the authority for the action — never trust the client.
    const act = classifyAction(subscription, currentPlan, plan, cycle);

    // A client-sent action that contradicts the backend classification is
    // rejected (the frontend always sends the backend-returned action, so a
    // mismatch means a rogue/buggy caller — never silently reclassify).
    if (action && ["RENEWAL", "UPGRADE", "SWITCH"].includes(action) && action !== act) {
      return errorResponse(
        res,
        `Action mismatch: this selection is a ${act}. Use the action returned by the plans endpoint.`,
        400
      );
    }

    // Business rule: SWITCH / CHANGE PLAN is YEARLY only. Enforced here on the
    // authoritative classification BEFORE any gateway work — no Razorpay order,
    // no SubscriptionPayment row, no subscription change.
    if (act === "SWITCH" && cycle !== "YEARLY") {
      return errorResponse(res, "Changing plans is available only on yearly billing.", 400);
    }

    // All actions (RENEWAL/UPGRADE/SWITCH) are payable immediately — a
    // lower-priced plan is a valid purchase when the restaurant chooses it.
    const amount = planPrice(plan, cycle);
    if (amount <= 0) return errorResponse(res, "This plan has no price configured for the selected cycle", 400);

    // Expected expiry shown on the confirm screen (same math as activation)
    const base = computeBaseExpiry(subscription);
    const expectedExpiry = computeExpiryDate(base, cycle);

    // Server-side gate: online payments must be configured AND enabled by the
    // Super Admin. Hiding the button on the frontend is NOT sufficient.
    const gatewayReady = await isGatewayReady();
    if (!gatewayReady) {
      return errorResponse(
        res,
        "Online payments are currently unavailable. Please contact your Super Admin.",
        503
      );
    }

    // Create the Razorpay order (503 with a clear message when unconfigured)
    let order;
    try {
      order = await createRazorpayOrder({ amount, receipt: `SUB-${subscription.id}-${Date.now()}` });
    } catch (e) {
      if (e.statusCode === 503) return errorResponse(res, e.message, 503);
      console.error("Razorpay order creation error:", e.message);
      return errorResponse(res, "Unable to reach the payment gateway. Please try again.", 502);
    }

    const payment = await prisma.subscriptionPayment.create({
      data: {
        restaurantId,
        subscriptionId: subscription.id,
        planId: plan.id,
        planCode: plan.code,
        planName: plan.name,
        billingCycle: cycle,
        action: act,
        amount,
        status: "CREATED",
        razorpayOrderId: order.id,
        createdBy: req.user.id,
      },
    });

    return successResponse(
      res,
      {
        subscriptionPaymentId: payment.id,
        razorpayOrderId: order.id,
        amount,
        currency: "INR",
        keyId: process.env.RAZORPAY_KEY_ID,
        plan: { id: plan.id, code: plan.code, name: plan.name },
        action: act,
        billingCycle: cycle,
        expectedExpiry,
        currentPlan: currentPlan ? { id: currentPlan.id, code: currentPlan.code, name: currentPlan.name } : null,
      },
      "Checkout created — complete the payment to activate",
      201
    );
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/**
 * POST /subscriptions/verify
 * Body: { subscriptionPaymentId, razorpayOrderId, razorpayPaymentId, razorpaySignature }
 * Verifies the signature server-side, then activates the subscription.
 */
const verifyPayment = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { subscriptionPaymentId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    const payment = await prisma.subscriptionPayment.findUnique({
      where: { id: Number(subscriptionPaymentId) },
    });
    if (!payment || payment.restaurantId !== restaurantId) {
      return errorResponse(res, "Subscription payment not found", 404);
    }
    if (payment.status === "PAID") {
      // Duplicate callback — return the current state without double-activating
      const subscription = await getRestaurantSubscription(restaurantId);
      return successResponse(res, { alreadyPaid: true, payment, subscription }, "Payment already processed");
    }
    if (payment.razorpayOrderId !== razorpayOrderId) {
      return errorResponse(res, "Payment order mismatch", 400);
    }

    if (!(await verifyPaymentSignature({ orderId: razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature }))) {
      await prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: { status: "FAILED", errorMessage: "Signature verification failed" },
      });
      return errorResponse(res, "Payment verification failed. The plan was not activated.", 400);
    }

    const result = await activateSubscriptionPayment({
      restaurantId,
      subscriptionPaymentId: payment.id,
      razorpayPaymentId,
      razorpaySignature,
    });

    const subscription = await getRestaurantSubscription(restaurantId);
    return successResponse(
      res,
      { ...result, subscription },
      result.alreadyPaid ? "Payment already processed" : "Payment verified — subscription activated",
      201
    );
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/**
 * POST /subscriptions/webhook — Razorpay server-to-server event (optional).
 * Body must be the RAW JSON buffer; the x-razorpay-signature header is verified
 * with RAZORPAY_WEBHOOK_SECRET. Only payment.captured / payment.authorized
 * events activate. Idempotent — a replayed event never extends twice.
 */
const webhook = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const raw = req.body; // Buffer (mounted with express.raw)
    if (!(await verifyWebhookSignature(raw, signature))) {
      return res.status(400).json({ success: false, message: "Invalid webhook signature" });
    }

    const event = JSON.parse(raw.toString("utf8"));
    const entity = event.payload?.payment?.entity;
    if (!entity) return res.status(200).json({ success: true, ignored: true });

    // Record last webhook activity for the SA webhook-health card (no secrets).
    recordWebhookActivity(event).catch(() => {});

    if (event.event !== "payment.captured" && event.event !== "payment.authorized") {
      return res.status(200).json({ success: true, ignored: true });
    }

    const payment = await prisma.subscriptionPayment.findUnique({
      where: { razorpayOrderId: entity.order_id },
    });
    if (!payment) return res.status(200).json({ success: true, ignored: true });

    const result = await activateSubscriptionPayment({
      restaurantId: payment.restaurantId,
      subscriptionPaymentId: payment.id,
      razorpayPaymentId: entity.id,
      paymentMethod: entity.method || null,
    });

    return res.status(200).json({
      success: true,
      alreadyPaid: result.alreadyPaid,
      plan: result.plan || payment.planCode,
      newExpiry: result.newExpiry || null,
    });
  } catch (error) {
    console.error("Subscription webhook error:", error.message);
    return res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
};

/** GET /subscriptions/payments — real payment history for this restaurant */
const getPaymentHistory = async (req, res) => {
  try {
    const rows = await prisma.subscriptionPayment.findMany({
      where: { restaurantId: req.user.restaurantId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const data = rows.map((p) => ({
      id: p.id,
      planCode: p.planCode,
      planName: p.planName,
      action: p.action,
      billingCycle: p.billingCycle,
      amount: p.amount,
      status: p.status,
      paymentMethod: p.paymentMethod,
      razorpayOrderId: p.razorpayOrderId, // gateway order (may be null for failed/created)
      razorpayPaymentId: p.razorpayPaymentId, // real gateway reference (may be null for failed/created)
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      errorMessage: p.errorMessage,
    }));
    return successResponse(res, data, "Payment history loaded");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** GET /subscriptions/payments/:id — single payment for the status/details panel */
const getPayment = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return errorResponse(res, "Payment not found", 404);
    }
    const payment = await prisma.subscriptionPayment.findUnique({
      where: { id },
    });
    if (!payment || payment.restaurantId !== req.user.restaurantId) {
      return errorResponse(res, "Payment not found", 404);
    }
    return successResponse(res, {
      id: payment.id,
      planCode: payment.planCode,
      planName: payment.planName,
      action: payment.action,
      billingCycle: payment.billingCycle,
      amount: payment.amount,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      razorpayOrderId: payment.razorpayOrderId,
      razorpayPaymentId: payment.razorpayPaymentId,
      razorpaySignature: payment.razorpaySignature ? "verified" : null,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
      errorMessage: payment.errorMessage,
    }, "Payment details loaded");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** GET /subscriptions/gateway-status — restaurant-safe readiness (no secrets) */
const getGatewayStatus = async (req, res) => {
  try {
    const ready = await isGatewayReady();
    return successResponse(res, { enabled: ready, configured: ready }, "Payment gateway status");
  } catch (error) {
    return successResponse(res, { enabled: false, configured: false }, "Payment gateway status");
  }
};

/** POST /subscriptions/downgrade — schedule a lower plan for the next renewal */
const scheduleDowngrade = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { planId } = req.body;
    const subscription = await prisma.subscription.findUnique({ where: { restaurantId } });
    if (!subscription) return errorResponse(res, "No subscription found", 404);

    const plan = await prisma.plan.findUnique({ where: { id: Number(planId) } });
    if (!plan || !plan.isActive) return errorResponse(res, "Selected plan is not available", 400);
    if (plan.code === "TRIAL") return errorResponse(res, "Cannot schedule the Trial plan", 400);

    // Same-cycle comparison against the current plan's price.
    const currentPlan = await prisma.plan.findUnique({ where: { id: subscription.planId } });
    const currentPrice = currentPlan
      ? planPrice(currentPlan, subscription.billingCycle)
      : Number(subscription.amount || 0);
    if (planPrice(plan, subscription.billingCycle) >= currentPrice) {
      return errorResponse(res, "Only lower-priced plans can be scheduled as a downgrade", 400);
    }

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { scheduledPlanId: plan.id },
    });
    await prisma.subscriptionHistory.create({
      data: {
        restaurantId,
        changeType: "DOWNGRADE",
        previousPlanId: subscription.planId,
        newPlanId: plan.id,
        previousPlan: subscription.plan,
        newPlan: plan.code,
        previousStatus: subscription.status,
        newStatus: subscription.status,
        billingCycle: subscription.billingCycle,
        amount: planPrice(plan, subscription.billingCycle),
        expiryDate: subscription.expiryDate,
        changedBy: req.user.id,
        notes: "Downgrade scheduled by restaurant admin (effective at next renewal)",
      },
    });
    const fresh = await getRestaurantSubscription(restaurantId);
    return successResponse(res, fresh, "Downgrade scheduled for your next renewal");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/** DELETE /subscriptions/downgrade — cancel a scheduled downgrade */
const cancelScheduledDowngrade = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    await prisma.subscription.update({
      where: { restaurantId },
      data: { scheduledPlanId: null },
    });
    const fresh = await getRestaurantSubscription(restaurantId);
    return successResponse(res, fresh, "Scheduled downgrade cancelled");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

module.exports = {
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
};
