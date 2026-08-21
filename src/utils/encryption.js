/**
 * Lightweight symmetric encryption for gateway secrets at rest.
 *
 * AES-256-GCM keyed from JWT_SECRET (already required at startup) so no extra
 * secret needs to be provisioned. Secrets are encrypted before database
 * storage and only decrypted on the backend when actually needed (outbound
 * Razorpay calls, signature verification). They are never sent to the
 * frontend, logged, or included in error responses.
 */
const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error("JWT_SECRET is required for secret storage");
    err.statusCode = 500;
    throw err;
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/** Encrypt a plaintext string → "v1:<iv>:<tag>:<ciphertext>" (base64). */
function encryptSecret(plain) {
  if (plain == null || plain === "") return "";
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** Decrypt a value produced by encryptSecret. Returns "" for empty values. */
function decryptSecret(value) {
  if (!value) return "";
  try {
    const parts = String(value).split(":");
    if (parts[0] !== "v1" || parts.length !== 4) return "";
    const key = getKey();
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch (_) {
    return ""; // corrupted/foreign key — treat as not configured, never crash
  }
}

/** True when the string looks like a stored ciphertext (vs a plain value). */
function isEncrypted(value) {
  return typeof value === "string" && value.startsWith("v1:");
}

module.exports = { encryptSecret, decryptSecret, isEncrypted };
