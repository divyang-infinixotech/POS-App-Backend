/**
 * Microsoft Graph mail transport — the NEW email delivery mechanism.
 *
 * Replaces ONLY the transport inside the existing email architecture:
 *
 *   Event → email.service.enqueueEmail → EmailLog (PENDING, idempotencyKey)
 *         → deliverQueuedRow → THIS MODULE → Graph v1.0 sendMail → 202
 *
 * Everything upstream (templates, EmailLog, queue, retry, preferences,
 * idempotency) is untouched. Token + client are cached and reused until
 * expiry — never a new auth flow per email.
 *
 * Auth model: OAuth 2.0 client credentials (server-to-server, app-only).
 * Permission: Mail.Send (Application) — requires Entra admin consent.
 * Endpoint:   POST https://graph.microsoft.com/v1.0/users/{sender}/sendMail
 *             (v1.0 only — never /beta)
 *
 * Security: the client secret and access tokens never leave this module,
 * are never logged, and never appear in error messages shown to users.
 * Uses the native fetch (Node >= 18) — no SDK dependency needed.
 */

const TOKEN_URL_TEMPLATE = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token";
const GRAPH_SEND_URL = (sender) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;

const TOKEN_REFRESH_SAFETY_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const SEND_TIMEOUT_MS = 20 * 1000;
const TOKEN_TIMEOUT_MS = 15 * 1000;

// ── Cached app token (module scope — one process-wide token) ────────────────
let cachedToken = { value: null, expiresAtMs: 0 };

/** Reset cached credentials — used by tests and after config changes. */
function resetGraphClient() {
  cachedToken = { value: null, expiresAtMs: 0 };
}

/** Graph transport configuration from env (never hard-coded). */
function getGraphConfig() {
  return {
    tenantId: String(process.env.MICROSOFT_GRAPH_TENANT_ID || "").trim(),
    clientId: String(process.env.MICROSOFT_GRAPH_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.MICROSOFT_GRAPH_CLIENT_SECRET || "").trim(),
    senderEmail: String(process.env.MICROSOFT_GRAPH_SENDER_EMAIL || "").trim(),
    enabled: String(process.env.MICROSOFT_GRAPH_ENABLED || "false").toLowerCase() === "true",
  };
}

function isGraphConfigured(cfg = getGraphConfig()) {
  return !!(cfg.tenantId && cfg.clientId && cfg.clientSecret && cfg.senderEmail);
}

/**
 * Obtain an app-only access token via OAuth 2.0 client credentials, with
 * module-level caching until ~5 minutes before expiry. Returns { token, expiresAtMs }
 * or throws a sanitized error (never includes the secret or the token).
 */
