const cron = require("node-cron");
const prisma = require("../config/prisma");
const { Prisma } = require("@prisma/client");
const { createAuditLog } = require("../services/audit.service");
const { getExpiryWarningLevel, addDays } = require("../utils/subscription");

// Deterministic notification titles used BOTH for display and for idempotent
// deduplication — a restaurant never receives the same expiry warning twice,
// no matter how often the cron runs (or how many processes run it).
const EXPIRY_NOTIFICATION_TITLES = {
  "7": "Subscription Expires in 7 Days",
  "3": "Subscription Expires in 3 Days",
  "1": "Subscription Expires Tomorrow",
};

/**
 * Expiry-soon notification copy. The day count is ALWAYS recomputed from the
 * real expiry date (same ceil math as the dashboard/header) so the message
 * never claims a wrong number, even when the cron first sees a subscription
 * mid-bucket (e.g. 5 days remaining after the app was offline).
 */
function expirySoonMessage(planName, level, expiryDate) {
  const plan = planName || "Your plan";
  if (!expiryDate) return `Your ${plan} plan is expiring soon. Renew soon to avoid interruption.`;
  const days = Math.max(1, Math.ceil((new Date(expiryDate) - Date.now()) / 86400000));
  if (days <= 1) return `Your ${plan} plan expires tomorrow. Renew now to keep using the POS.`;
  if (days <= 3) return `Your ${plan} plan expires in ${days} days. Renew now to keep using the POS.`;
  return `Your ${plan} plan expires in ${days} days. Renew soon to avoid interruption.`;
}

/**
 * Idempotent expiry-soon notification. Created only when no SUBSCRIPTION
 * notification with the exact deterministic title already exists for this
 * restaurant. Runs inside the caller's transaction with SERIALIZABLE
 * isolation so two cron processes executing close together can never both
 * pass the existence check and both insert.
 */
