/**
 * Microsoft Graph transport tests — pure unit tests, Graph calls fully mocked
 * (global.fetch is stubbed; NO real HTTP, NO real emails ever sent).
 *
 * Follows the repo's standalone assertion pattern (run.js wires it in):
 *   node src/__tests__/microsoft-graph.test.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const path = require("path");

const GRAPH_DIR = path.join(__dirname, "..", "services", "email");
const graph = require(path.join(GRAPH_DIR, "microsoftGraph.client.js"));

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log("  \u2714 " + name); }
  else { failed++; console.log("  \u2718 FAIL: " + name); }
}
function section(name) { console.log("\n" + name); }

// ── fetch stub harness ───────────────────────────────────────────────────────
const realFetch = global.fetch;
const realEnv = { ...process.env };

/** Install env + a scripted fetch: tokenResponse + sendResponses (queue). */
function mockGraph({ tokenResponse, sendResponses, capture }) {
  process.env.MICROSOFT_GRAPH_TENANT_ID = "tenant-unit-test";
  process.env.MICROSOFT_GRAPH_CLIENT_ID = "client-unit-test";
  process.env.MICROSOFT_GRAPH_CLIENT_SECRET = "secret-unit-test";
  process.env.MICROSOFT_GRAPH_SENDER_EMAIL = "sender@unit.test";
  process.env.MICROSOFT_GRAPH_ENABLED = "true";
  graph.resetGraphClient();
  const responses = [...(sendResponses || [])];
  global.fetch = async (url, opts = {}) => {
    if (capture) capture.calls.push({ url, opts });
    if (String(url).includes("login.microsoftonline.com")) {
      if (typeof tokenResponse === "number") return { ok: false, status: tokenResponse, json: async () => ({ error: "invalid_client" }), text: async () => JSON.stringify({ error: "invalid_client" }) };
      if (tokenResponse === "network") throw new Error("ECONNREFUSED");
      return {
        ok: true, status: 200,
        json: async () => tokenResponse || { access_token: "unit-test-token", expires_in: 3600 },
      };
    }
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (typeof r === "number") return { ok: r < 400, status: r, text: async () => JSON.stringify({ error: { message: "graph rejected" } }), headers: { get: () => null } };
    if (r === "network") throw new Error("socket hang up");
    return { ok: true, status: 202, text: async () => "", headers: { get: () => "req-unit-123" } };
  };
}

function restore() {
  global.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (k.startsWith("MICROSOFT_GRAPH_")) delete process.env[k];
  Object.assign(process.env, realEnv);
  graph.resetGraphClient();
}

// (CommonJS — no top-level await; async sections run inside the IIFE below.)
const sections = [];
const asyncSection = (fn) => sections.push(fn);

// ═══ 1. Configuration validation ═══
section("Configuration");
check(graph.isGraphConfigured({ tenantId: "t", clientId: "c", clientSecret: "s", senderEmail: "m@x.com" }) === true, "isGraphConfigured: complete config = true");
check(graph.isGraphConfigured({ tenantId: "t", clientId: "c", clientSecret: "", senderEmail: "m@x.com" }) === false, "isGraphConfigured: missing secret = false");
{
  delete process.env.MICROSOFT_GRAPH_ENABLED;
  const cfg = graph.getGraphConfig();
  check(cfg.enabled === false, "MICROSOFT_GRAPH_ENABLED unset → disabled (legacy SMTP mode)");
}

// ═══ 2. Payload construction ═══
section("Payload construction");
{
  const msg = graph.buildGraphMessage({ to: "a@b.com", subject: "Sub", html: "<b>H</b>", text: "T", sender: "s@c.com" });
  check(msg.body.contentType === "HTML", "HTML body → contentType HTML");
  check(msg.body.content === "<b>H</b>", "HTML content preserved");
  check(msg.toRecipients[0].emailAddress.address === "a@b.com", "single recipient mapped");
  check(msg.subject === "Sub", "subject preserved");
}
{
  const msg = graph.buildGraphMessage({ to: "a@b.com", subject: "Sub", text: "plain only", sender: "s@c.com" });
  check(msg.body.contentType === "Text", "text-only body → contentType Text (plain fallback)");
  check(msg.body.content === "plain only", "text content preserved");
}
{
  const msg = graph.buildGraphMessage({
    to: ["a@b.com", "c@d.com"], cc: ["cc@x.com"], bcc: ["bcc@y.com"],
    subject: "M", html: "<p/>", replyTo: ["reply@z.com"], sender: "s@c.com",
  });
  check(msg.toRecipients.length === 2, "multiple toRecipients");
  check(msg.ccRecipients.length === 1 && msg.ccRecipients[0].emailAddress.address === "cc@x.com", "cc mapped");
  check(msg.bccRecipients.length === 1 && msg.bccRecipients[0].emailAddress.address === "bcc@y.com", "bcc mapped");
  check(msg.replyTo[0].emailAddress.address === "reply@z.com", "replyTo mapped");
}
{
  const msg = graph.buildGraphMessage({
    to: "a@b.com", subject: "Att", html: "<p/>",
    attachments: [{ filename: "invoice.pdf", content: "AAAA", contentType: "application/pdf" }],
    sender: "s@c.com",
  });
  check(msg.attachments.length === 1, "attachment mapped");
  check(msg.attachments[0]["@odata.type"] === "#microsoft.graph.fileAttachment", "attachment odata type");
  check(msg.attachments[0].contentBytes === "AAAA", "attachment base64 content");
}
check(graph.GRAPH_SEND_URL("m@x.com").startsWith("https://graph.microsoft.com/v1.0/"), "Graph v1.0 endpoint (never beta)");
check(!graph.GRAPH_SEND_URL("m@x.com").includes("/beta"), "no /beta endpoint");

