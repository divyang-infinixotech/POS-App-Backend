/**
 * Email Provider Selection + Production URL Safety + Credential Handling
 * Standalone — run with: node src/__tests__/email-provider.test.js
 *
 * Follows the repo's standalone assertion pattern (no Jest, no real DB).
 * The Prisma clients (config/prisma.js, config/tenantPrisma.js), nodemailer
 * and global.fetch are stubbed at module level BEFORE the units under test
 * are required, so the REAL email.config / transport selector / Graph client /
 * SMTP transport / email.service code paths execute end-to-end:
 *
 *   1. Provider selection: only GRAPH | SMTP accepted; invalid values fail.
 *   2. Selection persists in SystemSetting ("email_provider") and is re-read.
 *   3. GRAPH selected → Graph transport used (fetch hits graph.microsoft.com).
 *   4. SMTP selected → SMTP transport used (nodemailer), Graph never invoked.
 *   5. Graph misconfigured/failing → clear Graph-specific error, NO SMTP
 *      fallback; SMTP failing → Graph never invoked.
 *   6. Secrets (SMTP password, Graph client secret) are never returned.
 *   7. Production never generates localhost login URLs; missing
 *      APP_FRONTEND_URL in production refuses URL generation.
 *   8. Approval/credentials emails carry ONLY the real temporary credential
 *      (never fabricated), and it is sanitized from the EmailLog after send.
 */
const path = require("path");
const assert = require("assert");

process.env.JWT_SECRET = process.env.JWT_SECRET || "unit-test-secret-for-email-provider-tests";

// ─── Stub harness (installed BEFORE units under test are required) ──────────

// In-memory SystemSetting + EmailLog store standing in for the platform DB.
const db = {
  settings: new Map(),
  emails: [],
  nextEmailId: 1,
};

const fakePrisma = {
  systemSetting: {
    async findUnique({ where: { key } }) {
      if (!db.settings.has(key)) return null;
      return { id: key, key, value: db.settings.get(key) };
    },
    async upsert({ where: { key }, update, create }) {
      const value = db.settings.has(key) ? update.value : create.value;
      db.settings.set(key, value);
      return { id: key, key, value };
    },
  },
  emailLog: {
    async findUnique({ where }) {
      if (where.id !== undefined) return db.emails.find((r) => r.id === where.id) || null;
      if (where.idempotencyKey !== undefined) return db.emails.find((r) => r.idempotencyKey === where.idempotencyKey) || null;
      return null;
    },
    async create({ data }) {
      const row = { id: db.nextEmailId++, status: "PENDING", attempts: 0, ...data };
      db.emails.push(row);
      return row;
    },
    async updateMany({ where, data }) {
      const row = db.emails.find((r) => r.id === where.id);
      const allowed = where.status && where.status.in ? where.status.in : null;
      if (!row || (allowed && !allowed.includes(row.status))) return { count: 0 };
      const inc = data.attempts && data.attempts.increment ? data.attempts.increment : 0;
      row.attempts = (row.attempts || 0) + inc;
      if (data.status !== undefined) row.status = data.status;
      return { count: 1 };
    },
    async update({ where, data }) {
      const row = db.emails.find((r) => r.id === where.id);
      if (!row) throw new Error("emailLog row not found");
      Object.assign(row, data);
      return row;
    },
    async findMany() {
      return db.emails.filter((r) => r.status === "PENDING" || r.status === "FAILED");
    },
  },
};

// Inject stubs into the require cache so every importer shares them.
function inject(resolvedPath, exports) {
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
}
const PRISMA_PATH = require.resolve(path.join(__dirname, "..", "config", "prisma.js"));
const TENANT_PRISMA_PATH = require.resolve(path.join(__dirname, "..", "config", "tenantPrisma.js"));
const NODEMAILER_PATH = require.resolve("nodemailer");
inject(PRISMA_PATH, fakePrisma);
inject(TENANT_PRISMA_PATH, {
  platformPrisma: fakePrisma,
  getTenantClient: () => fakePrisma,
  getTenantClientByRestaurantId: () => fakePrisma,
  invalidateTenantClient: () => {},
  disconnectAllTenants: async () => {},
  generateSchemaName: (s) => s,
  isValidSchemaName: () => true,
  tenantMiddleware: () => () => {},
});

