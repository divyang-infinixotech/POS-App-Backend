/**
 * Centralized email service — the ONLY place that talks to SMTP.
 *
 * Architecture (never bypass this service from a controller):
 *   1. Every outbound email is recorded in the EmailLog table FIRST (status
 *      PENDING) with an idempotency key. This is the durable queue.
 *   2. The row is then delivered immediately (same process, fire-and-await).
 *   3. Delivery failure NEVER throws to the caller by default — the row stays
 *      PENDING/FAILED and the email queue worker retries with bounded
 *      attempts. This is what guarantees "email failure must not corrupt
 *      onboarding": a failed approval email can never roll back a created
 *      restaurant.
 *   4. The caller may request synchronous failure (used by the OTP email,
 *      where the applicant must KNOW that no verification code was sent).
 *
 * Sensitive material rules:
 *   - OTP plaintext and temporary passwords may exist ONLY inside the EmailLog
 *     payload column (needed to render retries) and are removed as soon as the
 *     email is SENT. They are never logged and never returned by any API.
 *   - SMTP password never enters this module — it lives in email.config.
 */
const { platformPrisma: prisma } = require("../config/tenantPrisma");
const { getEmailConfig } = require("../config/email.config");
const { renderTemplate } = require("../templates/email.templates");
const { normalizeEmail, isValidEmail } = require("../utils/email");
const logger = require("../logger/logger");

const RETRY_BACKOFF_MS = 60 * 1000; // min spacing between delivery attempts

function maskEmail(email) {
  const e = String(email || "");
  const at = e.indexOf("@");
  if (at <= 0) return "***";
  const local = e.slice(0, at);
  return `${local.slice(0, 2)}***${e.slice(at)}`;
}

/**
 * Strip OTP/password material from a payload once delivery succeeded.
 * Sensitive values live in payload.data.* AND inside the rendered html/text
 * strings — both are removed so nothing sensitive lingers in the database.
 * Non-sensitive payloads keep their rendered content (useful for support).
 */
function sanitizePayloadForDone(payload) {
  if (!payload || typeof payload !== "object") return payload || null;
  const clone = { ...payload };
  const data = clone.data && typeof clone.data === "object" ? { ...clone.data } : null;
  const hadSensitive = !!(data && ("otp" in data || "temporaryPassword" in data));
  if (data) {
    delete data.otp;
    delete data.temporaryPassword;
    clone.data = data;
  }
  if (hadSensitive) {
    // The rendered html/text embed the OTP / temporary password — drop them.
    delete clone.html;
    delete clone.text;
  }
  clone.sanitized = true;
  return clone;
}

/** Resolve support contact info used by every template footer. */
function supportContacts(cfg) {
  return {
    supportEmail: cfg.fromEmail || process.env.MAIL_FROM_EMAIL || "",
    supportPhone: "",
  };
}

/**
 * Deliver one EmailLog row through SMTP. Returns { ok, error }.
 * Transport construction mirrors email.config.verifySmtp.
 */
async function deliver(row) {
  const cfg = await getEmailConfig();
  if (!cfg.enabled) return { ok: false, error: "Email service is disabled" };
  if (!cfg.host || !cfg.fromEmail) return { ok: false, error: "SMTP is not configured (host/from email missing)" };

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10 * 1000,
    greetingTimeout: 10 * 1000,
    socketTimeout: 15 * 1000,
  });
  try {
    const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;
    const info = await transporter.sendMail({
      from,
      to: row.to,
      subject: row.subject,
      html: row.payloadHtml || undefined,
      text: row.payloadText || undefined,
      replyTo: cfg.replyTo || undefined,
    });
    return { ok: true, messageId: info && info.messageId };
  } finally {
    try { transporter.close(); } catch (_) { /* ignore */ }
  }
}

/**
 * Core enqueue+send. Accepts:
 *   { to, template, data, idempotencyKey, maxAttempts }
 *
 * Idempotency: when a row with the same idempotencyKey already exists the
 * function is a no-op returning that row — retries and double-clicks can
 * never send duplicate credential/application emails.
 *
 * Returns the EmailLog row. `throwOnError` (opts) rethrows on immediate SMTP
 * failure for callers that must surface the failure to the user (OTP email).
 */
