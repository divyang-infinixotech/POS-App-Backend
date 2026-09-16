/**
 * Shared email validation + normalization.
 *
 * ONE canonical rule set for every identity path in the platform:
 *   - public self-serve registration (/auth/register)
 *   - login lookup (public + every tenant schema)
 *   - staff creation (tenant User + public User)
 *   - Super Admin restaurant creation (admin account + restaurant contact)
 *   - onboarding business/application details
 *
 * Normalization is deliberately LIMITED to trimming surrounding whitespace and
 * lowercasing (case-insensitive identity). Provider-specific transforms —
 * Gmail dot removal, "+tag" stripping, etc. — are NEVER applied:
 *   John.Smith@gmail.com  → john.smith@gmail.com   (case only)
 *   john.smith+pos@gmail.com stays john.smith+pos@gmail.com
 * Passwords are NOT touched by this module (they stay case-sensitive).
 */

// Strict, pragmatic RFC-5321-style pattern:
//  - local part: dot-atom of allowed characters, no leading/trailing/double dots
//  - domain: one or more dot-separated labels (alnum + hyphen, no leading/trailing
//    hyphen) ending in an alphabetic TLD of at least 2 characters
//    (rejects "john@gmail", "john@gmail..com", "john @gmail.com", "@gmail.com", "john@")
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/** Canonical form used for storage + every lookup: trim → lowercase. */
function normalizeEmail(email) {
  if (email === null || email === undefined) return email;
  return String(email).trim().toLowerCase();
}

/** Strict format check. Accepts any case/whitespace — normalize first for storage. */
function isValidEmail(email) {
  const value = normalizeEmail(email);
  if (!value) return false;
  return EMAIL_RE.test(value);
}

/**
 * Validation message for a required email field.
 * Returns null when valid, otherwise the exact user-facing message:
 *   empty   → "Email is required."
 *   invalid → "Please enter a valid email address."
 */
function emailRequiredError(email) {
  const value = normalizeEmail(email);
  if (!value) return "Email is required.";
  if (!EMAIL_RE.test(value)) return "Please enter a valid email address.";
  return null;
}

/**
 * Validation message for an OPTIONAL email field ("", null, undefined pass).
 * Returns null when acceptable, otherwise the invalid-format message.
 */
function emailOptionalError(email) {
  const value = normalizeEmail(email);
  if (!value) return null;
  if (!EMAIL_RE.test(value)) return "Please enter a valid email address.";
  return null;
}

/**
 * Legal acceptance gate shared by BOTH restaurant-creation flows
 * (Super Admin creation AND self-serve registration). Returns null when the
 * payload carries explicit acceptance of BOTH the Terms & Conditions and the
 * Privacy Policy, otherwise the user-facing rejection message.
 */
function legalAcceptanceError(data) {
  const terms = !!(data && (data.termsAccepted === true || data.termsAccepted === "true"));
  const privacy = !!(data && (data.privacyAccepted === true || data.privacyAccepted === "true"));
  if (!terms || !privacy) {
    return "Please accept the Terms & Conditions and Privacy Policy to continue.";
  }
  return null;
}

module.exports = {
  EMAIL_RE,
  normalizeEmail,
  isValidEmail,
  emailRequiredError,
  emailOptionalError,
  legalAcceptanceError,
};