// Nodemailer stub: records the last transporter + sent mail; can be made to throw.
const nodemailerCalls = { createTransport: 0, sent: [], throwOnSend: false, lastOpts: null };
inject(NODEMAILER_PATH, {
  createTransport(opts) {
    nodemailerCalls.createTransport++;
    nodemailerCalls.lastOpts = opts;
    return {
      async sendMail(mail) {
        if (nodemailerCalls.throwOnSend) throw new Error("SMTP connection refused (stub)");
        nodemailerCalls.sent.push(mail);
        return { messageId: "<smtp-stub@unit.test>" };
      },
      async verify() { return true; },
      close() { /* noop */ },
    };
  },
});

// Graph fetch spy/stub — install per-section (pattern from microsoft-graph.test.js).
const realFetch = global.fetch;
const graphCalls = { fetches: [] };
function mockGraphFetch({ tokenOk = true, sendStatus = 202 } = {}) {
  graphCalls.fetches = [];
  global.fetch = async (url) => {
    graphCalls.fetches.push(String(url));
    if (String(url).includes("login.microsoftonline.com")) {
      if (!tokenOk) return { ok: false, status: 401, json: async () => ({ error: "invalid_client" }), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ access_token: "unit-token", expires_in: 3600 }) };
    }
    if (sendStatus >= 400) {
      return { ok: false, status: sendStatus, text: async () => JSON.stringify({ error: { message: "graph rejected" } }), headers: { get: () => null } };
    }
    return { ok: true, status: sendStatus, text: async () => "", headers: { get: () => "req-unit" } };
  };
}
function unmockGraphFetch() { global.fetch = realFetch; }

const ENV_SNAPSHOT = { ...process.env };

// Units under test (real modules, stubbed I/O).
const emailConfig = require(path.join(__dirname, "..", "config", "email.config.js"));
const transport = require(path.join(__dirname, "..", "services", "email", "transport", "index.js"));
const graphClient = require(path.join(__dirname, "..", "services", "email", "microsoftGraph.client.js"));
const emailService = require(path.join(__dirname, "..", "services", "email.service.js"));
const frontendUrl = require(path.join(__dirname, "..", "utils", "frontendUrl.js"));

// ─── Assertion helpers (repo pattern) ────────────────────────────────────────
let passed = 0, failed = 0;
function section(name) { console.log(`\n${"=".repeat(60)}\n  ${name}\n${"=".repeat(60)}`); }
function check(cond, name) {
  if (cond) { passed++; console.log("  \u2714 " + name); }
  else { failed++; console.log("  \u2718 FAIL: " + name); }
}
function eq(actual, expected, name) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  \u2714 ${name}`); }
  else { failed++; console.log(`  \u2718 FAIL: ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
async function rejects(promiseOrFn, name) {
  try {
    const v = typeof promiseOrFn === "function" ? await promiseOrFn() : await promiseOrFn;
    check(false, `${name} — unexpectedly resolved to ${JSON.stringify(v).slice(0, 60)}`);
  } catch (e) {
    check(true, `${name} (threw: ${String(e.message).slice(0, 80)})`);
  }
}
function setEnv(k, v) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

const sections = [];
const asyncSection = (fn) => sections.push(fn);

// ═══════════════════════════════════════════════
//  1. PROVIDER SELECTION — validation + persistence
// ═══════════════════════════════════════════════
asyncSection(async () => {
  section("1. PROVIDER SELECTION (GRAPH | SMTP only)");

  // Nothing persisted yet → env fallback decides (EMAIL_PROVIDER first).
  setEnv("EMAIL_PROVIDER", "GRAPH"); setEnv("MICROSOFT_GRAPH_ENABLED", undefined);
  eq(await emailConfig.getActiveEmailProvider(), "GRAPH", "env fallback: EMAIL_PROVIDER=GRAPH used when nothing is persisted");

  eq(emailConfig.normalizeProvider("graph"), "GRAPH", "normalizeProvider('graph') → GRAPH");
  eq(emailConfig.normalizeProvider("SMTP"), "SMTP", "normalizeProvider('SMTP') → SMTP");
  eq(emailConfig.normalizeProvider("MICROSOFT_GRAPH"), "GRAPH", "legacy alias MICROSOFT_GRAPH → GRAPH");
  eq(emailConfig.normalizeProvider("SENDGRID"), null, "invalid provider normalizes to null");
  eq(emailConfig.normalizeProvider(""), null, "empty provider normalizes to null");

  setEnv("EMAIL_PROVIDER", undefined);
  await rejects(() => emailConfig.saveEmailProvider("SENDGRID"), "saving an invalid provider throws (fails safely, never coerced)");
  check(!db.settings.has(emailConfig.PROVIDER_SETTING_KEY), "invalid provider was NOT persisted");

  eq(await emailConfig.saveEmailProvider("GRAPH"), "GRAPH", "saveEmailProvider('GRAPH') persists GRAPH");
  eq(await emailConfig.getActiveEmailProvider(), "GRAPH", "getActiveEmailProvider() re-reads persisted GRAPH (cache invalidated)");

  eq(await emailConfig.saveEmailProvider("SMTP"), "SMTP", "saveEmailProvider('SMTP') persists SMTP");
  eq(await emailConfig.getActiveEmailProvider(), "SMTP", "selection persists and is re-read after switch");
  eq(await emailConfig.isGraphActive(), false, "isGraphActive() is false while SMTP is active");
  eq(await emailConfig.saveEmailProvider("GRAPH"), "GRAPH", "switch back to GRAPH for the transport tests");
});

