/**
 * Email OTP verification service (platform scope).
 *
 * Security model:
 *  - Cryptographically secure 6-digit OTP (crypto.randomInt) — never predictable.
 *  - ONLY a SHA-256 hash is stored; the plaintext lives in the request lifetime
 *    and the queued email payload — never in a column, never in a log.
 *  - 10 minute expiry, max 5 verification attempts, 60 second resend cooldown.
 *  - A new OTP invalidates the previous one (single active row per
 *    email+purpose — the row is replaced on resend).
 *  - Successful verification clears the hash immediately (the OTP can never be
 *    reused) and records verifiedAt — the application gate reads ONLY this.
 *  - Changing the email address invalidates the verification (delete row).
 *  - Anti-enumeration: duplicate-application detection happens at submission,
 *    never in the OTP endpoints.
 */
const crypto = require("crypto");
const { platformPrisma: prisma } = require("../config/tenantPrisma");
const { normalizeEmail, isValidEmail } = require("../utils/email");
const { sendOtpEmail, sendEmailVerifiedEmail } = require("./email.service");
const { getLoginUrl } = require("../utils/frontendUrl");
const logger = require("../logger/logger");

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
// Max OTP requests per email within the rolling window (rate-limit friendly
// extra layer on top of the per-IP express limiter).
const OTP_MAX_REQUESTS_PER_WINDOW = 5;
const OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000;

const PURPOSE = {
  ONBOARDING: "ONBOARDING",
  PASSWORD_RESET: "PASSWORD_RESET",
  EMAIL_CHANGE: "EMAIL_CHANGE",
};

function apiError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode || 400;
  return err;
}

/** SHA-256 hash of the OTP — the ONLY representation ever persisted. */
function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

/** Constant-time hash comparison (avoids timing oracles on the hash). */
function hashesMatch(a, b) {
  const bufA = Buffer.from(String(a), "hex");
  const bufB = Buffer.from(String(b), "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Cryptographically secure 6-digit code (000000–999999, uniform). */
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/** Validate + normalize an incoming email, or throw a clean 400. */
function requireValidEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean || !isValidEmail(clean)) throw apiError("Please enter a valid email address.", 400);
  return clean;
}

/** Count OTP requests for this email inside the rolling window. */
async function recentRequestCount(email) {
  const since = new Date(Date.now() - OTP_REQUEST_WINDOW_MS);
  const row = await prisma.emailVerification.findFirst({ where: { email, purpose: PURPOSE.ONBOARDING } });
  if (!row) return 0;
  // lastSentAt tracks the most recent request; createdAt bounds the row age.
  return row.lastSentAt && row.lastSentAt > since ? OTP_MAX_REQUESTS_PER_WINDOW : 0;
}

/**
 * STEP 2 — POST /api/onboarding/email/send-otp
 * Generates the OTP, stores ONLY its hash and sends the email. Throws a
 * controlled error when the email could not be sent (the applicant must know
 * verification did not start).
 */
async function sendVerificationOtp(rawEmail, meta = {}) {
  const email = requireValidEmail(rawEmail);

  // Per-email rolling-window cap (defense in depth on top of the IP limiter).
  const count = await recentRequestCount(email);
  if (count >= OTP_MAX_REQUESTS_PER_WINDOW) {
    throw apiError("Too many verification codes requested. Please try again later.", 429);
  }

  // Resend cooldown.
  const existing = await prisma.emailVerification.findFirst({
    where: { email, purpose: PURPOSE.ONBOARDING },
  });
  if (existing && existing.lastSentAt && Date.now() - new Date(existing.lastSentAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(existing.lastSentAt).getTime())) / 1000);
    throw apiError(`Please wait ${waitSec}s before requesting a new code.`, 429);
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  // One active verification per email+purpose: replace the previous row →
  // old OTPs are invalidated the moment a new one is issued.
  await prisma.emailVerification.deleteMany({ where: { email, purpose: PURPOSE.ONBOARDING } });
  await prisma.emailVerification.create({
    data: {
      email,
      purpose: PURPOSE.ONBOARDING,
      otpHash: hashOtp(otp),
      expiresAt,
      attempts: 0,
      lastSentAt: new Date(),
      verifiedAt: null,
    },
  });

  // Delivery failure MUST surface: never mark verified, never pretend success.
  try {
    await sendOtpEmail({ to: email, otp, expiresInMinutes: OTP_TTL_MS / 60000 });
    logger.info(`[OTP] OTP_SENT email=${email} purpose=${PURPOSE.ONBOARDING} ip=${meta.ipAddress || "-"}`);
  } catch (e) {
    // Remove the unusable verification so the applicant can retry cleanly.
    await prisma.emailVerification.deleteMany({ where: { email, purpose: PURPOSE.ONBOARDING } }).catch(() => {});
    throw apiError("Unable to send verification email. Please try again.", 502);
  }

  return {
    sent: true,
    email,
    expiresInSeconds: OTP_TTL_MS / 1000,
    resendAvailableAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
    message: "Verification code sent to your email.",
  };
}