async function notifyExpirySoonIfNeeded(tx, subscription) {
  const level = getExpiryWarningLevel(subscription);
  if (!level || level === "0") return false; // 0 → handled by the EXPIRED branch
  const title = EXPIRY_NOTIFICATION_TITLES[level];
  if (!title) return false;

  const existing = await tx.notification.findFirst({
    where: { restaurantId: subscription.restaurantId, type: "SUBSCRIPTION", title },
    select: { id: true },
  });
  if (existing) return false;

  const planName = subscription.planDef && subscription.planDef.name
    ? subscription.planDef.name
    : subscription.plan;
  const message = expirySoonMessage(planName, level, subscription.expiryDate);

  // Notify every active admin (or a restaurant-level row when no admins exist)
  const admins = await tx.user.findMany({
    where: { restaurantId: subscription.restaurantId, role: "ADMIN", isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (admins.length > 0) {
    await tx.notification.createMany({
      data: admins.map((a) => ({
        restaurantId: subscription.restaurantId,
        userId: a.id,
        title,
        message,
        type: "SUBSCRIPTION",
      })),
    });
  } else {
    await tx.notification.create({
      data: {
        restaurantId: subscription.restaurantId,
        title,
        message,
        type: "SUBSCRIPTION",
      },
    });
  }
  return true;
}

/**
 * One full expiry pass (warnings + flips). Idempotent and safe to run
 * repeatedly AND concurrently:
 *  - The expiry flip uses a CONDITIONAL updateMany (status still ACTIVE/TRIAL),
 *    so even two processes that both selected the same row can only have ONE
 *    winner — the loser's count is 0 and it creates no history/notification/
 *    audit row.
 *  - Warning notifications are check-then-create inside a SERIALIZABLE
 *    transaction, so a concurrent pass cannot double-insert.
 * The pass NEVER modifies expiry dates, plans, or payments, and never performs
 * a paid upgrade/renewal — payment is the only path that activates a purchase.
 */
async function runExpiryPass() {
  const logger = require("../logger/logger");
  const now = new Date();
  const inSevenDays = addDays(now, 7);

  try {
    // ── 1. Expiry-soon warnings (7 / 3 / 1 day) — never duplicates ──
    const expiringSoon = await prisma.subscription.findMany({
      where: {
        status: { in: ["ACTIVE", "TRIAL"] },
        expiryDate: { gt: now, lte: inSevenDays },
      },
      select: {
        id: true,
        restaurantId: true,
        plan: true,
        expiryDate: true,
        planDef: { select: { name: true } },
      },
    });

    for (const subscription of expiringSoon) {
      try {
        await prisma.$transaction(
          async (tx) => {
            await notifyExpirySoonIfNeeded(tx, subscription);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        logger.error(`Expiry-soon notification failed for restaurant ${subscription.restaurantId}:`, error.message);
      }
    }
    logger.info(`${expiringSoon.length} subscription(s) expiring within 7 days checked.`);

    // ── 2. Actual expiry — status EXPIRED + history + notification + audit.
    // The restaurant/users are NOT suspended or deactivated here: the ADMIN
    // must remain able to log in and renew from Subscription & Billing.
    // POS/API access is blocked server-side by the protect/feature middleware
    // for every non-subscription route.
    const expiredSubscriptions = await prisma.subscription.findMany({
      where: {
        expiryDate: { lt: now },
        status: { in: ["ACTIVE", "TRIAL"] },
      },
      select: {
        id: true,
        restaurantId: true,
        plan: true,
        planDef: { select: { name: true } },
      },
    });

    logger.info(`${expiredSubscriptions.length} expired subscription(s) found.`);

    for (const subscription of expiredSubscriptions) {
      try {
        await prisma.$transaction(async (tx) => {
          // Conditional flip — the idempotency lock. Only one concurrent pass
          // can move this row ACTIVE/TRIAL → EXPIRED; the loser skips all side
          // effects (no duplicate history / notification / audit).
          const flipped = await tx.subscription.updateMany({
            where: { id: subscription.id, status: { in: ["ACTIVE", "TRIAL"] } },
            data: { status: "EXPIRED" },
          });
          if (flipped.count !== 1) return;

          // Append-only history record (never overwritten)
          await tx.subscriptionHistory.create({
            data: {
              restaurantId: subscription.restaurantId,
              changeType: "EXPIRATION",
              previousPlanId: null,
              newPlanId: null,
              previousPlan: subscription.plan,
              newPlan: subscription.plan,
              previousStatus: "ACTIVE",
              newStatus: "EXPIRED",
              notes: "Subscription expired automatically",
              changedBy: null,
            },
          });

          // Notify restaurant admins
          const admins = await tx.user.findMany({
            where: {
              restaurantId: subscription.restaurantId,
              role: "ADMIN",
              isActive: true,
              deletedAt: null,
            },
            select: { id: true },
          });

          const planName = subscription.planDef && subscription.planDef.name
            ? subscription.planDef.name
            : subscription.plan;
          const message = `Your ${planName} plan has expired. Please renew to continue using the POS.`;

          if (admins.length > 0) {
            await tx.notification.createMany({
              data: admins.map((a) => ({
                restaurantId: subscription.restaurantId,
                userId: a.id,
                title: "Subscription Expired",
                message,
                type: "SUBSCRIPTION",
              })),
            });
          } else {
            await tx.notification.create({
              data: {
                restaurantId: subscription.restaurantId,
                title: "Subscription Expired",
                message,
                type: "SUBSCRIPTION",
              },
            });
          }

          await createAuditLog(
            {
              restaurantId: subscription.restaurantId,
              userId: null,
              module: "SUBSCRIPTION",
              action: "UPDATE",
              description: `Subscription expired (${subscription.plan})`,
              referenceId: subscription.id,
              referenceNo: subscription.plan,
            },
            tx
          );
        });

        logger.info(`Restaurant ${subscription.restaurantId} marked EXPIRED (renewable).`);
      } catch (error) {
        logger.error(`Restaurant ${subscription.restaurantId} failed:`, error.message);
      }
    }
  } catch (error) {
    logger.error("Subscription Cron Error:", error.message);
  }
}

const subscriptionExpiryJob = () => {
  cron.schedule("0 0 * * *", runExpiryPass);
};

module.exports = subscriptionExpiryJob;
module.exports.runExpiryPass = runExpiryPass;
module.exports.expirySoonMessage = expirySoonMessage;
