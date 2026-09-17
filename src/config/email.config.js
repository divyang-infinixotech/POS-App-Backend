/**
 * Platform email (SMTP) configuration — the single source of truth for how the
 * backend sends email. Mirrors gateway-config.service.js:
 *
 * - Persisted in the existing SystemSetting table under the key
 *   "email_smtp_config" as JSON. The SMTP password is stored AES-256-GCM
 *   encrypted via utils/encryption.js — never plaintext, never returned by any
 *   API, never logged.
 * - Falls back to SMTP_* / MAIL_* environment variables when no saved config
 *   exists (keeps existing deployments working without a migration step).
 * - Read-through caching with a short TTL so an email send does not hit the DB
 *   every time, while a Super Admin save takes effect within seconds.
 * - Super Admin notification recipients + a general notifications ON/OFF
 *   switch live here too. EMAIL VERIFICATION IS NEVER AFFECTED by the
 *   notification switch (see isGeneralEmailEnabled usage) — verification OTP
 *   email must always be deliverable while onboarding requires it.
 */
const prisma = require("./prisma");
const { encryptSecret, decryptSecret, isEncrypted } = require("../utils/encryption");
const { isValidEmail, normalizeEmail } = require("../utils/email");

const SETTING_KEY = "email_smtp_config";
const CACHE_TTL_MS = 5 * 1000;

let cache = { ts: 0, value: null };

/** env-var fallback (used when no Super Admin config is saved). */
function envFallback() {
  return {
    enabled: true,
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    fromName: process.env.MAIL_FROM_NAME || "Nirka POS",
    fromEmail: process.env.MAIL_FROM_EMAIL || "",
    replyTo: process.env.MAIL_REPLY_TO || "",
    superAdminNotificationEmails: String(process.env.SUPER_ADMIN_NOTIFICATION_EMAIL || "")
      .split(",")
      .map((e) => normalizeEmail(e))
      .filter((e) => e && isValidEmail(e)),
    generalNotificationsEnabled: true,
  };
}

/** Load raw stored config (encrypted password) from the SystemSetting table. */
async function loadStoredConfig() {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row || row.value == null) return null;
  const parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
  return { ...parsed, id: parsed.id || row.id };
}

/** Decrypted, backend-only config. Falls back to env vars when unsaved. */
async function getEmailConfig() {
  const now = Date.now();
  if (cache.value && now - cache.ts < CACHE_TTL_MS) return cache.value;

  let stored = null;
  try {
    stored = await loadStoredConfig();
  } catch (_) {
    stored = null;
  }

  const env = envFallback();
  const cfg = stored
    ? {
        enabled: stored.enabled !== false,
        host: stored.host || "",
        port: Number(stored.port || 587),
        secure: stored.secure === true || String(stored.secure) === "true",
        user: stored.user || "",
        password: decryptSecret(stored.passwordEnc),
        fromName: stored.fromName || env.fromName,
        fromEmail: stored.fromEmail || "",
        replyTo: stored.replyTo || "",
        superAdminNotificationEmails: Array.isArray(stored.superAdminNotificationEmails)
          ? stored.superAdminNotificationEmails
          : env.superAdminNotificationEmails,
        generalNotificationsEnabled: stored.generalNotificationsEnabled !== false,
      }
    : env;

  cache = { ts: now, value: cfg };
  return cfg;
}

/**
 * Persist config. The password arrives as either new plaintext (encrypted
 * here) or a masked placeholder / empty → preserve the stored value.
 */
async function saveEmailConfig(data) {
  const stored = await loadStoredConfig().catch(() => null);

  const resolvePassword = (incoming, existingEnc) => {
    if (!incoming || String(incoming).includes("*")) return existingEnc || "";
    return encryptSecret(String(incoming));
  };

  const cleanEmailList = (list) =>
    (Array.isArray(list) ? list : String(list || "").split(","))
      .map((e) => normalizeEmail(e))
      .filter((e) => e && isValidEmail(e));

  const value = {
    enabled: data.enabled !== false,
    host: String(data.host || "").trim(),
    port: Number(data.port || 587),
    secure: data.secure === true || String(data.secure) === "true",
    user: String(data.user || "").trim(),
    passwordEnc: resolvePassword(data.password, stored?.passwordEnc),
    fromName: String(data.fromName || "").trim(),
    fromEmail: normalizeEmail(data.fromEmail || ""),
    replyTo: normalizeEmail(data.replyTo || ""),
    superAdminNotificationEmails: cleanEmailList(data.superAdminNotificationEmails),
    generalNotificationsEnabled: data.generalNotificationsEnabled !== false,
    updatedAt: new Date().toISOString(),
  };

  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value },
    create: { key: SETTING_KEY, value },
  });
  cache = { ts: 0, value: null }; // invalidate
  return value;
}

