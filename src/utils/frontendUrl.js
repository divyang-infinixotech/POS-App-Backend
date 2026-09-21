/**
 * Centralized frontend/public application URL resolution.
 *
 * The ONLY place that turns APP_FRONTEND_URL into an email-safe base URL.
 * Every email link (login, continue application, credential login URL, expiry
 * reminders) MUST go through this helper — never inline
 * `process.env.APP_FRONTEND_URL || "http://localhost:3000"` in a caller.
 *
 * Rules:
 *  - APP_FRONTEND_URL is the single configuration point (see .env.example).
 *    Development sets http://localhost:3000; production MUST set its real
 *    frontend origin (e.g. https://app.yourdomain.com).
 *  - Trailing slashes are stripped so callers append "/login" safely.
 *  - DEVELOPMENT-ONLY fallback: when APP_FRONTEND_URL is unset and NODE_ENV is
 *    "development", the legacy http://localhost:3000 convenience applies.
 *  - PRODUCTION SAFETY: in any non-development environment a missing
 *    APP_FRONTEND_URL NEVER produces a localhost URL. getFrontendUrl() throws
 *    a configuration error (logged, never silent) and getSafeLoginUrl()
 *    returns null so callers can fail the email URL generation instead of
 *    mailing an incorrect localhost link.
 */

const DEV_FALLBACK = "http://localhost:3000";
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i;

let warned = false;

function nodeEnv() {
  return String(process.env.NODE_ENV || "development").toLowerCase();
}

function isDevelopment() {
  return nodeEnv() === "development";
}

/** Configured frontend origin without a trailing slash (throws in production when unset). */
function getFrontendUrl() {
  const raw = String(process.env.APP_FRONTEND_URL || "").trim().replace(/\/+$/, "");
  if (raw) return raw;

  // Localhost convenience exists ONLY in development (and tests never mail).
  if (isDevelopment()) return DEV_FALLBACK;

  // Production misconfiguration — loud, explicit, and never a silent localhost.
  const message =
    "[FrontendUrl] APP_FRONTEND_URL is not set — refusing to generate a frontend URL. " +
    "Email links would otherwise point at localhost. Set APP_FRONTEND_URL to the " +
    "production frontend origin (e.g. https://app.yourdomain.com).";
  console.error(message);
  const err = new Error("APP_FRONTEND_URL is not configured — cannot generate a frontend URL for email links.");
  err.statusCode = 503;
  throw err;
}

/**
 * Production-safe login URL. Returns "<APP_FRONTEND_URL>/login", or null when
 * the URL cannot be generated safely (production without APP_FRONTEND_URL).
 * Callers must handle null explicitly — never substitute a fabricated URL.
 */
function getSafeLoginUrl() {
  try {
    return getFrontendUrl() + "/login";
  } catch (e) {
    return null;
  }
}

/** Convenience: the login URL used by every email CTA (legacy shape). */
function getLoginUrl() {
  return getFrontendUrl() + "/login";
}

/**
 * True when the given URL points at localhost. Used by email senders as a
 * production tripwire: a localhost login URL must never reach a production
 * recipient, even if some future caller misconfigures the base URL.
 */
function isLocalhostUrl(url) {
  return LOCALHOST_RE.test(String(url || ""));
}

module.exports = { getFrontendUrl, getLoginUrl, getSafeLoginUrl, isLocalhostUrl, isDevelopment };