// ═══════════════════════════════════════════════
//  2. TRANSPORT SELECTION — the ONLY switch point
// ═══════════════════════════════════════════════
asyncSection(async () => {
  section("2. TRANSPORT SELECTION — Graph selected → Graph used");
  await emailConfig.saveEmailProvider("GRAPH");
  process.env.MICROSOFT_GRAPH_TENANT_ID = "tenant-unit";
  process.env.MICROSOFT_GRAPH_CLIENT_ID = "client-unit";
  process.env.MICROSOFT_GRAPH_CLIENT_SECRET = "secret-unit";
  process.env.MICROSOFT_GRAPH_SENDER_EMAIL = "sender@unit.test";
  process.env.MICROSOFT_GRAPH_ENABLED = "true";
  graphClient.resetGraphClient();
  mockGraphFetch();

  const r1 = await transport.deliverEmail({ to: "to@unit.test", subject: "T", payloadHtml: "<p>hi</p>", payloadText: "hi" });
  eq(r1.ok, true, "Graph selected + configured → delivery ok");
  eq(r1.provider, "microsoft-graph", "result identifies the provider used (microsoft-graph)");
  check(graphCalls.fetches.some((u) => u.includes("graph.microsoft.com")), "send went through the Microsoft Graph API");
  eq(nodemailerCalls.createTransport, 0, "SMTP transport was NOT touched while Graph is active");
  eq(await transport.activeTransportName(), "microsoft-graph", "activeTransportName() reflects the persisted selection");

  section("2b. SMTP selected → SMTP used (Graph never invoked)");
  await emailConfig.saveEmailProvider("SMTP");
  await emailConfig.saveEmailConfig({
    enabled: true, host: "smtp.gmail.com", port: 465, secure: true,
    user: "pos@gmail.com", password: "unit-smtp-secret-1", fromName: "Unit", fromEmail: "pos@gmail.com",
  });
  graphCalls.fetches = [];
  const r2 = await transport.deliverEmail({ to: "to@unit.test", subject: "T", payloadHtml: "<p>hi</p>", payloadText: "hi" });
  eq(r2.ok, true, "SMTP selected + configured → delivery ok");
  eq(r2.provider, "smtp", "result identifies the provider used (smtp)");
  eq(graphCalls.fetches.length, 0, "Microsoft Graph was NOT invoked while SMTP is active");
  check(nodemailerCalls.createTransport >= 1, "nodemailer transport was created");
  eq(nodemailerCalls.sent.length, 1, "mail handed to SMTP exactly once");
  eq(await transport.activeTransportName(), "smtp", "activeTransportName() reflects the SMTP selection");

  section("2c. Graph misconfigured → clear provider error, NO silent SMTP fallback");
  await emailConfig.saveEmailProvider("GRAPH");
  ["MICROSOFT_GRAPH_TENANT_ID", "MICROSOFT_GRAPH_CLIENT_ID", "MICROSOFT_GRAPH_CLIENT_SECRET", "MICROSOFT_GRAPH_SENDER_EMAIL"].forEach((k) => setEnv(k, undefined));
  graphClient.resetGraphClient();
  mockGraphFetch(); // spy only — Graph should fail BEFORE any HTTP call
  const smtpCountBefore = nodemailerCalls.createTransport;
  const r3 = await transport.deliverEmail({ to: "to@unit.test", subject: "T", payloadHtml: "<p>x</p>", payloadText: "x" });
  eq(r3.ok, false, "Graph selected but misconfigured → delivery fails");
  eq(r3.provider, "microsoft-graph", "error is provider-specific (microsoft-graph)");
  check(/graph/i.test(String(r3.error)) && /configur/i.test(String(r3.error)), `error names the Graph configuration problem: "${String(r3.error).slice(0, 60)}…"`);
  eq(nodemailerCalls.createTransport, smtpCountBefore, "NO silent fallback: SMTP transport was never created");
  eq(graphCalls.fetches.length, 0, "fails before any HTTP call (validated locally)");

  section("2d. Graph runtime failure → no fallback, deterministic error");
  process.env.MICROSOFT_GRAPH_TENANT_ID = "tenant-unit";
  process.env.MICROSOFT_GRAPH_CLIENT_ID = "client-unit";
  process.env.MICROSOFT_GRAPH_CLIENT_SECRET = "secret-unit";
  process.env.MICROSOFT_GRAPH_SENDER_EMAIL = "sender@unit.test";
  graphClient.resetGraphClient();
  mockGraphFetch({ sendStatus: 500 });
  const r4 = await transport.deliverEmail({ to: "to@unit.test", subject: "T", payloadHtml: "<p>x</p>", payloadText: "x" });
  eq(r4.ok, false, "Graph HTTP 500 → delivery fails");
  eq(r4.provider, "microsoft-graph", "failure keeps the Graph provider identity");
  check(String(r4.error).includes("500"), "error carries the Graph HTTP status");
  eq(nodemailerCalls.createTransport, smtpCountBefore, "SMTP was NOT invoked on Graph failure");

  section("2e. SMTP failing → Graph never invoked");
  await emailConfig.saveEmailProvider("SMTP");
  nodemailerCalls.throwOnSend = true;
  graphCalls.fetches = [];
  await rejects(() => transport.deliverEmail({ to: "to@unit.test", subject: "T", payloadHtml: "<p>x</p>", payloadText: "x" }),
    "SMTP transport failure surfaces an error (caught by the queue worker)");
  eq(graphCalls.fetches.length, 0, "Graph was NOT invoked on SMTP failure");
  nodemailerCalls.throwOnSend = false;
  unmockGraphFetch();
});

