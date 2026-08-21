/**
 * Razorpay gateway wrapper for subscription upgrade/renewal purchases.
 *
 * - The client is created lazily so the backend boots fine without keys.
 * - `checkout` creates a Razorpay Order (amount in paise) and records a
 *   SubscriptionPayment row in CREATED state.
 * - `activateSubscriptionPayment` is the ONLY place that changes the
 *   subscription (plan/expiry/features). It runs in a transaction, is
 *   idempotent (replayed callbacks / duplicate webhooks are no-ops), and is
 *   called only after the payment signature has been verified server-side.
 */
const crypto = require("crypto");
const Razorpay = require("razorpay");
const prisma = require("../config/prisma");
const { computeExpiryDate, planToSnapshot } = require("../utils/subscription");
const gatewayConfig = require("./gateway-config.service");

// The Razorpay SDK client is cached but re-created when the key pair changes
// (e.g. after a Super Admin updates the config at runtime).
let client = null;
let clientKey = null;

async function getClient() {
  const cfg = await gatewayConfig.getGatewayConfig();
  if (!cfg.enabled || !cfg.keyId || !cfg.keySecret) {
    const err = new Error("Payment gateway is not configured. Contact your Super Admin to set up online payments.");
    err.statusCode = 503;
    throw err;
  }
  const key = `${cfg.keyId}:${cfg.keySecret.slice(-6)}`;
  if (client && clientKey === key) return client;
  client = new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret });
  clientKey = key;
  return client;
}

/** Create a Razorpay order for `amount` INR. Receipt is a short unique id. */
async function createRazorpayOrder({ amount, receipt }) {
  const rzp = await getClient();
  const order = await rzp.orders.create({
    amount: Math.round(Number(amount) * 100), // paise
    currency: "INR",
    receipt: String(receipt).slice(0, 40),
    notes: { source: "restaurant-pos-subscription" },
  });
  return order;
}

/**
 * Server-side verification of the payment callback. Returns true only when the
 * HMAC signature over `order_id|payment_id` matches — never trust the client.
 *
 * Implemented with node crypto directly: the razorpay SDK bundle (2.9.8) does
 * NOT expose rzp.utils.verifyPaymentSignature (it throws and the callback was
 * always rejected). The math is identical to the SDK's: hex HMAC-SHA256 of
 * `${order_id}|${payment_id}` with the gateway key secret, compared with a
 * timing-safe equality. Uses the stored gateway secret directly so a payment
 * made while the gateway was enabled remains verifiable even if the Super
 * Admin disables the gateway afterwards.
 */
