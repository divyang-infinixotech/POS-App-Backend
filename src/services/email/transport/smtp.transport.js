/**
 * SMTP transport (Nodemailer) — the LEGACY email delivery mechanism.
 *
 * Extracted verbatim from email.service.deliver() during the Microsoft Graph
 * migration so the transport choice lives in one switchable place
 * (transport/index.js). Behavior, timeouts and result shape are unchanged:
 *   { ok: true, messageId } | { ok: false, error }
 *
 * This module remains ONLY while SMTP config is still supported (Super Admin
 * SMTP settings screen). See transport/index.js for provider selection and
 * docs/microsoft-graph-email.md for the production recommendation.
 */
async function sendViaSmtp(row) {
  const { getEmailConfig } = require("../../../config/email.config");
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

module.exports = { sendViaSmtp };