// ═══════════════════════════════════════════════
//  3. SECRETS ARE NEVER RETURNED
// ═══════════════════════════════════════════════
asyncSection(async () => {
  section("3. SECRETS NEVER RETURNED / NEVER STORED PLAINTEXT");
  await emailConfig.saveEmailProvider("SMTP");
  await emailConfig.saveEmailConfig({
    enabled: true, host: "smtp.gmail.com", port: 465, secure: true,
    user: "pos@gmail.com", password: "super-secret-app-password-123",
    fromName: "Unit Test", fromEmail: "pos@gmail.com", replyTo: "",
  });
  const status = await emailConfig.getEmailStatus();
  eq(status.smtp.passwordConfigured, true, "status exposes passwordConfigured=true (boolean)");
  check(!JSON.stringify(status).includes("super-secret-app-password-123"), "SMTP password value never appears anywhere in the status payload");
  check(!("clientSecret" in status.graph), "Graph client secret key is absent from the graph status block");
  eq(typeof status.graph.clientSecretConfigured, "boolean", "graph client secret presence is a boolean only");
  check(status.emailProvider === "SMTP" || status.emailProvider === "GRAPH", "status exposes the explicit emailProvider (GRAPH|SMTP)");
  eq(status.emailProvider, "SMTP", "status reports SMTP as the active provider");
  const storedRaw = JSON.stringify(db.settings.get("email_smtp_config"));
  check(!storedRaw.includes("super-secret-app-password-123"), "stored config contains no plaintext password (AES-encrypted at rest)");
});