/**
 * STEP 5 — POST /api/onboarding/email/verify-otp
 * Verifies the OTP server-side. On success the row keeps `verifiedAt` set and
 * the hash is cleared (OTP cannot be reused). Status is readable via /status.
 */
async function verifyOtp(rawEmail, rawOtp) {
  const email = requireValidEmail(rawEmail);
  const otp = String(rawOtp || "").trim();
  if (!/^\d{6}$/.test(otp)) throw apiError("Enter the 6-digit verification code.", 400);

  const row = await prisma.emailVerification.findFirst({
    where: { email, purpose: PURPOSE.ONBOARDING },
    orderBy: { createdAt: "desc" },
  });

  // Anti-enumeration: an unknown email gets the same "invalid code" response.
  if (!row) throw apiError("Invalid or expired verification code. Please request a new one.", 400);
  if (row.verifiedAt) return { verified: true, message: "Email already verified." };

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    throw apiError("Your verification code has expired. Please request a new one.", 400);
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    throw apiError("Too many incorrect attempts. Please request a new code.", 429);
  }

  if (!hashesMatch(row.otpHash, hashOtp(otp))) {
    const attempts = row.attempts + 1;
    await prisma.emailVerification.update({ where: { id: row.id }, data: { attempts } });
    logger.warn(`[OTP] OTP_FAILED email=${email} attempts=${attempts}/${OTP_MAX_ATTEMPTS}`);
    if (attempts >= OTP_MAX_ATTEMPTS) {
      throw apiError("Too many incorrect attempts. Please request a new code.", 429);
    }
    throw apiError("Invalid verification code. Please check and try again.", 400);
  }

  // Success — clear the hash (single-use), stamp verifiedAt, reset attempts.
  await prisma.emailVerification.update({
    where: { id: row.id },
    data: { verifiedAt: new Date(), attempts: 0, otpHash: "verified" },
  });
  logger.info(`[OTP] OTP_VERIFIED email=${email} purpose=${PURPOSE.ONBOARDING}`);

  // Transactional confirmation email (queued; delivery failure never blocks
  // the verification result itself). Applicant continues from the login URL,
  // where the backend resumes their wizard at the correct step. Name/restaurant
  // are not known yet — the OTP step precedes the wizard's details steps.
  try {
    await sendEmailVerifiedEmail({
      to: email,
      applicationUrl: getLoginUrl(),
    });
  } catch (mailErr) {
    logger.warn(`[OTP] EMAIL_VERIFIED enqueue skipped: ${mailErr.message}`);
  }

  return { verified: true, message: "Email verified successfully." };
}

/** Is this email verified for onboarding? (server-side source of truth) */
async function isEmailVerified(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;
  const row = await prisma.emailVerification.findFirst({
    where: { email, purpose: PURPOSE.ONBOARDING, verifiedAt: { not: null } },
  });
  return !!row;
}

/**
 * Email change invalidates verification — the new address must be verified
 * again before the application can be submitted.
 */
async function invalidateVerification(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return;
  await prisma.emailVerification.deleteMany({ where: { email, purpose: PURPOSE.ONBOARDING } });
}

/** Verification status payload for the applicant UI (no sensitive fields). */
async function verificationStatus(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email || !isValidEmail(email)) return { email: email || "", verified: false, pending: false };
  const row = await prisma.emailVerification.findFirst({
    where: { email, purpose: PURPOSE.ONBOARDING },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return { email, verified: false, pending: false };
  const expired = new Date(row.expiresAt).getTime() < Date.now();
  return {
    email,
    verified: !!row.verifiedAt,
    pending: !row.verifiedAt && !expired,
    expiresInSeconds: expired ? 0 : Math.max(0, Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 1000)),
    resendAvailableAfterSeconds: Math.max(
      0,
      Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(row.lastSentAt || 0).getTime())) / 1000)
    ),
  };
}

module.exports = {
  PURPOSE,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  generateOtp,
  hashOtp,
  sendVerificationOtp,
  verifyOtp,
  isEmailVerified,
  invalidateVerification,
  verificationStatus,
};