async function enqueueEmail({ to, template, data, idempotencyKey, maxAttempts = 3 }, opts = {}) {
  const recipient = normalizeEmail(to);
  if (!isValidEmail(recipient)) {
    logger.warn(`[Email] Refused send to invalid recipient (${maskEmail(recipient)}) template=${template}`);
    const err = new Error("Invalid recipient email address");
    err.statusCode = 400;
    throw err;
  }

  // Idempotent replay — return the existing row untouched.
  if (idempotencyKey) {
    const existing = await prisma.emailLog.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
  }

  const cfg = await getEmailConfig();

  // General-notification switch (§19): OTP/verification email is transactional
  // (opts.general === false) and is NEVER suppressed. Marketing-style
  // notification emails are skipped while the Super Admin switch is OFF —
  // no EmailLog row is created for them.
  if (opts.general !== false && cfg && cfg.generalNotificationsEnabled === false) {
    logger.info(`[Email] Skipped (general notifications disabled) template=${template} to=${maskEmail(recipient)}`);
    return null;
  }

  const contacts = supportContacts(cfg);
  const rendered = renderTemplate(template, { ...data, ...contacts });

  const row = await prisma.emailLog.create({
    data: {
      to: recipient,
      template,
      subject: rendered.subject,
      payload: {
        data: data || {},
        html: rendered.html,
        text: rendered.text,
      },
      status: "PENDING",
      attempts: 0,
      maxAttempts: Math.max(1, Number(maxAttempts) || 3),
      idempotencyKey: idempotencyKey || null,
    },
  });

  return deliverQueuedRow(row, opts);
}

/**
 * Attempt delivery of a queued row exactly once, updating status/attempts.
 * Shared by enqueueEmail and the queue worker.
 */
async function deliverQueuedRow(row, opts = {}) {
  const payload = row.payload || {};
  const claimed = await prisma.emailLog.updateMany({
    where: { id: row.id, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "SENDING", attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    // Another worker already claimed it — return the fresh row.
    return prisma.emailLog.findUnique({ where: { id: row.id } });
  }

  const attempts = (row.attempts || 0) + 1;

  try {
    const result = await deliver({
      to: row.to,
      subject: row.subject,
      payloadHtml: payload.html,
      payloadText: payload.text,
    });
    if (result.ok) {
      const done = await prisma.emailLog.update({
        where: { id: row.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          lastError: null,
          // OTP / temporary password material is removed after a successful
          // send — it must never linger in the database.
          payload: sanitizePayloadForDone(payload),
        },
      });
      logger.info(`[Email] EMAIL_SENT template=${row.template} to=${maskEmail(row.to)} attempts=${attempts} id=${row.id}`);
      return done;
    }
    throw new Error(result.error || "SMTP delivery failed");
  } catch (e) {
    const message = String(e.message || "SMTP delivery failed").slice(0, 500);
    const terminal = attempts >= (row.maxAttempts || 3);
    const updated = await prisma.emailLog.update({
      where: { id: row.id },
      data: {
        status: terminal ? "FAILED" : "PENDING",
        lastError: message,
        failedAt: terminal ? new Date() : null,
      },
    });
    logger.error(`[Email] EMAIL_FAILED template=${row.template} to=${maskEmail(row.to)} attempts=${attempts}/${row.maxAttempts} id=${row.id}: ${message}`);
    if (opts.throwOnError) {
      const err = new Error(message.startsWith("Unable") ? message : "Unable to send email. Please try again later.");
      err.statusCode = 502;
      err.emailLogId = row.id;
      throw err;
    }
    return updated;
  }
}

/**
 * Queue-worker pass: retries PENDING/FAILED rows older than the backoff
 * window. Returns the number of rows processed. Called by the email cron.
 */
async function processEmailQueue(limit = 20) {
  const cutoff = new Date(Date.now() - RETRY_BACKOFF_MS);
  const rows = await prisma.emailLog.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      attempts: { lt: 3 },
      updatedAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(100, Math.max(1, limit)),
  });
  for (const row of rows) {
    try {
      await deliverQueuedRow(row);
    } catch (e) {
      logger.error(`[Email] Queue retry crashed for id=${row.id}: ${e.message}`);
    }
  }
  return rows.length;
}

/**
 * Super Admin "Resend" for a specific EmailLog row. Re-delivers the SAME
 * content — for credential emails the plaintext temporary password is still
 * present in the payload because it was only sanitized after a SUCCESSFUL
 * send, so a resend never needs to generate (or recover) a new password.
 * Rows already sent AND sanitized cannot be resent (no plaintext left).
 */
async function resendEmailLog(id) {
  const row = await prisma.emailLog.findUnique({ where: { id: Number(id) } });
  if (!row) {
    const err = new Error("Email log entry not found");
    err.statusCode = 404;
    throw err;
  }
  if (row.status === "SENT" && row.payload && typeof row.payload === "object" && row.payload.sanitized) {
    const err = new Error("This email was already delivered and its secure content has been removed. Trigger the event again instead.");
    err.statusCode = 400;
    throw err;
  }
  await prisma.emailLog.update({
    where: { id: row.id },
    data: { status: "PENDING", failedAt: null },
  });
  return deliverQueuedRow({ ...row, status: "PENDING" });
}