// ═══════════════════════════════════════════════
//  4. PRODUCTION LOGIN URL SAFETY
// ═══════════════════════════════════════════════
asyncSection(async () => {
  section("4. PRODUCTION LOGIN URL SAFETY (APP_FRONTEND_URL)");
  // Keep SMTP failing so any queued row keeps its full payload for assertions.
  nodemailerCalls.throwOnSend = true;
  setEnv("NODE_ENV", "production");

  setEnv("APP_FRONTEND_URL", undefined);
  await rejects(() => frontendUrl.getFrontendUrl(), "production without APP_FRONTEND_URL → getFrontendUrl() throws (never localhost)");
  eq(frontendUrl.getSafeLoginUrl(), null, "production without APP_FRONTEND_URL → getSafeLoginUrl() returns null for explicit handling");

  setEnv("APP_FRONTEND_URL", "https://app.example.com/");
  eq(frontendUrl.getFrontendUrl(), "https://app.example.com", "trailing slash is stripped from the configured origin");
  eq(frontendUrl.getSafeLoginUrl(), "https://app.example.com/login", "login URL is <APP_FRONTEND_URL>/login");
  eq(frontendUrl.getLoginUrl(), "https://app.example.com/login", "getLoginUrl() does NOT double-append /login (no /login/login)");
  check(!frontendUrl.isLocalhostUrl(frontendUrl.getLoginUrl()), "generated production URL is not a localhost URL");

  setEnv("NODE_ENV", "development");
  setEnv("APP_FRONTEND_URL", undefined);
  eq(frontendUrl.getFrontendUrl(), "http://localhost:3000", "localhost convenience applies ONLY in development");

  // Production tripwire inside the email service: refuse to queue a localhost link.
  setEnv("NODE_ENV", "production");
  setEnv("APP_FRONTEND_URL", "https://app.example.com");
  const emailsBefore = db.emails.length;
  const refused = await emailService.sendApplicationApprovedEmail({
    to: "owner@unit.test", applicantName: "Dev", restaurantName: "Dev Restaurant",
    applicationRef: "APP-REFUSED", approvedAt: "now", planName: "Premium",
    loginUrl: "http://localhost:3000/login", loginEmail: "owner@unit.test", temporaryPassword: null,
  });
  eq(refused, null, "approval email with a localhost login URL is REFUSED in production (returns null)");
  eq(db.emails.length, emailsBefore, "no EmailLog row was created for the refused localhost email");

  // Missing APP_FRONTEND_URL in production → loginUrl null is passed through
  // explicitly (never replaced with a fabricated/localhost URL).
  const skipped = await emailService.sendApplicationApprovedEmail({
    to: "owner@unit.test", applicationRef: "APP-NOURL", loginUrl: null, temporaryPassword: null,
    restaurantName: "Dev Restaurant", planName: "Premium", approvedAt: "now", loginEmail: "owner@unit.test",
  });
  check(skipped && skipped.payload && skipped.payload.data.loginUrl === null,
    "null loginUrl is handled explicitly (never replaced with a fabricated/localhost URL)");

  setEnv("NODE_ENV", "test");
});

