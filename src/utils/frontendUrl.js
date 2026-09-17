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
 *  - The localhost fallback is a DEVELOPMENT convenience only: a warning is
 *    logged once per process when the app is not in development mode, so a
 *    production misconfiguration is visible in the logs instead of silently
 *    mailing localhost links.
 */

let warned = false;

function getFrontendUrl() {
  const raw = String(process.env.APP_FRONTEND_URL || "").trim().replace(/\/+$/, "");
  if (raw) return raw;

  // Fallback — development convenience. Warn (once) outside development so a
  // missing production env var is never a silent localhost link.
  const nodeEnv = String(process.env.NODE_ENV || "development").toLowerCase();
  if (!warned && nodeEnv !== "development" && nodeEnv !== "test") {
    warned = true;
    // console (not the request logger) — this fires during module use, and the
    // message deliberately contains no secrets or request data.
    console.warn(
      "[FrontendUrl] APP_FRONTEND_URL is not set — falling back to http://localhost:3000. " +
        "Email links will point at localhost. Set APP_FRONTEND_URL in production."
    );
  }
  return "http://localhost:3000";
}

/** Convenience: the login URL used by every email CTA. */
function getLoginUrl() {
  return getFrontendUrl() + "/login";
}

module.exports = { getFrontendUrl, getLoginUrl };
