/**
 * Platform-level Razorpay gateway configuration — the single source of truth
 * for how the backend talks to the payment gateway.
 *
 * - Persisted in the existing SystemSetting table under the key
 *   "payment_gateway_razorpay" as JSON. Secrets (key secret, webhook secret)
 *   are stored AES-256-GCM encrypted via utils/encryption.js — never plain
 *   text, never returned by any API, never logged.
 * - Falls back to RAZORPAY_* environment variables when no saved config
 *   exists (keeps existing deployments working without a migration step).
 * - Read-through caching with short TTL so a checkout doesn't hit the DB on
 *   every request, while a Super Admin save still takes effect within
 *   seconds without a server restart.
 */
const prisma = require("../config/prisma");
const { encryptSecret, decryptSecret, isEncrypted } = require("../utils/encryption");

const SETTING_KEY = "payment_gateway_razorpay";
const CACHE_TTL_MS = 5 * 1000;

let cache = { ts: 0, value: null };

function maskKeyId(keyId) {
  if (!keyId) return "";
  const s = String(keyId);
  if (s.length <= 8) return `${s.slice(0, 4)}********`;
  return `${s.slice(0, 4)}********${s.slice(-4)}`;
}

function envFallback() {
  // Enabled defaults to TRUE only when real keys are present (or RAZORPAY_ENABLED
  // is explicitly set). With no keys at all the gateway must show as DISABLED —
  // a bare RAZORPAY_WEBHOOK_SECRET alone is not enough to accept payments.
  const hasKeys = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  return {
    gateway: "RAZORPAY",
    environment: process.env.RAZORPAY_ENV === "LIVE" ? "LIVE" : "TEST",
    enabled: process.env.RAZORPAY_ENABLED !== undefined
      ? process.env.RAZORPAY_ENABLED !== "false"
      : hasKeys,
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  };
}

/** Load raw stored config (encrypted secrets) from DB. */
async function loadStoredConfig() {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return null;
  const parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
  // Normalize legacy rows that may lack the id field
  return { ...parsed, id: parsed.id || row.id };
}

/** Decrypted, backend-only config. Falls back to env vars when unsaved. */
async function getGatewayConfig() {
  const now = Date.now();
  if (cache.value && now - cache.ts < CACHE_TTL_MS) return cache.value;

  let stored = null;
  try {
    stored = await loadStoredConfig();
  } catch (_) {
    stored = null;
  }

  const cfg = stored
    ? {
        gateway: "RAZORPAY",
        environment: stored.environment === "LIVE" ? "LIVE" : "TEST",
        enabled: stored.enabled !== false,
        keyId: stored.keyId || "",
        keySecret: decryptSecret(stored.keySecretEnc),
        webhookSecret: decryptSecret(stored.webhookSecretEnc),
        lastCheckedAt: stored.lastCheckedAt || null,
        lastWebhook: stored.lastWebhook || null,
      }
    : envFallback();

  cache = { ts: now, value: cfg };
  return cfg;
}

/** Public, frontend-safe status — masked IDs, booleans, never secrets. */
async function getGatewayStatus() {
  const stored = await loadStoredConfig().catch(() => null);
  const webhookRow = await prisma.systemSetting
    .findUnique({ where: { key: `${SETTING_KEY}_webhook` } })
    .catch(() => null);
  const env = envFallback();
  const cfg = stored
    ? {
        keyId: stored.keyId || "",
        environment: stored.environment === "LIVE" ? "LIVE" : "TEST",
        enabled: stored.enabled !== false,
        webhookConfigured: isEncrypted(stored.webhookSecretEnc) && decryptSecret(stored.webhookSecretEnc) !== "",
      }
    : {
        keyId: env.keyId,
        environment: env.environment,
        enabled: env.enabled,
        webhookConfigured: !!env.webhookSecret,
      };

  const keyId = cfg.keyId;
  const hasKeyId = !!keyId;
  // Stored config → secret lives encrypted in the DB; otherwise fall back to
  // the env var. (Explicit ternary — the previous boolean-or precedence made
  // the env-fallback-with-all-secrets path report PARTIAL instead of CONFIGURED.)
  const hasSecret = stored
    ? isEncrypted(stored?.keySecretEnc) && decryptSecret(stored?.keySecretEnc) !== ""
    : !!env.keySecret;

  let status = "NOT_CONFIGURED";
  if (hasKeyId && hasSecret && cfg.webhookConfigured) status = "CONFIGURED";
  else if (hasKeyId || hasSecret || cfg.webhookConfigured) status = "PARTIAL";

  return {
    gateway: "RAZORPAY",
    environment: cfg.environment,
    enabled: cfg.enabled,
    status,
    keyId: maskKeyId(keyId),
    keyIdConfigured: hasKeyId,
    secretConfigured: hasSecret,
    webhookConfigured: cfg.webhookConfigured,
    lastCheckedAt: stored?.lastCheckedAt || null,
    lastWebhook: (stored?.lastWebhook || webhookRow?.value) || null,
  };
}

