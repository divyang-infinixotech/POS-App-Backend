/**
 * Email transport selection — the ONLY switch point between providers.
 *
 *   EmailService (email.service.js deliver)
 *        ↓
 *   THIS module  →  MICROSOFT_GRAPH_ENABLED=true  →  Graph transport
 *               →  otherwise                     →  SMTP transport (legacy)
 *
 * Selection is explicit, never silent: Graph is used only when the feature
 * flag is true AND the configuration is complete. When Graph is selected but
 * misconfigured, the send FAILS with a clear error (no silent SMTP fallback —
 * two competing transports must never both fire in production).
 *
 * Result contract (both transports): { ok, messageId? | error, provider, ... }.
 */
const { getGraphConfig, isGraphConfigured, sendViaGraph } = require("../microsoftGraph.client");
const { getEmailConfig } = require("../../../config/email.config");

/**
 * Active provider name for diagnostics/status display:
 * "microsoft-graph" | "smtp". Reflects the FEATURE FLAG only — configuration
 * completeness is validated inside deliverEmail (which fails loudly when the
 * flag is on but config is incomplete; it never silently falls back).
 */
function activeTransportName() {
  return getGraphConfig().enabled ? "microsoft-graph" : "smtp";
}

/**
 * Deliver one rendered email through the active transport.
 * `row`: { to, subject, payloadHtml, payloadText } (EmailLog row shape).
 */
async function deliverEmail(row) {
  const cfg = getGraphConfig();
  // Reply-To is shared platform config (MAIL_REPLY_TO / saved setting) used
  // by both transports.
  let cfgReplyTo = "";
  try {
    const emailCfg = await getEmailConfig();
    cfgReplyTo = emailCfg.replyTo || "";
  } catch (_) { /* DB unavailable — send without reply-to */ }

  if (cfg.enabled) {
    if (!isGraphConfigured(cfg)) {
      // Explicit misconfiguration — fail loudly instead of silently using SMTP.
      return { ok: false, provider: "microsoft-graph", error: "MICROSOFT_GRAPH_ENABLED is true but tenant/client/sender configuration is incomplete" };
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

  const { sendViaSmtp } = require("./smtp.transport");
// (smtp.transport resolves ../../../config itself — same depth correction.)
  const result = await sendViaSmtp(row);
  return { ...result, provider: "smtp" };
}

module.exports = { deliverEmail, activeTransportName };
