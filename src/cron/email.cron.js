/**
 * Email cron — two independent passes on one scheduler (never a second
 * scheduler process; server.js wires it like the subscription cron).
 *
 * Pass 1 — Email queue worker:
 *   processEmailQueue() retries PENDING/FAILED EmailLog rows (bounded
 *   attempts, backoff). Delivery failures never corrupt onboarding: the rows
 *   stay queued and every pass makes another attempt.
 *
 * Pass 2 — Application expiry:
 *   Self-serve applications left in MANUAL_PENDING / MANUAL_PAYMENT_PENDING /
 *   MANUAL_PAYMENT_RECEIVED past applicationExpiresAt are marked EXPIRED.
 *   expiredNotificationSentAt guarantees the applicant email + audit +
 *   notification fire EXACTLY once (subsequent cron runs skip sent ones).
 */
const cron = require("node-cron");
const { platformPrisma: prisma } = require("../config/tenantPrisma");
const { processEmailQueue, sendApplicationExpiredEmail, sendApplicationExpiringEmail } = require("../services/email.service");
const { createAuditLog } = require("../services/audit.service");
const { createNotification } = require("../services/notification.service");
const { getLoginUrl } = require("../utils/frontendUrl");

const EMAIL_RETRY_SCHEDULE = "*/5 * * * *"; // every 5 minutes
const EXPIRY_SCAN_SCHEDULE = "*/30 * * * *"; // every 30 minutes
const MANUAL_IN_FLIGHT = ["MANUAL_PENDING", "MANUAL_PAYMENT_PENDING", "MANUAL_PAYMENT_RECEIVED"];
const REMINDER_WINDOW_DAYS = 7; // remind once when expiry is within 7 days

/** Server-configured applicant URL — login resumes the wizard server-side. */
function applicantUrl() {
  return getLoginUrl();
}

async function runEmailQueuePass() {
  try {
    const processed = await processEmailQueue(25);
    if (processed > 0) {
      console.log(`[EmailCron] Queue pass processed ${processed} email(s).`);
    }
  } catch (e) {
    console.error("[EmailCron] Queue pass failed:", e.message);
  }
}

async function runApplicationExpiryPass() {
  try {
    const now = new Date();
    // Only rows whose expiry email has NOT been sent are candidates — this is
    // the "exactly once" idempotency guarantee (expiredNotificationSentAt).
    const candidates = await prisma.restaurant.findMany({
      where: {
        applicationExpiresAt: { lte: now },
        expiredNotificationSentAt: null,
        selfServe: true,
        status: "INACTIVE",
        onboardingStatus: { in: MANUAL_IN_FLIGHT },
        deletedAt: null,
      },
      select: { id: true, name: true, email: true, ownerName: true, onboardingStatus: true },
      take: 50,
    });
    // The reference number is DERIVED (never stored): APP-0001 style.
    const refFor = (app) => `APP-${String(app.id).padStart(4, "0")}`;
    for (const app of candidates) {
      // The greeting carries the PERSON (owner) when known — the restaurant
      // name belongs in the restaurant field of the template. The applicant
      // record's own name is the honest fallback (never a fabricated one).
      const applicantName = app.ownerName || app.name;
      try {
        const expiredAt = new Date();
        await prisma.restaurant.update({
          where: { id: app.id },
          data: { onboardingStatus: "EXPIRED", expiredNotificationSentAt: expiredAt },
        });

        // Platform audit + notification (platform scope — no tenant exists).
        try {
          await createAuditLog(
            {
              restaurantId: app.id,
              userId: null,
              module: "ONBOARDING",
              action: "UPDATE",
              description: `Application ${refFor(app)} for "${app.name}" expired after inactivity`,
              referenceId: app.id,
              referenceNo: refFor(app),
            },
            prisma
          );
          await createNotification(prisma, {
            restaurantId: app.id,
            userId: null,
            title: "Application Expired",
            message: `Application for "${app.name}" (${refFor(app)}) expired after inactivity.`,
            type: "WARNING",
          });
        } catch (auditErr) {
          console.error("[EmailCron] Expiry audit/notification failed (non-critical):", auditErr.message);
        }

        // Applicant email — idempotency key also prevents duplicate sends.
        if (app.email) {
          await sendApplicationExpiredEmail({
            to: app.email,
            applicantName,
            restaurantName: app.name,
            applicationRef: refFor(app),
            expiredAt,
            applicationUrl: applicantUrl(),
          });
        }

        console.log(`[EmailCron] Application ${refFor(app)} expired.`);
      } catch (appErr) {
        console.error(`[EmailCron] Expiry failed for application ${app.id}:`, appErr.message);
      }
    }
  } catch (e) {
    console.error("[EmailCron] Expiry pass failed:", e.message);
  }
}

/**
 * Expiry reminder (spec §15): one reminder when a still-in-flight application
 * expires within the next REMINDER_WINDOW_DAYS. Deduplicated by scanning the
 * EmailLog — an APPLICATION_EXPIRING row for this recipient means the reminder
 * already went out (no extra schema column needed).
 */
async function runApplicationReminderPass() {
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const candidates = await prisma.restaurant.findMany({
      where: {
        applicationExpiresAt: { gte: now, lte: windowEnd },
        selfServe: true,
        status: "INACTIVE",
        onboardingStatus: { in: MANUAL_IN_FLIGHT },
        deletedAt: null,
      },
      select: { id: true, name: true, email: true, ownerName: true },
      take: 50,
    });
    for (const app of candidates) {
      if (!app.email) continue;
      try {
        const alreadyReminded = await prisma.emailLog.findFirst({
          where: { to: app.email, template: "APPLICATION_EXPIRING" },
          select: { id: true },
        });
        if (alreadyReminded) continue;
        await sendApplicationExpiringEmail({
          to: app.email,
          applicantName: app.ownerName || app.name,
          restaurantName: app.name,
          applicationRef: `APP-${String(app.id).padStart(4, "0")}`,
          expiresAt: new Date(app.applicationExpiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }),
          applicationUrl: applicantUrl(),
        });
        console.log(`[EmailCron] Expiry reminder sent for application ${app.id}.`);
      } catch (remErr) {
        console.error(`[EmailCron] Reminder failed for application ${app.id}:`, remErr.message);
      }
    }
  } catch (e) {
    console.error("[EmailCron] Reminder pass failed:", e.message);
  }
}

const emailCronJob = () => {
  cron.schedule(EMAIL_RETRY_SCHEDULE, runEmailQueuePass);
  cron.schedule(EXPIRY_SCAN_SCHEDULE, runApplicationExpiryPass);
  cron.schedule(EXPIRY_SCAN_SCHEDULE, runApplicationReminderPass);
};

module.exports = emailCronJob;
module.exports.runEmailQueuePass = runEmailQueuePass;
module.exports.runApplicationExpiryPass = runApplicationExpiryPass;
module.exports.runApplicationReminderPass = runApplicationReminderPass;