// ═══ 3. Successful send + 202 handling ═══
asyncSection(async () => {
section("Successful send (202)");
{
  const calls = [];
  mockGraph({ capture: { calls } });
  const r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<b>x</b>" });
  check(r.ok === true && r.accepted === true, "202 → ok:true, accepted:true");
  check(r.provider === "microsoft-graph", "provider identified");
  check(r.messageId === "req-unit-123", "request-id surfaced as messageId");
  const sendCall = calls.find((c) => String(c.url).includes("graph.microsoft.com"));
  const body = JSON.parse(sendCall.opts.body);
  check(body.saveToSentItems === true, "saveToSentItems true");
  check(body.message.body.contentType === "HTML", "sendMail payload is HTML");
  check(sendCall.url.includes(encodeURIComponent("sender@unit.test")), "sendMail uses /users/{sender} from config");
  check(!JSON.stringify(sendCall.opts.body).includes("secret-unit-test"), "client secret never in request body");
  const authHeader = sendCall.opts.headers.Authorization || "";
  check(authHeader.startsWith("Bearer unit-test-token"), "Bearer token from client credentials");
  restore();
}
});

// ═══ 4. Token caching ═══
asyncSection(async () => {
section("Token caching");
{
  let tokenFetches = 0;
  mockGraph({});
  const realGet = graph.getAccessToken;
  // count token calls through the stub
  global.fetch = async (url) => {
    if (String(url).includes("login.microsoftonline.com")) { tokenFetches++; return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) }; }
    return { ok: true, status: 202, text: async () => "", headers: { get: () => null } };
  };
  await graph.sendViaGraph({ to: "a@b.com", subject: "1", html: "<p/>" });
  await graph.sendViaGraph({ to: "a@b.com", subject: "2", html: "<p/>" });
  await graph.sendViaGraph({ to: "a@b.com", subject: "3", html: "<p/>" });
  check(tokenFetches === 1, "one token for three emails (cached until expiry)");
  restore();
}
});

// ═══ 5. Error handling ═══
asyncSection(async () => {
section("Error handling (sanitized, never secrets)");
{
  mockGraph({ tokenResponse: 401 });
  let r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<p/>" });
  check(r.ok === false && r.code === "AUTH_FAILURE", "auth endpoint 401 → AUTH_FAILURE");
  check(!String(r.error).includes("secret-unit-test"), "error contains no client secret");
  restore();

  mockGraph({ tokenResponse: "network" });
  r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<p/>" });
  check(r.ok === false && r.code === "AUTH_FAILURE", "token network failure → AUTH_FAILURE (retryable)");
  check(r.retryable === true, "auth network failure marked retryable");
  restore();

  for (const [status, expectedCode] of [[401, "AUTH_TOKEN_REJECTED"], [403, "PERMISSION_DENIED"], [400, "INVALID_REQUEST"], [429, "THROTTLED"], [500, "GRAPH_SERVER_ERROR"], [503, "GRAPH_SERVER_ERROR"]]) {
    mockGraph({ sendResponses: [status] });
    r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<p/>" });
    check(r.ok === false && r.code === expectedCode, `Graph ${status} → ${expectedCode}`);
    check(!String(r.error).includes("unit-test-token"), `Graph ${status} error contains no access token`);
    restore();
  }

  mockGraph({ sendResponses: ["network"] });
  r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<p/>" });
  check(r.ok === false && r.code === "NETWORK_ERROR" && r.retryable === true, "send network failure → NETWORK_ERROR retryable");
  restore();

  // Throttling is retryable (existing queue retry picks it up), permission is not.
  mockGraph({ sendResponses: [429] });
  r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<p/>" });
  check(r.retryable === true, "429 retryable → existing queue handles it");
  restore();
  mockGraph({ sendResponses: [403] });
  r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<p/>" });
  check(r.retryable === false, "403 NOT retryable (admin consent/permission issue)");
  restore();
}
});

// ═══ 6. Recipient validation + disabled flag ═══
asyncSection(async () => {
section("Validation & feature flag");
{
  mockGraph({});
  let r = await graph.sendViaGraph({ to: "", subject: "S", html: "<p/>" });
  check(r.ok === false && r.code === "INVALID_RECIPIENT", "empty recipient rejected without HTTP call");
  delete process.env.MICROSOFT_GRAPH_ENABLED;
  r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<p/>" });
  check(r.ok === false && r.code === "DISABLED", "flag off → DISABLED (no silent send)");
  process.env.MICROSOFT_GRAPH_ENABLED = "true";
  delete process.env.MICROSOFT_GRAPH_CLIENT_SECRET;
  r = await graph.sendViaGraph({ to: "a@b.com", subject: "S", html: "<p/>" });
  check(r.ok === false && r.code === "NOT_CONFIGURED", "incomplete config → NOT_CONFIGURED (fails loudly, no SMTP fallback)");
  restore();
}
});

// ═══ 7. verifyGraphConnection ═══
asyncSection(async () => {
section("Diagnostics");
{
  mockGraph({});
  const v = await graph.verifyGraphConnection();
  check(v.ok === true && v.sender === "sender@unit.test", "verify: config + token OK, sender echoed, no token returned");
  check(JSON.stringify(v).includes("unit-test-token") === false, "verify response contains no token");
  restore();
}
});

(async () => {
  for (const fn of sections) await fn();
  console.log(`\nRESULTS: PASSED ${passed}  FAILED ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(2); });