// ─── Reusable high-level senders (one per business event) ─────────────────────

/** Onboarding OTP — synchronous failure surfaces to the applicant. */
function sendOtpEmail({ to, otp, applicantName, restaurantName, purpose = "ONBOARDING", expiresInMinutes = 10 }) {
  const template = purpose === "EMAIL_CHANGE" ? "EMAIL_CHANGE_OTP" : "EMAIL_VERIFICATION_OTP";
  return enqueueEmail(
    { to, template, data: { otp, applicantName, restaurantName, expiresInMinutes }, maxAttempts: 3 },
    // Transactional: never suppressed by the general-notifications switch.
    { throwOnError: true, general: false }
  );
}

function sendNewApplicationEmail({ to, applicantName, applicantEmail, applicantPhone, restaurantName, businessType, city, state, applicationRef, submittedAt, frontendUrl }) {
  const cfgSupport = {};
  return enqueueEmail({
    to,
    template: "APPLICATION_SUBMITTED_ADMIN",
    data: {
      applicantName, applicantEmail, applicantPhone, restaurantName,
      businessType, city, state, applicationRef, submittedAt,
      // No deep-linkable SA route exists (screen-state frontend) — omit the
      // button rather than fabricate a URL (§18). Info rows carry the data.
      reviewUrl: null,
      ...cfgSupport,
    },
    idempotencyKey: `APPLICATION_SUBMITTED_ADMIN:${applicationRef}`,
    maxAttempts: 5,
  }).catch((e) => {
    logger.error(`[Email] APPLICATION_SUBMITTED_ADMIN send failed (non-critical): ${e.message}`);
    return null;
  });
}

function sendApplicationReceivedEmail({ to, applicantName, restaurantName, applicationRef, submittedAt }) {
  return enqueueEmail({
    to,
    template: "APPLICATION_SUBMITTED_APPLICANT",
    data: { applicantName, restaurantName, applicationRef, submittedAt },
    idempotencyKey: `APPLICATION_SUBMITTED_APPLICANT:${applicationRef}`,
    maxAttempts: 5,
  }).catch((e) => {
    logger.error(`[Email] APPLICATION_SUBMITTED_APPLICANT send failed (non-critical): ${e.message}`);
    return null;
  });
}

function sendApplicationApprovedEmail({ to, applicantName, restaurantName, applicationRef, approvedAt, planName, loginUrl }) {
  return enqueueEmail({
    to,
    template: "APPLICATION_APPROVED",
    data: { applicantName, restaurantName, applicationRef, approvedAt, planName, loginUrl },
    idempotencyKey: `APPLICATION_APPROVED:${applicationRef}`,
    maxAttempts: 5,
  }).catch((e) => {
    logger.error(`[Email] APPLICATION_APPROVED send failed (non-critical): ${e.message}`);
    return null;
  });
}

function sendApplicationRejectedEmail({ to, applicantName, restaurantName, applicationRef, decidedAt, reason }) {
  return enqueueEmail({
    to,
    template: "APPLICATION_REJECTED",
    data: {
      applicantName, restaurantName, applicationRef, decidedAt,
      reason: reason ? String(reason).slice(0, 500) : null,
      resubmissionNote: "If you believe this was a mistake, contact support or submit a new application.",
    },
    idempotencyKey: `APPLICATION_REJECTED:${applicationRef}`,
    maxAttempts: 5,
  }).catch((e) => {
    logger.error(`[Email] APPLICATION_REJECTED send failed (non-critical): ${e.message}`);
    return null;
  });
}

function sendApplicationExpiredEmail({ to, applicantName, restaurantName, applicationRef, expiredAt }) {
  return enqueueEmail({
    to,
    template: "APPLICATION_EXPIRED",
    data: { applicantName, restaurantName, applicationRef, expiredAt },
    idempotencyKey: `APPLICATION_EXPIRED:${applicationRef}`,
    maxAttempts: 5,
  }).catch((e) => {
    logger.error(`[Email] APPLICATION_EXPIRED send failed (non-critical): ${e.message}`);
    return null;
  });
}

/**
 * Admin credentials. The temporary password travels ONLY inside the queued
 * payload (removed from the DB after a successful send) and is never logged.
 * `keySuffix` lets a later credential email (e.g. an SA password reset) for
 * the SAME address get its own idempotency key instead of being silently
 * deduplicated against the original welcome email.
 */