async function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  try {
    const cfg = await gatewayConfig.getGatewayConfig();
    if (!cfg.keySecret) return false;
    const expected = crypto
      .createHmac("sha256", cfg.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(String(signature), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/** Verify a Razorpay webhook signature against the raw request body. */
async function verifyWebhookSignature(rawBody, signature) {
  const cfg = await gatewayConfig.getGatewayConfig();
  const secret = cfg.webhookSecret;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Current expiry anchor for renewals/upgrades (never goes backwards). */
function computeBaseExpiry(subscription) {
  const now = new Date();
  if (subscription.expiryDate && new Date(subscription.expiryDate) > now) {
    return new Date(subscription.expiryDate);
  }
  return now;
}

/**
 * Idempotent activation of a paid subscription purchase.
 * - Replay/duplicate (status already PAID) → no-op, returns the existing row.
 * - Otherwise updates Subscription (plan snapshot, limits, features, expiry),
 *   the Restaurant denormalized plan, and appends SubscriptionHistory.
 * @param {object} params { restaurantId, subscriptionPaymentId, razorpayPaymentId, razorpaySignature, paymentMethod }
 */
async function activateSubscriptionPayment(params) {
  const {
    restaurantId,
    subscriptionPaymentId,
    razorpayPaymentId,
    razorpaySignature,
    paymentMethod,
  } = params;

  const result = await prisma.$transaction(async (tx) => {
    const sp = await tx.subscriptionPayment.findUnique({
      where: { id: Number(subscriptionPaymentId) },
    });
    if (!sp || sp.restaurantId !== Number(restaurantId)) {
      const err = new Error("Subscription payment not found");
      err.statusCode = 404;
      throw err;
    }

    // Idempotency: a replayed callback / duplicate webhook must never extend again
    if (sp.status === "PAID") {
      return { alreadyPaid: true, payment: sp };
    }

    const plan = await tx.plan.findUnique({ where: { id: sp.planId } });
    if (!plan || !plan.isActive) {
      const err = new Error("Selected plan is no longer available");
      err.statusCode = 400;
      throw err;
    }

    const subscription = await tx.subscription.findUnique({
      where: { restaurantId: Number(restaurantId) },
    });
    if (!subscription) {
      const err = new Error("No subscription found for this restaurant");
      err.statusCode = 404;
      throw err;
    }

    // Mark the payment paid FIRST (source of truth for the purchase). The
    // update is CONDITIONAL (status != PAID): concurrent verify calls and
    // duplicate webhooks race here, and exactly ONE transaction can win the
    // CREATED/FAILED → PAID flip. The loser returns alreadyPaid below, so the
    // subscription is never activated twice and SubscriptionHistory never
    // gets a duplicate row.
    const claimed = await tx.subscriptionPayment.updateMany({
      where: { id: sp.id, status: { not: "PAID" } },
      data: {
        status: "PAID",
        razorpayPaymentId,
        razorpaySignature: razorpaySignature || null,
        paymentMethod: paymentMethod || null,
        paidAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      // Another request already activated this payment (or the row changed).
      const fresh = await tx.subscriptionPayment.findUnique({ where: { id: sp.id } });
      return { alreadyPaid: true, payment: fresh };
    }

    // ── Business rule: renew/upgrade extends from the CURRENT expiry when it
    // is still in the future (never discards remaining paid days); an expired
    // subscription starts from today.
    const base = computeBaseExpiry(subscription);
    const newExpiry = computeExpiryDate(base, sp.billingCycle);
    const snapshot = planToSnapshot(plan, sp.billingCycle);

    // Same-cycle price comparison (the purchased cycle), never a stored amount
    // that may belong to a different billing cycle.
    const currentPlan = subscription.planId ? await tx.plan.findUnique({ where: { id: subscription.planId } }) : null;
    const prevPrice =
      currentPlan && sp.billingCycle === "YEARLY"
        ? Number(currentPlan.yearlyPrice || 0)
        : currentPlan
          ? Number(currentPlan.monthlyPrice || 0)
          : Number(subscription.amount || 0);
    const newPrice = sp.billingCycle === "YEARLY" ? Number(plan.yearlyPrice || 0) : Number(plan.monthlyPrice || 0);
    // History classification mirrors the purchase action: same plan → RENEWAL,
    // higher-priced → UPGRADE, equal/lower-priced different plan → SWITCH.
    const changeType = sp.action === "RENEWAL"
      ? "RENEWAL"
      : newPrice > prevPrice
        ? "UPGRADE"
        : "SWITCH";

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: plan.id,
        plan: plan.code,
        status: "ACTIVE",
        startDate: subscription.startDate || base,
        expiryDate: newExpiry,
        nextRenewalDate: newExpiry,
        billingCycle: sp.billingCycle,
        amount: snapshot.amount,
        autoRenew: snapshot.autoRenew,
        maxUsers: snapshot.maxUsers,
        maxTables: snapshot.maxTables,
        maxFloors: snapshot.maxFloors,
        maxMenuItems: snapshot.maxMenuItems,
        maxPrinters: snapshot.maxPrinters,
        maxBranches: snapshot.maxBranches,
        maxOrdersPerMonth: snapshot.maxOrdersPerMonth,
        storageLimitMB: snapshot.storageLimitMB,
        features: snapshot.features,
        scheduledPlanId: null, // purchase clears any scheduled downgrade
        updatedBy: sp.createdBy,
      },
    });

    await tx.restaurant.update({
      where: { id: Number(restaurantId) },
      data: { subscriptionPlan: plan.code, status: "ACTIVE" },
    });

    await tx.subscriptionHistory.create({
      data: {
        restaurantId: Number(restaurantId),
        changeType,
        previousPlanId: subscription.planId,
        newPlanId: plan.id,
        previousPlan: subscription.plan,
        newPlan: plan.code,
        previousStatus: subscription.status,
        newStatus: "ACTIVE",
        billingCycle: sp.billingCycle,
        amount: sp.amount,
        expiryDate: newExpiry,
        changedBy: sp.createdBy,
        notes: `${sp.action} via Razorpay (payment ${razorpayPaymentId || "—"})`,
      },
    });

    // Notify the restaurant (best-effort, never blocks the response)
    try {
      const { createNotification } = require("./notification.service");
      await createNotification({
        restaurantId: Number(restaurantId),
        title: "Subscription Updated",
        message: `Your ${plan.name} plan is now ACTIVE until ${newExpiry.toLocaleDateString("en-IN")}.`,
        type: "SUBSCRIPTION",
      });
    } catch (e) {
      console.error("Subscription notification error:", e.message);
    }

    return { alreadyPaid: false, payment: sp, plan: plan.code, newExpiry };
  });

  // Emit the realtime event ONLY after the transaction committed.
  if (!result.alreadyPaid) {
    emitSubscriptionUpdated(Number(restaurantId), {
      plan: result.plan,
      expiryDate: result.newExpiry,
      status: "ACTIVE",
    });
  }

  return result;
}

/**
 * Best-effort realtime notification after a successful activation.
 * Uses the existing Socket.IO restaurant room — no new connections.
 */
function emitSubscriptionUpdated(restaurantId, payload) {
  try {
    const { emitToRestaurant } = require("./socket");
    emitToRestaurant(Number(restaurantId), "subscription:updated", {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    // Socket layer optional — never block activation on it
  }
}

module.exports = {
  getClient,
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  computeBaseExpiry,
  activateSubscriptionPayment,
};