/**
 * Persist config. Secrets arrive as either:
 *  - new plaintext (will be encrypted), or
 *  - a masked placeholder / empty → preserve the existing stored value.
 */
async function saveGatewayConfig({ environment, enabled, keyId, keySecret, webhookSecret, checkedAt }) {
  const stored = await loadStoredConfig().catch(() => null);

  const nextKeySecret = keySecret && !isEncrypted(keySecret) && keySecret.includes("*") === false
    ? encryptSecret(keySecret)
    : stored?.keySecretEnc || encryptSecret(keySecret || "");

  // Empty field → preserve existing. Masked placeholder (contains '*') → preserve.
  const resolveSecret = (incoming, existingEnc) => {
    if (!incoming || String(incoming).includes("*")) return existingEnc || "";
    return encryptSecret(incoming);
  };

  const data = {
    gateway: "RAZORPAY",
    environment: environment === "LIVE" ? "LIVE" : "TEST",
    enabled: enabled !== false,
    keyId: keyId && !String(keyId).includes("*") ? String(keyId).trim() : stored?.keyId || "",
    keySecretEnc: resolveSecret(keySecret, stored?.keySecretEnc),
    webhookSecretEnc: resolveSecret(webhookSecret, stored?.webhookSecretEnc),
  };
  if (checkedAt) data.lastCheckedAt = checkedAt;

  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value: data },
    create: { key: SETTING_KEY, value: data },
  });
  cache = { ts: 0, value: null }; // invalidate
  return data;
}

async function setGatewayEnabled(enabled) {
  const stored = await loadStoredConfig().catch(() => null);
  if (!stored) {
    const env = envFallback();
    await saveGatewayConfig({
      environment: env.environment,
      enabled,
      keyId: env.keyId,
      keySecret: env.keySecret,
      webhookSecret: env.webhookSecret,
    });
    return;
  }
  await saveGatewayConfig({ ...stored, enabled });
}

async function recordWebhookActivity(event) {
  const stored = await loadStoredConfig().catch(() => null);
  const lastWebhook = {
    event: event?.event || "unknown",
    status: "Processed",
    receivedAt: new Date().toISOString(),
  };

  // When no stored config exists yet, don't create one from raw env (that
  // would persist plaintext secrets). Store the webhook activity in a small
  // separate record instead.
  if (!stored) {
    await prisma.systemSetting.upsert({
      where: { key: `${SETTING_KEY}_webhook` },
      update: { value: lastWebhook },
      create: { key: `${SETTING_KEY}_webhook`, value: lastWebhook },
    });
    return;
  }

  // Preserve the stored (encrypted) config exactly — only touch lastWebhook.
  await prisma.systemSetting.update({
    where: { id: stored.id },
    data: { value: { ...stored, lastWebhook } },
  });
  cache = { ts: 0, value: null };
}

/** Quick check used by checkout: gateway must be configured AND enabled. */
async function isGatewayReady() {
  const cfg = await getGatewayConfig();
  return cfg.enabled && !!cfg.keyId && !!cfg.keySecret && !!cfg.webhookSecret;
}

module.exports = {
  SETTING_KEY,
  getGatewayConfig,
  getGatewayStatus,
  saveGatewayConfig,
  setGatewayEnabled,
  recordWebhookActivity,
  isGatewayReady,
};