function sendUserCredentialsEmail({ to, adminName, restaurantName, loginEmail, temporaryPassword, loginUrl, keySuffix }) {
  return enqueueEmail({
    to,
    template: "WELCOME_ADMIN_CREDENTIALS",
    data: { adminName, restaurantName, loginEmail, temporaryPassword, loginUrl },
    idempotencyKey: `WELCOME_ADMIN_CREDENTIALS:${loginEmail}${keySuffix ? ":" + keySuffix : ""}`,
    maxAttempts: 5,
  }).catch((e) => {
    logger.error(`[Email] WELCOME_ADMIN_CREDENTIALS send failed (non-critical): ${e.message}`);
    return null;
  });
}

function sendPasswordResetEmail({ to, name, temporaryPassword, loginUrl }) {
  return enqueueEmail({
    to,
    template: "PASSWORD_RESET",
    data: { name, temporaryPassword, loginUrl },
    idempotencyKey: `PASSWORD_RESET:${to}:${Date.now()}`,
    maxAttempts: 3,
  }).catch((e) => {
    logger.error(`[Email] PASSWORD_RESET send failed (non-critical): ${e.message}`);
    return null;
  });
}

function sendEmailVerificationEmail({ to, otp, applicantName, restaurantName, expiresInMinutes }) {
  return sendOtpEmail({ to, otp, applicantName, restaurantName, expiresInMinutes });
}

/**
 * EMAIL_VERIFIED — confirmation sent when the applicant's OTP check succeeds.
 * Transactional (not gated by the general switch).
 */
function sendEmailVerifiedEmail({ to, applicantName, restaurantName, applicationUrl }) {
  return enqueueEmail(
    {
      to,
      template: "EMAIL_VERIFIED",
      data: { applicantName, restaurantName, applicationUrl },
      idempotencyKey: `EMAIL_VERIFIED:${to}:${Date.now()}`,
      maxAttempts: 3,
    },
    { general: false }
  ).catch((e) => {
    logger.error(`[Email] EMAIL_VERIFIED send failed (non-critical): ${e.message}`);
    return null;
  });
}

/**
 * APPLICATION_EXPIRING — pre-expiry reminder. The caller (cron) guarantees
 * "exactly once" via its reminder-sent timestamps.
 */
function sendApplicationExpiringEmail({ to, applicantName, restaurantName, applicationRef, expiresAt, applicationUrl }) {
  return enqueueEmail({
    to,
    template: "APPLICATION_EXPIRING",
    data: { applicantName, restaurantName, applicationRef, expiresAt, applicationUrl },
    idempotencyKey: `APPLICATION_EXPIRING:${applicationRef}:${Date.now()}`,
    maxAttempts: 3,
  }).catch((e) => {
    logger.error(`[Email] APPLICATION_EXPIRING send failed (non-critical): ${e.message}`);
    return null;
  });
}

/**
 * PASSWORD_CHANGE_REQUIRED — nudge email when an account still carries the
 * temporary-password flag. Contains no credential material whatsoever.
 */
function sendPasswordChangeRequiredEmail({ to, name, loginUrl }) {
  return enqueueEmail({
    to,
    template: "PASSWORD_CHANGE_REQUIRED",
    data: { name, loginUrl },
    idempotencyKey: `PASSWORD_CHANGE_REQUIRED:${to}:${Date.now()}`,
    maxAttempts: 3,
  }).catch((e) => {
    logger.error(`[Email] PASSWORD_CHANGE_REQUIRED send failed (non-critical): ${e.message}`);
    return null;
  });
}

/**
 * GENERIC_NOTIFICATION — reusable single-message notification. Used only
 * where no specific template exists; never for credential material.
 */
function sendGenericNotificationEmail({ to, recipientName, subject, message, buttonText, buttonUrl }) {
  return enqueueEmail({
    to,
    template: "GENERIC_NOTIFICATION",
    data: { recipientName, subject, message, buttonText, buttonUrl },
    idempotencyKey: `GENERIC_NOTIFICATION:${to}:${Date.now()}`,
    maxAttempts: 3,
  }).catch((e) => {
    logger.error(`[Email] GENERIC_NOTIFICATION send failed (non-critical): ${e.message}`);
    return null;
  });
}

module.exports = {
  enqueueEmail,
  deliverQueuedRow,
  processEmailQueue,
  resendEmailLog,
  sanitizePayloadForDone,
  sendOtpEmail,
  sendNewApplicationEmail,
  sendApplicationReceivedEmail,
  sendApplicationApprovedEmail,
  sendApplicationRejectedEmail,
  sendApplicationExpiredEmail,
  sendUserCredentialsEmail,
  sendPasswordResetEmail,
  sendEmailVerificationEmail,
  sendEmailVerifiedEmail,
  sendApplicationExpiringEmail,
  sendPasswordChangeRequiredEmail,
  sendGenericNotificationEmail,
};