async function getAccessToken(cfg = getGraphConfig()) {
  const now = Date.now();
  if (cachedToken.value && now < cachedToken.expiresAtMs) {
    return { token: cachedToken.value, cached: true };
  }

  const tokenUrl = TOKEN_URL_TEMPLATE.replace("{tenant}", encodeURIComponent(cfg.tenantId));
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`Graph authentication network failure: ${e.name === "AbortError" ? "timeout" : e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    // Sanitized: only the status + safe AAD error codes, never the secret.
    let code = "unknown";
    try {
      const j = await resp.json();
      code = j.error || "unknown";
    } catch (_) { /* body not JSON */ }
    throw new Error(`Graph authentication failed (HTTP ${resp.status}, ${code})`);
  }

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error("Graph authentication failed: no access token in response");
  }
  const expiresInS = Number(data.expires_in || 3600);
  cachedToken = {
    value: data.access_token,
    expiresAtMs: now + expiresInS * 1000 - TOKEN_REFRESH_SAFETY_MS,
  };
  return { token: cachedToken.value, cached: false };
}

/** Strip secrets/tokens from anything we might be tempted to log. */
function sanitizeForLog(value) {
  if (value == null) return value;
  const s = String(value);
  return s
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer ***")
    .replace(/("access_token"\s*:\s*")[^"]+/gi, "$1***")
    .replace(/(client_secret=)[^&\s]+/gi, "$1***");
}

/** Map a Graph/fetch failure to a stable, log-safe error code. */
function classifyGraphError(status, bodyText) {
  const safe = sanitizeForLog(String(bodyText || "")).slice(0, 300);
  if (status === 401) return { code: "AUTH_TOKEN_REJECTED", retryable: true, safe };
  if (status === 403) return { code: "PERMISSION_DENIED", retryable: false, safe };
  if (status === 400 || status === 404 || status === 422) return { code: "INVALID_REQUEST", retryable: false, safe };
  if (status === 429) return { code: "THROTTLED", retryable: true, safe };
  if (status >= 500) return { code: "GRAPH_SERVER_ERROR", retryable: true, safe };
  if (status === 0) return { code: "NETWORK_ERROR", retryable: true, safe };
  return { code: "GRAPH_ERROR", retryable: status >= 500, safe };
}

/** Build the Graph message object from the application's email representation. */
function buildGraphMessage({ to, cc, bcc, subject, html, text, replyTo, sender }) {
  const toList = (Array.isArray(to) ? to : [to]).map(String).filter(Boolean);
  const ccList = Array.isArray(cc) ? cc.filter(Boolean) : [];
  const bccList = Array.isArray(bcc) ? bcc.filter(Boolean) : [];
  const toRecipients = toList.map((a) => ({ emailAddress: { address: a } }));
  const message = {
    subject: String(subject || ""),
    body: {
      // HTML when a template provides it; plain text fallback otherwise.
      contentType: html ? "HTML" : "Text",
      content: html || text || "",
    },
    toRecipients,
  };
  if (ccList.length) message.ccRecipients = ccList.map((a) => ({ emailAddress: { address: a } }));
  if (bccList.length) message.bccRecipients = bccList.map((a) => ({ emailAddress: { address: a } }));
  if (replyTo) {
    message.replyTo = (Array.isArray(replyTo) ? replyTo : [replyTo])
      .filter(Boolean)
      .map((a) => ({ emailAddress: { address: a } }));
  }
  // attachments: [{ filename, content(base64), contentType }]
  if (Array.isArray(arguments[0].attachments) && arguments[0].attachments.length) {
    message.attachments = arguments[0].attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: String(a.filename || a.name || "attachment"),
      contentType: String(a.contentType || a.type || "application/octet-stream"),
      contentBytes: String(a.content || a.base64 || ""),
    }));
  }
  if (sender && sender !== toList[0]) {
    // Graph sendMail /users/{sender} already defines the mailbox; from is only
    // set explicitly when it differs (e.g. shared mailbox aliases).
    message.from = { emailAddress: { address: sender } };
  }
  return message;
}

/**
 * Send one email through Microsoft Graph. Returns a transport-agnostic result:
 *   { ok: true, provider: "microsoft-graph", messageId, accepted: true }
 *   { ok: false, provider: "microsoft-graph", error, code, retryable }
 * 202 Accepted is treated as transport-accepted (NOT guaranteed delivery).
 */
async function sendViaGraph({ to, cc, bcc, subject, html, text, replyTo, attachments }) {
  const cfg = getGraphConfig();
  if (!cfg.enabled) {
    return { ok: false, provider: "microsoft-graph", error: "Microsoft Graph transport is disabled (MICROSOFT_GRAPH_ENABLED)", code: "DISABLED", retryable: false };
  }
  if (!isGraphConfigured(cfg)) {
    return { ok: false, provider: "microsoft-graph", error: "Microsoft Graph is not configured (tenant/client/sender missing)", code: "NOT_CONFIGURED", retryable: false };
  }
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) {
    return { ok: false, provider: "microsoft-graph", error: "No valid recipient", code: "INVALID_RECIPIENT", retryable: false };
  }

  let token;
  try {
    ({ token } = await getAccessToken(cfg));
  } catch (e) {
    return { ok: false, provider: "microsoft-graph", error: sanitizeForLog(e.message), code: "AUTH_FAILURE", retryable: true };
  }

  const message = buildGraphMessage({ to, cc, bcc, subject, html, text, replyTo, attachments, sender: cfg.senderEmail });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const resp = await fetch(GRAPH_SEND_URL(cfg.senderEmail), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
      signal: controller.signal,
    });

    if (resp.status === 202) {
      const messageId = resp.headers.get("request-id") || null;
      return { ok: true, provider: "microsoft-graph", accepted: true, messageId };
    }

    const bodyText = await resp.text().catch(() => "");
    const { code, retryable, safe } = classifyGraphError(resp.status, bodyText);
    return {
      ok: false,
      provider: "microsoft-graph",
      error: `Graph send failed (HTTP ${resp.status}, ${code})${safe && code !== "GRAPH_ERROR" ? `: ${safe}` : ""}`,
      code,
      retryable,
      httpStatus: resp.status,
    };
  } catch (e) {
    const { code, retryable } = classifyGraphError(0, "");
    return {
      ok: false,
      provider: "microsoft-graph",
      error: `Graph request failed: ${e.name === "AbortError" ? "timeout" : sanitizeForLog(e.message)}`,
      code,
      retryable,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Diagnostic: verify configuration + token acquisition (never sends mail). */
async function verifyGraphConnection() {
  const cfg = getGraphConfig();
  if (!cfg.enabled) return { ok: false, error: "MICROSOFT_GRAPH_ENABLED is not true" };
  if (!isGraphConfigured(cfg)) return { ok: false, error: "Graph configuration incomplete (tenant/client/sender)" };
  try {
    const { cached } = await getAccessToken(cfg);
    return { ok: true, tokenCached: cached, sender: cfg.senderEmail };
  } catch (e) {
    return { ok: false, error: sanitizeForLog(e.message) };
  }
}

module.exports = {
  getGraphConfig,
  isGraphConfigured,
  getAccessToken,
  buildGraphMessage,
  sendViaGraph,
  verifyGraphConnection,
  resetGraphClient,
  classifyGraphError,
  sanitizeForLog,
  GRAPH_SEND_URL,
};