// ═══════════════════════════════════════════════
//  5. REAL CREDENTIALS ONLY — never fabricated, sanitized after send
// ═══════════════════════════════════════════════
asyncSection(async () => {
  section("5. APPROVAL EMAIL CARRIES THE REAL TEMPORARY CREDENTIAL");
  setEnv("NODE_ENV", "test");
  setEnv("APP_FRONTEND_URL", "https://app.example.com");
  // SMTP still failing from section 4 → queued rows keep their full payload.

  const REAL_TEMP = "RealTemp#9x2!";
  const row1 = await emailService.sendApplicationApprovedEmail({
    to: "owner@unit.test", applicantName: "Dev", restaurantName: "Dev Restaurant",
    applicationRef: "APP-0521", approvedAt: "18 Sep 2026", planName: "Premium",
    loginUrl: "https://app.example.com/login", loginEmail: "owner@unit.test",
    temporaryPassword: REAL_TEMP,
  });
  check(row1 && row1.id, "APPLICATION_APPROVED email queued");
  eq(row1.template, "APPLICATION_APPROVED", "template is APPLICATION_APPROVED");
  eq(row1.payload.data.temporaryPassword, REAL_TEMP, "the ACTUAL provisioning temporary password is passed through");
  eq(row1.payload.data.loginUrl, "https://app.example.com/login", "login URL is the configured production URL");
  eq(row1.payload.data.loginEmail, "owner@unit.test", "login email is the real provisioned admin email");
  check(row1.payload.html.includes("RealTemp#9x2!"), "rendered email contains the real temporary password (not a fake one)");
  check(!row1.payload.html.includes("$2a$") && !row1.payload.html.includes("$2b$"), "no bcrypt hash is ever rendered as a password");

  section("5b. No plaintext credential available → none invented");
  const row2 = await emailService.sendApplicationApprovedEmail({
    to: "owner@unit.test", applicantName: "Self Serve", restaurantName: "Self Serve Restaurant",
    applicationRef: "APP-0522", approvedAt: "18 Sep 2026", planName: "Premium",
    loginUrl: "https://app.example.com/login", loginEmail: "owner@unit.test",
    temporaryPassword: undefined,
  });
  eq(row2.payload.data.temporaryPassword, null, "self-serve approval email has temporaryPassword=null (never fabricated)");
  check(!/"temporaryPassword"\s*:\s*"[^"]+/.test(JSON.stringify(row2.payload.data)), "no invented password string in the payload data");

  section("5c. Credential sanitized from the EmailLog after successful send");
  nodemailerCalls.throwOnSend = false;
  await emailConfig.saveEmailProvider("GRAPH");
  process.env.MICROSOFT_GRAPH_TENANT_ID = "tenant-unit";
  process.env.MICROSOFT_GRAPH_CLIENT_ID = "client-unit";
  process.env.MICROSOFT_GRAPH_CLIENT_SECRET = "secret-unit";
  process.env.MICROSOFT_GRAPH_SENDER_EMAIL = "sender@unit.test";
  process.env.MICROSOFT_GRAPH_ENABLED = "true";
  graphClient.resetGraphClient();
  mockGraphFetch();
  const sentRow = await emailService.deliverQueuedRow(row1);
  eq(sentRow.status, "SENT", "queued approval email delivered through the active transport");
  eq(sentRow.payload.sanitized, true, "payload is marked sanitized after a successful send");
  check(!("temporaryPassword" in sentRow.payload.data), "temporary password REMOVED from the stored EmailLog after send");
  check(!("html" in sentRow.payload) && !("text" in sentRow.payload), "rendered html/text (embedded credential) removed from the EmailLog");
  check(!JSON.stringify(sentRow.payload).includes("RealTemp#9x2!"), "plaintext credential no longer persisted anywhere in the row");

  section("5d. Welcome-credentials email carries the real login URL (no /login/login)");
  const credRow = await emailService.sendUserCredentialsEmail({
    to: "admin@unit.test", adminName: "Ravi", restaurantName: "Dev Restaurant",
    loginEmail: "admin@unit.test", temporaryPassword: "TempPass#123",
    loginUrl: "https://app.example.com/login",
  });
  eq(credRow.payload.data.loginUrl, "https://app.example.com/login", "credentials email login URL is the configured production URL");
  check(!credRow.payload.data.loginUrl.endsWith("/login/login"), "no /login/login bug in the credentials email URL");
  check(String(credRow.idempotencyKey).startsWith("WELCOME_ADMIN_CREDENTIALS:admin@unit.test"), "credentials email keeps its idempotency key (queue/retry preserved)");
  unmockGraphFetch();

  section("5e. SA credentials queuing helper refuses localhost/missing URLs");
  const saSrc = require("fs").readFileSync(path.join(__dirname, "..", "services", "super-admin.service.js"), "utf8");
  check(/getSafeLoginUrl\s*\}\s*=\s*require\("\.\.\/utils\/frontendUrl"\)/.test(saSrc), "super-admin.service uses the centralized getSafeLoginUrl helper");
  const qStart = saSrc.indexOf("async function queueAdminCredentialsEmail");
  const qHelper = saSrc.slice(qStart, qStart + 1600);
  check(qHelper.includes("getSafeLoginUrl()") && !qHelper.includes('+ "/login"'), "credentials email URL is NOT built by appending another /login");
  check(qHelper.includes("return false") && qHelper.includes("NOT queued"), "credentials email is explicitly NOT queued when the safe URL is unavailable");
});

// ═══════════════════════════════════════════════
(async () => {
  for (const s of sections) { try { await s(); } catch (e) { failed++; console.log("  \u2718 SECTION ERROR:", e.message); } }
  // Restore environment + fetch for any subsequently-run test file.
  for (const k of Object.keys(process.env)) if (!(k in ENV_SNAPSHOT)) delete process.env[k];
  Object.assign(process.env, ENV_SNAPSHOT);
  unmockGraphFetch();
  console.log(`\n──────── RESULTS: ${passed} passed, ${failed} failed ────────`);
  process.exit(failed > 0 ? 1 : 0);
})();
