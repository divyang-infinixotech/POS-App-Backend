/**
 * Microsoft Graph email — manual one-shot test (NEVER run by tests/cron).
 *
 * Sends exactly ONE clearly-identifiable test email through the production
 * Graph transport. Requires:
 *   MICROSOFT_GRAPH_TEST_RECIPIENT   (refuses to run without it)
 * plus the normal Graph configuration (TENANT_ID / CLIENT_ID / CLIENT_SECRET /
 * SENDER_EMAIL / ENABLED=true).
 *
 * Usage:
 *   MICROSOFT_GRAPH_TEST_RECIPIENT=you@yourdomain.com node scripts/test-microsoft-graph-email.js
 *
 * Never prints the client secret or access token. Exits non-zero on failure.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const recipient = String(process.env.MICROSOFT_GRAPH_TEST_RECIPIENT || "").trim();
const graph = require("../src/services/email/microsoftGraph.client");
const cfg = graph.getGraphConfig();

console.log("Microsoft Graph Email Test");
console.log("--------------------------");
console.log("Provider: Microsoft Graph");

if (!recipient) {
  console.log("Recipient: (not set)");
  console.error("FAIL: MICROSOFT_GRAPH_TEST_RECIPIENT is required — refusing to run.");
  process.exit(1);
}
if (!cfg.enabled) {
  console.log("Authentication: SKIPPED");
  console.error("FAIL: MICROSOFT_GRAPH_ENABLED is not true.");
  process.exit(1);
}
if (!graph.isGraphConfigured(cfg)) {
  console.log("Authentication: SKIPPED");
  console.error("FAIL: Graph configuration incomplete — set TENANT_ID, CLIENT_ID, CLIENT_SECRET and SENDER_EMAIL.");
  process.exit(1);
}

console.log(`Sender: ${cfg.senderEmail}`);
console.log(`Recipient: ${recipient}`);

(async () => {
  // 1) Token acquisition (diagnostic — sendMail would fetch one anyway).
  try {
    await graph.getAccessToken(cfg);
    console.log("Authentication: SUCCESS");
  } catch (e) {
    console.log("Authentication: FAILED");
    console.error("FAIL:", e.message);
    process.exit(1);
  }

  // 2) One sendMail through the same transport the app uses in production.
  const result = await graph.sendViaGraph({
    to: recipient,
    subject: "POS Microsoft Graph Test",
    html: `<div style="font-family:Arial,Helvetica,sans-serif;padding:16px">
             <h2 style="color:#16A34A;margin:0 0 8px">POS Microsoft Graph Test</h2>
             <p>This is a one-shot transport test from the Nirka POS backend.</p>
             <p style="color:#64748b;font-size:12px">Sent ${new Date().toISOString()} via Microsoft Graph v1.0 sendMail.</p>
           </div>`,
    text: "POS Microsoft Graph Test — one-shot transport test from the Nirka POS backend.",
  });

  if (result.ok) {
    console.log("SendMail: SUCCESS");
    console.log(`Accepted: ${result.accepted ? "202 Accepted (transport-level; not a final delivery guarantee)" : "unknown"}`);
    if (result.messageId) console.log(`Request-ID: ${result.messageId}`);
    process.exit(0);
  }

  console.log("SendMail: FAILED");
  console.error(`FAIL: ${result.error}`);
  process.exit(1);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
