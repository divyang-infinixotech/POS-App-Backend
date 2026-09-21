/**
 * Email transport selection — the ONLY switch point between providers.
 *
 *   EmailService (email.service.js deliver)
 *        ↓
 *   THIS module  →  active provider = GRAPH  →  Graph transport
 *               →  active provider = SMTP   →  SMTP transport (legacy)
 *
 * Provider selection (see config/email.config.js getActiveEmailProvider):
 *   1. Persisted Super Admin setting (SystemSetting "email_provider")
 *   2. EMAIL_PROVIDER env var (GRAPH | SMTP)
 *   3. Legacy MICROSOFT_GRAPH_ENABLED feature flag
 *   4. Default SMTP
 *
 * Selection is explicit, never silent: when GRAPH is selected the Graph
 * transport is used and its configuration is validated — a misconfiguration
 * FAILS with a clear provider-specific error and NEVER falls back to SMTP
 * (two competing transports must never both fire in production, and a
 * provider failure must be deterministic). Likewise SMTP selected → SMTP only.
 *
 * Result contract (both transports): { ok, messageId? | error, provider, ... }.
 */
const { getGraphConfig, isGraphConfigured, sendViaGraph } = require("../microsoftGraph.client");
const { getEmailConfig, getActiveEmailProvider, EMAIL_PROVIDERS } = require("../../../config/email.config");

/**
 * Active provider name for diagnostics/status display:
 * "microsoft-graph" | "smtp". Reflects the PERSISTED SELECTION only —
 * configuration completeness is validated inside deliverEmail (which fails
 * loudly when Graph is selected but misconfigured; it never silently falls
 * back to SMTP).
 */
async function activeTransportName() {
  return (await getActiveEmailProvider()) === EMAIL_PROVIDERS.GRAPH ? "microsoft-graph" : "smtp";
}

/**
 * Deliver one rendered email through the ACTIVE transport.
 * `row`: { to, subject, payloadHtml, payloadText } (EmailLog row shape).
 */
async function deliverEmail(row) {
  const provider = await getActiveEmailProvider();

  // Reply-To is shared platform config (MAIL_REPLY_TO / saved setting) used
  // by both transports.
  let cfgReplyTo = "";
  try {
    const emailCfg = await getEmailConfig();
    cfgReplyTo = emailCfg.replyTo || "";
  } catch (_) { /* DB unavailable — send without reply-to */ }

  if (provider === EMAIL_PROVIDERS.GRAPH) {
    const cfg = getGraphConfig();
    if (!isGraphConfigured(cfg)) {
      // Explicit misconfiguration — fail loudly with a provider-specific error
      // instead of silently using SMTP (deterministic provider behavior).
      return { ok: false, provider: "microsoft-graph", error: "Microsoft Graph is the active provider but tenant/client/sender configuration is incomplete (check MICROSOFT_GRAPH_* settings)" };
    }
    return sendViaGraph({
      to: row.to,
      subject: row.subject,
      html: row.payloadHtml,
      text: row.payloadText,
      // Reply-To comes from the same platform config as SMTP mode.
      replyTo: (cfgReplyTo || "") || undefined,
    });
  }

  // SMTP selected — the legacy transport ONLY (Graph is never invoked here).
  const { sendViaSmtp } = require("./smtp.transport");
  const result = await sendViaSmtp(row);
  return { ...result, provider: "smtp" };
}

module.exports = { deliverEmail, activeTransportName };