/** Public, frontend-safe view — the password is ALWAYS masked, never sent. */
async function getEmailStatus() {
  const cfg = await getEmailConfig();
  const problems = [];
  if (!cfg.host) problems.push("SMTP host is not set");
  if (!cfg.fromEmail) problems.push("From email is not set");
  if (cfg.host && !cfg.user) problems.push("SMTP username is not set");
  if (!cfg.password) problems.push("SMTP password is not set");

  // ── Microsoft Graph status (masked) ──
  // Non-secret identifiers only; the client secret is NEVER returned —
  // only a boolean "configured" flag. The frontend renders the badge from
  // this server-resolved state (transport/flag logic stays backend-only).
  const graph = require("../services/email/microsoftGraph.client");
  const g = graph.getGraphConfig();
  const graphConfigured = graph.isGraphConfigured(g);
  let graphStatus;
  if (!g.enabled) graphStatus = "DISABLED";
  else if (!graphConfigured) graphStatus = "INCOMPLETE";
  else graphStatus = "ENABLED";

  return {
    enabled: cfg.enabled,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    fromName: cfg.fromName,
    fromEmail: cfg.fromEmail,
    replyTo: cfg.replyTo,
    superAdminNotificationEmails: cfg.superAdminNotificationEmails,
    generalNotificationsEnabled: cfg.generalNotificationsEnabled,
    passwordConfigured: !!cfg.password,
    status: problems.length === 0 ? "CONFIGURED" : problems.length >= 3 ? "NOT_CONFIGURED" : "PARTIAL",
    problems,
    // Graph block (Phase 3) — masked, safe for the frontend:
    provider: graphStatus === "DISABLED" ? "smtp" : "microsoft-graph",
    graph: {
      status: graphStatus, // ENABLED | INCOMPLETE | DISABLED
      tenantIdConfigured: !!g.tenantId,
      clientIdConfigured: !!g.clientId,
      clientSecretConfigured: !!g.clientSecret, // NEVER the value
      senderEmail: g.senderEmail || "",
    },
  };
}

/** Toggle only the general notifications switch. */
async function setGeneralEmailEnabled(enabled) {
  const stored = await loadStoredConfig().catch(() => null);
  if (!stored) {
    const env = envFallback();
    await saveEmailConfig({ ...env, password: undefined, enabled: true, generalNotificationsEnabled: !!enabled });
    return;
  }
  await saveEmailConfig({ ...stored, password: undefined, generalNotificationsEnabled: !!enabled });
}

/** Quick readiness check used before attempting a send. */
async function isEmailReady() {
  const cfg = await getEmailConfig();
  return !!(cfg.enabled && cfg.host && cfg.fromEmail && cfg.user && cfg.password);
}

/** Verify SMTP connectivity by verifying the transport (never sends mail). */
async function verifySmtp() {
  // Microsoft Graph mode: verify configuration + token acquisition instead.
  // (Name kept for API compatibility with existing controllers/frontend.)
  const graph = require("../services/email/microsoftGraph.client");
  if (graph.getGraphConfig().enabled) {
    return graph.verifyGraphConnection();
  }
  const cfg = await getEmailConfig();
  if (!cfg.host) return { ok: false, error: "SMTP host is not configured" };
  try {
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
    await transporter.verify();
    transporter.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || "SMTP verification failed").slice(0, 300) };
  }
}

/** Send a test email to an explicit recipient (Super Admin action). */
async function sendTestEmail(toEmail) {
  const to = normalizeEmail(toEmail);
  if (!isValidEmail(to)) return { ok: false, error: "Please enter a valid test recipient email." };
  const cfg = await getEmailConfig();
  if (!cfg.enabled) return { ok: false, error: "Email notifications are disabled." };
  // Graph mode needs no SMTP host — only its own configuration (checked inside
  // the transport); SMTP mode keeps the host/fromEmail precondition.
  const graphEnabled = require("../services/email/microsoftGraph.client").getGraphConfig().enabled;
  if (!graphEnabled && (!cfg.host || !cfg.fromEmail)) {
    return { ok: false, error: "SMTP host and from email are required. Save the SMTP settings first." };
  }
  // Rendered through the shared SMTP_TEST template — same visual identity as
  // every other platform email. Never includes the SMTP password.
  const { renderTemplate } = require("../templates/email.templates");
  const rendered = renderTemplate("SMTP_TEST", {
    testedAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true }),
    fromEmail: cfg.fromEmail,
    brandName: cfg.fromName || "Nirka POS",
    supportEmail: cfg.replyTo || cfg.fromEmail || "",
  });
  try {
    // Deliver through the ACTIVE transport (Graph when enabled, else SMTP).
    // Lazy require avoids a load-time cycle (transport reads this config).
    const transport = require("../services/email/transport");
    const result = await transport.deliverEmail({
      to,
      subject: rendered.subject,
      payloadHtml: rendered.html,
      payloadText: rendered.text,
    });
    if (result.ok) return { ok: true, messageId: result.messageId, provider: result.provider };
    return { ok: false, error: String(result.error || "Test email failed").slice(0, 300) };
  } catch (e) {
    return { ok: false, error: String(e.message || "Test email failed").slice(0, 300) };
  }
}

module.exports = {
  SETTING_KEY,
  getEmailConfig,
  getEmailStatus,
  saveEmailConfig,
  setGeneralEmailEnabled,
  isEmailReady,
  verifySmtp,
  sendTestEmail,
};
