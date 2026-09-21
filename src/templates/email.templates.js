/**
 * Nirka POS — professional email template system.
 *
 * ARCHITECTURE
 *  - ONE shared table-based layout (emailLayout) + reusable components
 *    (emailHeader, emailFooter, emailButton, emailCard, emailInfoRow(s),
 *    emailOtpBox, emailCredentialsBox, emailAlert, emailDivider).
 *  - Every template returns { subject, html, text } — the text version is the
 *    plain-text fallback required by RFC-compatible mail clients.
 *  - Subjects live in ONE map (EMAIL_SUBJECTS) — never scattered in callers.
 *  - Branding is dynamic (brandFromData): server-resolved config only, never
 *    frontend-supplied, so tenant A branding can never leak into tenant B mail.
 *
 * COMPATIBILITY RULES (Gmail / Outlook / Apple Mail / Android / iOS)
 *  - Table-based layout, inline CSS only, Arial/Helvetica/sans-serif fallbacks.
 *  - No JavaScript, no external CSS/fonts/images, no CSS that Gmail/Outlook strip.
 *  - 600px max-width centered card; buttons rendered as padded <a> in a table.
 *
 * SECURITY RULES
 *  - Escaped output everywhere (escapeHtml) — no HTML injection via names.
 *  - Missing optional fields are OMITTED (never "undefined"/"null").
 *  - Plaintext temporary password appears ONLY in WELCOME_ADMIN_CREDENTIALS /
 *    PASSWORD_RESET (one-time secret by design). OTP appears only in OTP mails.
 *  - Never rendered: hashes, JWTs, API keys, SMTP credentials, tenant schemas.
 */

// ─── Brand defaults (overridable per send via server-resolved config) ────────
const BRAND = {
  name: "Nirka POS",
  tagline: "Restaurant Management & Point of Sale",
  primary: "#16A34A",
  primaryDark: "#15803D",
  dark: "#0F172A",
  muted: "#64748B",
  light: "#F1F5F9",
  border: "#E2E8F0",
};

// ─── Centralized subjects (spec §6) ──────────────────────────────────────────
const EMAIL_SUBJECTS = {
  EMAIL_VERIFICATION: "Verify your email address — Nirka POS",
  EMAIL_VERIFIED: "Email verified successfully — Nirka POS",
  APPLICATION_SUBMITTED: (restaurantName) => `Application received — ${restaurantName || "Nirka POS"}`,
  NEW_APPLICATION_ADMIN: (restaurantName) => `New restaurant application — ${restaurantName || "Nirka POS"}`,
  APPLICATION_EXPIRING: "Your Nirka POS application is expiring soon",
  APPLICATION_EXPIRED: "Your Nirka POS application has expired",
  ACCOUNT_APPROVED: "Your Nirka POS account is ready",
  PASSWORD_CHANGE_REQUIRED: "Password change required — Nirka POS",
  SMTP_TEST: "Nirka POS — Email configuration test",
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Safe string: null/undefined/empty → null (rows/buttons are then omitted). */
function safe(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" || s === "undefined" || s === "null" ? null : s;
}

/** Merge server-resolved branding over the defaults. Never client-supplied. */
function brandFromData(data = {}) {
  return {
    ...BRAND,
    name: safe(data.brandName) || BRAND.name,
    tagline: safe(data.brandTagline) || BRAND.tagline,
    primary: safe(data.primaryColor) || BRAND.primary,
    logoUrl: safe(data.logoUrl),
    restaurantName: safe(data.restaurantName),
    supportEmail: safe(data.supportEmail),
    supportPhone: safe(data.supportPhone),
  };
}

const FONT = "font-family:Arial,Helvetica,sans-serif;";

// ─── Reusable components (spec §2) ───────────────────────────────────────────

/** Brand header band: logo image when available, otherwise wordmark + tagline. */
function emailHeader(brand, restaurantName) {
  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" width="132" alt="${escapeHtml(brand.name)}" style="display:block;border:0;outline:none;text-decoration:none;max-width:132px;" />`
    : `<div style="${FONT}font-size:20px;font-weight:bold;color:#ffffff;letter-spacing:1.5px;">${escapeHtml(brand.name)}</div>
       <div style="${FONT}font-size:10px;color:rgba(255,255,255,0.72);letter-spacing:0.6px;margin-top:4px;">${escapeHtml(brand.tagline)}</div>`;
  const tenantLine = restaurantName
    ? `<div style="${FONT}font-size:11px;color:rgba(255,255,255,0.85);margin-top:8px;">${escapeHtml(restaurantName)}</div>`
    : "";
  return `<tr><td style="background:${brand.dark};padding:26px 32px 22px 32px;" align="center">${logo}${tenantLine}</td></tr>`;
}

/** Footer band: support contact, security note, copyright (spec §3). */
function emailFooter(brand, note) {
  const contact =
    brand.supportEmail || brand.supportPhone
      ? `Questions? Contact support${brand.supportEmail ? ` at <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:${brand.primary};font-weight:bold;text-decoration:underline;">${escapeHtml(brand.supportEmail)}</a>` : ""}${brand.supportEmail && brand.supportPhone ? " or " : ""}${brand.supportPhone ? `on ${escapeHtml(brand.supportPhone)}` : ""}.<br/>`
      : "";
  return `<tr><td style="background:${brand.light};padding:18px 32px;" align="center">
    <div style="${FONT}font-size:11px;color:${brand.muted};line-height:1.7;">
      ${contact}${escapeHtml(note || `This email was sent automatically. Please do not reply unless a Reply-To address is configured.`)}<br/>
      &copy; ${new Date().getFullYear()} ${escapeHtml(brand.name)} — ${escapeHtml(brand.tagline)}
    </div>
  </td></tr>`;
}

/** CTA button — table-wrapped bulletproof button (Outlook-safe). */
function emailButton(label, url, brand) {
  if (!safe(url) || !safe(label)) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
    <tr><td style="background:${brand.primary};border-radius:10px;background-color:${brand.primary};">
      <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;background-color:${brand.primary};color:#ffffff;${FONT}font-size:15px;font-weight:bold;text-decoration:none;padding:13px 34px;border-radius:10px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** Rounded white card used for credential / status blocks. */
function emailCard(innerHtml, brand, bg) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg || brand.light};border:1px solid ${brand.border};border-radius:12px;">
    <tr><td style="padding:16px 20px;">${innerHtml}</td></tr>
  </table>`;
}

/** One label/value row (label hidden entirely when value is missing). */
function emailInfoRow(label, value, brand, strong) {
  const v = safe(value);
  if (!v || !safe(label)) return "";
  return `<tr>
    <td style="${FONT}padding:8px 16px;font-size:11px;font-weight:bold;color:${brand.muted};text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="${FONT}padding:8px 16px;font-size:13px;font-weight:${strong ? "bold" : "normal"};color:${strong ? brand.dark : "#334155"};word-break:break-word;">${escapeHtml(v)}</td>
  </tr>`;
}

/** Info table — rows with missing values are dropped automatically. */
function emailInfoRows(rows, brand) {
  const body = rows.map((r) => emailInfoRow(r.label, r.value, brand, r.strong)).join("");
  if (!body) return "";
  return `<tr><td style="padding:0 32px 24px 32px;">
    ${emailCard(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>`, brand)}
  </td></tr>`;
}

/** Prominent OTP box — large monospace digits, high contrast. */
function emailOtpBox(otp, brand) {
  const digits = safe(otp);
  if (!digits) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:6px auto 4px auto;">
    <tr><td align="center" style="background:#ffffff;border:2px solid ${brand.primary};border-radius:12px;padding:14px 30px;">
      <span style="${FONT}font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:bold;letter-spacing:10px;color:${brand.dark};">${escapeHtml(digits)}</span>
    </td></tr>
  </table>`;
}

/** Credential card — visually separated login details (temp password etc.). */
function emailCredentialsBox(items, brand) {
  const rows = items
    .filter((i) => safe(i.value))
    .map(
      (i) => `<tr>
        <td style="${FONT}padding:9px 18px;font-size:11px;font-weight:bold;color:${brand.muted};text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;vertical-align:top;">${escapeHtml(i.label)}</td>
        <td style="${FONT}padding:9px 18px;font-size:14px;font-weight:bold;color:${brand.dark};word-break:break-all;">${escapeHtml(i.value)}</td>
      </tr>`
    )
    .join("");
  if (!rows) return "";
  return `<tr><td style="padding:0 32px 24px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:2px dashed ${brand.primary};border-radius:12px;">
      <tr><td colspan="2" style="${FONT}padding:12px 18px 4px 18px;font-size:12px;font-weight:bold;color:${brand.primaryDark};text-transform:uppercase;letter-spacing:0.5px;">Login information</td></tr>
      ${rows}
    </table>
  </td></tr>`;
}

/** Alert / security note banner (type: "warning" | "info" | "success"). */
function emailAlert(message, brand, type) {
  const m = safe(message);
  if (!m) return "";
  const palette = {
    warning: { bg: "#FEF2F2", border: "#FECACA", color: "#B91C1C", icon: "&#128274;" },
    info: { bg: "#EFF6FF", border: "#BFDBFE", color: "#1D4ED8", icon: "&#8505;&#65039;" },
    success: { bg: "#F0FDF4", border: "#BBF7D0", color: "#15803D", icon: "&#9989;" },
  }[type || "info"];
  return `<tr><td style="padding:0 32px 24px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${palette.bg};border:1px solid ${palette.border};border-radius:12px;">
      <tr><td style="${FONT}padding:12px 16px;font-size:12px;font-weight:bold;color:${palette.color};line-height:1.6;">${palette.icon} ${escapeHtml(m)}</td></tr>
    </table>
  </td></tr>`;
}

/** Thin horizontal divider. */
function emailDivider(brand) {
  return `<tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid ${brand.border};margin:0 0 20px 0;" /></td></tr>`;
}

/** Paragraph helper (keeps builder HTML terse). */
function p(text, brand, extra) {
  return `<p style="margin:0 0 12px 0;${FONT}font-size:14px;color:#334155;line-height:1.7;${extra || ""}">${text}</p>`;
}

// ─── Shared layout (spec §4) ─────────────────────────────────────────────────

/**
 * The ONE email shell. opts:
 * { title, greeting, bodyHtml, infoRows, cta:{label,url}, credentialsBox,
 *   alert:{message,type}, supportEmail, supportPhone, footerNote,
 *   restaurantName, data (branding overrides) }
 */
function emailLayout(opts) {
  const {
    title,
    greeting = "Hello,",
    bodyHtml = "",
    infoRows = [],
    cta = null,
    credentialsBox = null,
    alert = null,
    footerNote = null,
    data = {},
  } = opts;

  const brand = brandFromData(data);
  const heading = safe(title) ? `<tr><td style="padding:28px 32px 6px 32px;${FONT}font-size:21px;font-weight:bold;color:${brand.dark};">${escapeHtml(title)}</td></tr>` : "";
  const greet = safe(greeting) ? `<tr><td style="padding:0 32px 12px 32px;${FONT}font-size:14px;color:#334155;">${escapeHtml(greeting)}</td></tr>` : "";
  const ctaHtml =
    cta && safe(cta.url)
      ? `<tr><td style="padding:0 32px 24px 32px;" align="center">${emailButton(cta.label || "Open", cta.url, brand)}</td></tr>
         <tr><td style="padding:0 32px 24px 32px;" align="center"><span style="${FONT}font-size:11px;color:${brand.muted};">If the button does not work, copy this link into your browser:<br/><a href="${escapeHtml(cta.url)}" style="color:${brand.primary};word-break:break-all;">${escapeHtml(cta.url)}</a></span></td></tr>`
      : "";
  const alertHtml = alert ? emailAlert(alert.message, brand, alert.type) : "";
  const credHtml = credentialsBox ? emailCredentialsBox(credentialsBox, brand) : "";

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${escapeHtml(title || brand.name)}</title>
</head>
<body style="margin:0;padding:0;background-color:#F8FAFC;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8FAFC" style="background-color:#F8FAFC;">
  <tr><td align="center" style="padding:24px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid ${brand.border};border-radius:14px;overflow:hidden;">
      ${emailHeader(brand, brand.restaurantName)}
      ${heading}
      ${greet}
      ${bodyHtml ? `<tr><td style="padding:0 32px 20px 32px;${FONT}font-size:14px;color:#334155;line-height:1.7;">${bodyHtml}</td></tr>` : ""}
      ${infoRows.length ? emailInfoRows(infoRows, brand) : ""}
      ${credHtml}
      ${ctaHtml}
      ${alertHtml}
      ${emailDivider(brand)}
      ${emailFooter(brand, footerNote)}
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Standard plain-text fallback built from the same fields (spec §7). */
function textLayout({ title, greeting, lines = [], infoRows = [], cta, alert, data = {} }) {
  const brand = brandFromData(data);
  const out = [brand.name, brand.tagline, "", title, "", greeting ? greeting : ""];
  for (const l of lines) if (safe(l)) out.push(l);
  if (infoRows.length) {
    out.push("");
    for (const r of infoRows) if (safe(r.value)) out.push(`${r.label}: ${r.value}`);
  }
  if (alert && safe(alert.message)) out.push("", alert.message);
  if (cta && safe(cta.url)) out.push("", `${cta.label || "Open"}: ${cta.url}`);
  if (brand.supportEmail) out.push("", `Support: ${brand.supportEmail}`);
  out.push("", `— ${brand.name} (${brand.tagline})`, `© ${new Date().getFullYear()} ${brand.name}`);
  return out.filter((x) => x !== "").join("\n");
}

const greetFor = (name) => (safe(name) ? `Hello ${name},` : "Hello,");

// ─── Template builders — one per business event ──────────────────────────────

const templates = {
  // A. EMAIL VERIFICATION OTP -------------------------------------------------
  EMAIL_VERIFICATION_OTP: (d) => ({
    subject: EMAIL_SUBJECTS.EMAIL_VERIFICATION,
    html: emailLayout({
      data: d,
      title: "Verify your email address",
      greeting: greetFor(d.applicantName),
      bodyHtml:
        p(`Thank you for applying to <strong>${escapeHtml(brandFromData(d).name)}</strong>${d.restaurantName ? ` for your <strong>${escapeHtml(d.restaurantName)}</strong> application` : ""}. Use the verification code below to verify your email address:`) +
        emailOtpBox(d.otp, brandFromData(d)) +
        p(`This verification code expires in <strong>${escapeHtml(d.expiresInMinutes || 10)} minutes</strong>.`, null, "margin-top:12px;"),
      alert: {
        type: "warning",
        message: `Never share this code with anyone. ${brandFromData(d).name} support will never ask for your verification code. If you did not request this verification, you can safely ignore this email.`,
      },
    }),
    text: textLayout({
      data: d,
      title: "Verify your email address",
      greeting: greetFor(d.applicantName),
      lines: [
        `Thank you for applying to ${brandFromData(d).name}.`,
        `Your verification code is: ${d.otp || ""}`,
        `This code expires in ${d.expiresInMinutes || 10} minutes.`,
        `Never share this code with anyone. ${brandFromData(d).name} support will never ask for your verification code.`,
        "If you did not request this verification, you can safely ignore this email.",
      ],
    }),
  }),

  // B. EMAIL VERIFICATION SUCCESS ----------------------------------------------
  EMAIL_VERIFIED: (d) => {
    const brand = brandFromData(d);
    return {
      subject: EMAIL_SUBJECTS.EMAIL_VERIFIED,
      html: emailLayout({
        data: d,
        title: "Email verified successfully",
        greeting: greetFor(d.applicantName),
        bodyHtml:
          p(`Your email address <strong>${escapeHtml(d.email || "")}</strong> has been successfully verified.`) +
          p(`You can now continue with your ${escapeHtml(brand.name)} application.`),
        cta: safe(d.applicationUrl) ? { label: "Continue Application", url: d.applicationUrl } : null,
        alert: { type: "success", message: "No further action is needed right now — we will guide you through the next steps." },
      }),
      text: textLayout({
        data: d,
        title: "Email verified successfully",
        greeting: greetFor(d.applicantName),
        lines: [`Your email address ${d.email || ""} has been successfully verified.`, `You can now continue with your ${brand.name} application.`],
        cta: safe(d.applicationUrl) ? { label: "Continue Application", url: d.applicationUrl } : null,
      }),
    };
  },

  // C. APPLICATION SUBMITTED — APPLICANT ---------------------------------------
  APPLICATION_SUBMITTED_APPLICANT: (d) => {
    const brand = brandFromData(d);
    return {
      subject: EMAIL_SUBJECTS.APPLICATION_SUBMITTED(d.restaurantName),
      html: emailLayout({
        data: d,
        title: "We received your application",
        greeting: greetFor(d.applicantName),
        bodyHtml: p(`Your application for <strong>${escapeHtml(brand.name)}</strong> has been successfully submitted and is now <strong style="color:${brand.primary};">UNDER REVIEW</strong>. We will review your application and notify you when there is an update.`),
        infoRows: [
          { label: "Restaurant", value: d.restaurantName, strong: true },
          { label: "Email", value: d.email },
          { label: "Application ID", value: d.applicationRef },
          { label: "Submitted", value: d.submittedAt },
          { label: "Status", value: "UNDER REVIEW", strong: true },
        ],
        cta: safe(d.applicationUrl) ? { label: "View Application", url: d.applicationUrl } : null,
      }),
      text: textLayout({
        data: d,
        title: "We received your application",
        greeting: greetFor(d.applicantName),
        lines: ["Your application for Nirka POS has been successfully submitted.", "We will review your application and notify you when there is an update."],
        infoRows: [
          { label: "Restaurant", value: d.restaurantName },
          { label: "Email", value: d.email },
          { label: "Application ID", value: d.applicationRef },
          { label: "Submitted", value: d.submittedAt },
          { label: "Status", value: "UNDER REVIEW" },
        ],
        cta: safe(d.applicationUrl) ? { label: "View Application", url: d.applicationUrl } : null,
      }),
    };
  },

  // D. APPLICATION SUBMITTED — SUPER ADMIN --------------------------------------
  APPLICATION_SUBMITTED_ADMIN: (d) => {
    const brand = brandFromData(d);
    return {
      subject: EMAIL_SUBJECTS.NEW_APPLICATION_ADMIN(d.restaurantName),
      html: emailLayout({
        data: d,
        title: "New application awaiting review",
        greeting: "Hello Super Admin,",
        bodyHtml: p(`A new restaurant application has been submitted to <strong>${escapeHtml(brand.name)}</strong> and is waiting for review.`),
        infoRows: [
          { label: "Restaurant", value: d.restaurantName, strong: true },
          { label: "Applicant", value: d.applicantName },
          { label: "Email", value: d.applicantEmail },
          { label: "Phone", value: d.applicantPhone },
          { label: "Business Type", value: d.businessType },
          { label: "City / State", value: [d.city, d.state].filter(Boolean).join(", ") },
          { label: "Application ID", value: d.applicationRef },
          { label: "Submitted", value: d.submittedAt },
          { label: "Status", value: "MANUAL_PENDING", strong: true },
        ],
        cta: safe(d.reviewUrl) ? { label: "Review Application", url: d.reviewUrl } : null,
        footerNote: "You are receiving this because you are a platform administrator.",
      }),
      text: textLayout({
        data: d,
        title: "New application awaiting review",
        greeting: "Hello Super Admin,",
        lines: ["A new restaurant application has been submitted and is waiting for review."],
        infoRows: [
          { label: "Restaurant", value: d.restaurantName },
          { label: "Applicant", value: d.applicantName },
          { label: "Email", value: d.applicantEmail },
          { label: "Phone", value: d.applicantPhone },
          { label: "Business Type", value: d.businessType },
          { label: "City / State", value: [d.city, d.state].filter(Boolean).join(", ") },
          { label: "Application ID", value: d.applicationRef },
          { label: "Submitted", value: d.submittedAt },
          { label: "Status", value: "MANUAL_PENDING" },
        ],
        cta: safe(d.reviewUrl) ? { label: "Review Application", url: d.reviewUrl } : null,
      }),
    };
  },

  // E1. APPLICATION EXPIRING (reminder) -----------------------------------------
  APPLICATION_EXPIRING: (d) => {
    const brand = brandFromData(d);
    return {
      subject: EMAIL_SUBJECTS.APPLICATION_EXPIRING,
      html: emailLayout({
        data: d,
        title: "Your application is expiring soon",
        greeting: greetFor(d.applicantName),
        bodyHtml:
          p(`Your ${escapeHtml(brand.name)} application for <strong>${escapeHtml(d.restaurantName || "")}</strong> is still awaiting completion/review.`) +
          p(`Your application is scheduled to expire on <strong>${escapeHtml(d.expiresAt || "")}</strong>. Please complete any required action before the expiration date.`),
        infoRows: [
          { label: "Restaurant", value: d.restaurantName, strong: true },
          { label: "Application ID", value: d.applicationRef },
          { label: "Expires On", value: d.expiresAt, strong: true },
        ],
        cta: safe(d.applicationUrl) ? { label: "Continue Application", url: d.applicationUrl } : null,
        alert: { type: "warning", message: "Applications that pass their expiry date are marked EXPIRED and cannot be processed further." },
      }),
      text: textLayout({
        data: d,
        title: "Your application is expiring soon",
        greeting: greetFor(d.applicantName),
        lines: [
          `Your ${brand.name} application for ${d.restaurantName || ""} is still awaiting completion/review.`,
          `Your application is scheduled to expire on: ${d.expiresAt || ""}`,
          "Please complete any required action before the expiration date.",
        ],
        infoRows: [
          { label: "Application ID", value: d.applicationRef },
          { label: "Expires On", value: d.expiresAt },
        ],
        cta: safe(d.applicationUrl) ? { label: "Continue Application", url: d.applicationUrl } : null,
      }),
    };
  },

  // E2. APPLICATION EXPIRED ------------------------------------------------------
  APPLICATION_EXPIRED: (d) => {
    const brand = brandFromData(d);
    return {
      subject: EMAIL_SUBJECTS.APPLICATION_EXPIRED,
      html: emailLayout({
        data: d,
        title: "Your application has expired",
        greeting: greetFor(d.applicantName),
        bodyHtml:
          p(`Your ${escapeHtml(brand.name)} application for <strong>${escapeHtml(d.restaurantName || "")}</strong> has expired because it was not completed/reviewed within the required period.`) +
          p(`If you still want to use ${escapeHtml(brand.name)}, you may submit a new application or contact support.`),
        infoRows: [
          { label: "Restaurant", value: d.restaurantName, strong: true },
          { label: "Application ID", value: d.applicationRef },
          { label: "Expired On", value: d.expiredAt, strong: true },
        ],
        cta: safe(d.applicationUrl) ? { label: "Start New Application", url: d.applicationUrl } : null,
      }),
      text: textLayout({
        data: d,
        title: "Your application has expired",
        greeting: greetFor(d.applicantName),
        lines: [
          `Your ${brand.name} application for ${d.restaurantName || ""} has expired because it was not completed/reviewed within the required period.`,
          "If you still want to use Nirka POS, you may submit a new application or contact support.",
        ],
        infoRows: [
          { label: "Application ID", value: d.applicationRef },
          { label: "Expired On", value: d.expiredAt },
        ],
        cta: safe(d.applicationUrl) ? { label: "Start New Application", url: d.applicationUrl } : null,
      }),
    };
  },

  // F. ACCOUNT APPROVED / USER CREDENTIALS --------------------------------------
  WELCOME_ADMIN_CREDENTIALS: (d) => {
    const brand = brandFromData(d);
    return {
      subject: EMAIL_SUBJECTS.ACCOUNT_APPROVED,
      html: emailLayout({
        data: d,
        title: "Your account is ready",
        greeting: greetFor(d.adminName),
        bodyHtml:
          p(`Your restaurant account has been approved and your ${escapeHtml(brand.name)} account has been created successfully.`) +
          p(`Use the login information below to sign in for the first time. You will be asked to set a new password immediately after logging in — after that, the temporary password stops working.`),
        credentialsBox: [
          { label: "Restaurant", value: d.restaurantName },
          { label: "User ID (Email)", value: d.loginEmail },
          { label: "TEMPORARY Password", value: d.temporaryPassword },
          { label: "Login URL", value: d.loginUrl },
          { label: "Role", value: "ADMIN" },
        ],
        cta: safe(d.loginUrl) ? { label: "Login to Nirka POS", url: d.loginUrl } : null,
        alert: { type: "warning", message: "For your security, change your temporary password immediately after signing in. Never share this email with anyone." },
      }),
      text: textLayout({
        data: d,
        title: "Your account is ready",
        greeting: greetFor(d.adminName),
        lines: [
          `Your restaurant account has been approved and your ${brand.name} account has been created.`,
          d.restaurantName ? `Restaurant: ${d.restaurantName}` : null,
          d.loginEmail ? `User ID: ${d.loginEmail}` : null,
          d.temporaryPassword ? `TEMPORARY Password: ${d.temporaryPassword}` : null,
          d.loginUrl ? `Login URL: ${d.loginUrl}` : null,
          "You must change this temporary password immediately after your first sign-in.",
          "Never share this email with anyone.",
        ],
        cta: safe(d.loginUrl) ? { label: "Login to Nirka POS", url: d.loginUrl } : null,
      }),
    };
  },

  // G. PASSWORD CHANGE REQUIRED ---------------------------------------------------
  PASSWORD_CHANGE_REQUIRED: (d) => {
    const brand = brandFromData(d);
    return {
      subject: EMAIL_SUBJECTS.PASSWORD_CHANGE_REQUIRED,
      html: emailLayout({
        data: d,
        title: "Password change required",
        greeting: greetFor(d.name),
        bodyHtml:
          p(`Your ${escapeHtml(brand.name)} account requires you to change your temporary password before continuing.`) +
          p(`Please sign in and create a new secure password.`),
        cta: safe(d.loginUrl) ? { label: "Change Password", url: d.loginUrl } : null,
        alert: { type: "info", message: "Your account stays limited until the temporary password has been changed." },
      }),
      text: textLayout({
        data: d,
        title: "Password change required",
        greeting: greetFor(d.name),
        lines: [
          `Your ${brand.name} account requires you to change your temporary password before continuing.`,
          "Please sign in and create a new secure password.",
        ],
        cta: safe(d.loginUrl) ? { label: "Change Password", url: d.loginUrl } : null,
      }),
    };
  },

  // H. SMTP TEST -----------------------------------------------------------------
  SMTP_TEST: (d) => {
    const brand = brandFromData(d);
    return {
      subject: EMAIL_SUBJECTS.SMTP_TEST,
      html: emailLayout({
        data: d,
        title: "Email configuration test",
        greeting: "Hello,",
        bodyHtml: p(`Your ${escapeHtml(brand.name)} email configuration is working correctly.`),
        infoRows: [
          { label: "SMTP Connection", value: "Successful", strong: true },
          { label: "Test Time", value: d.testedAt },
          { label: "Configured Sender", value: d.fromEmail },
        ],
        alert: { type: "success", message: "This is an automated test message from the Nirka POS system. You can safely discard it." },
        footerNote: "Triggered from Super Admin → System Settings → Email.",
      }),
      text: textLayout({
        data: d,
        title: "Email configuration test",
        greeting: "Hello,",
        lines: [
          `Your ${brand.name} email configuration is working correctly.`,
          d.testedAt ? `Test time: ${d.testedAt}` : null,
          d.fromEmail ? `Configured sender: ${d.fromEmail}` : null,
          "This is an automated test message from the Nirka POS system.",
        ],
      }),
    };
  },

  // I. GENERIC SYSTEM NOTIFICATION -----------------------------------------------
  GENERIC_NOTIFICATION: (d) => {
    const brand = brandFromData(d);
    return {
      subject: safe(d.subject) || `Notification from ${brand.name}`,
      html: emailLayout({
        data: d,
        title: safe(d.subject) || "Notification",
        greeting: greetFor(d.recipientName),
        bodyHtml: safe(d.message) ? p(escapeHtml(d.message).replace(/\n/g, "<br/>")) : "",
        cta: safe(d.buttonUrl) && safe(d.buttonText) ? { label: d.buttonText, url: d.buttonUrl } : null,
      }),
      text: textLayout({
        data: d,
        title: safe(d.subject) || "Notification",
        greeting: greetFor(d.recipientName),
        lines: [d.message],
        cta: safe(d.buttonUrl) && safe(d.buttonText) ? { label: d.buttonText, url: d.buttonUrl } : null,
      }),
    };
  },

  // Additional existing events (kept on the shared layout) -----------------------
  // APPLICATION_APPROVED — login info is rendered ONLY from real data: when a
  // real temporary credential exists (provisioning generated one) it renders in
  // the credentials box; otherwise the applicant signs in with the password they
  // created at registration (never a fabricated password). loginUrl may be null
  // (production without APP_FRONTEND_URL) — rows/CTA are then omitted entirely.
  APPLICATION_APPROVED: (d) => {
    const brand = brandFromData(d);
    return {
      subject: "Your Nirka POS application has been approved",
      html: emailLayout({
        data: d,
        title: "Your application has been approved",
        greeting: greetFor(d.applicantName),
        bodyHtml: p(`Great news! Your application has been <strong style="color:${brand.primary};">APPROVED</strong> and your restaurant workspace is now active.`) +
          (safe(d.temporaryPassword)
            ? p("Use the login information below to sign in for the first time. You will be asked to set a new password immediately after logging in.")
            : p(`Sign in with your registered email${safe(d.loginEmail) ? ` <strong>${escapeHtml(d.loginEmail)}</strong>` : ""} and the password you created during registration.`)),
        infoRows: [
          { label: "Restaurant", value: d.restaurantName, strong: true },
          { label: "Application ID", value: d.applicationRef },
          { label: "Approved On", value: d.approvedAt },
          { label: "Plan", value: d.planName },
          { label: "Login", value: d.loginEmail },
          { label: "Login URL", value: d.loginUrl },
        ],
        credentialsBox: safe(d.temporaryPassword)
          ? [
              { label: "Login (Email)", value: d.loginEmail },
              { label: "TEMPORARY Password", value: d.temporaryPassword },
              { label: "Login URL", value: d.loginUrl },
            ]
          : null,
        cta: safe(d.loginUrl) ? { label: "Login to Nirka POS", url: d.loginUrl } : null,
        alert: safe(d.temporaryPassword)
          ? { type: "warning", message: "For your security, change your temporary password immediately after signing in. Never share this email with anyone." }
          : { type: "info", message: "If you have forgotten your password, use the “Forgot password” option on the login page." },
      }),
      text: textLayout({
        data: d,
        title: "Your application has been approved",
        greeting: greetFor(d.applicantName),
        lines: [
          "Great news! Your application has been APPROVED and your restaurant workspace is now active.",
          safe(d.temporaryPassword)
            ? "Use the temporary password below to sign in for the first time — change it immediately after logging in."
            : `Sign in with your registered email${safe(d.loginEmail) ? ` ${d.loginEmail}` : ""} and the password you created during registration.`,
        ],
        infoRows: [
          { label: "Restaurant", value: d.restaurantName },
          { label: "Application ID", value: d.applicationRef },
          { label: "Approved On", value: d.approvedAt },
          { label: "Plan", value: d.planName },
          { label: "Login", value: d.loginEmail },
          { label: "Login URL", value: d.loginUrl },
          ...(safe(d.temporaryPassword) ? [{ label: "TEMPORARY Password", value: d.temporaryPassword }] : []),
        ],
        cta: safe(d.loginUrl) ? { label: "Login to Nirka POS", url: d.loginUrl } : null,
      }),
    };
  },

  APPLICATION_REJECTED: (d) => {
    const brand = brandFromData(d);
    return {
      subject: "Update on your Nirka POS application",
      html: emailLayout({
        data: d,
        title: "Update on your application",
        greeting: greetFor(d.applicantName),
        bodyHtml:
          p(`After review, we are unable to approve your application for <strong>${escapeHtml(d.restaurantName || "")}</strong> at this time.`) +
          (safe(d.reason) ? p(`<strong>Reason:</strong> ${escapeHtml(d.reason)}`) : "") +
          (safe(d.resubmissionNote) ? p(escapeHtml(d.resubmissionNote)) : p("If you believe this was a mistake, please contact support or submit a new application.")),
        infoRows: [
          { label: "Restaurant", value: d.restaurantName, strong: true },
          { label: "Application ID", value: d.applicationRef },
          { label: "Decision Date", value: d.decidedAt },
          { label: "Status", value: "NOT APPROVED", strong: true },
        ],
      }),
      text: textLayout({
        data: d,
        title: "Update on your application",
        greeting: greetFor(d.applicantName),
        lines: [
          `After review, we are unable to approve your application for ${d.restaurantName || ""} at this time.`,
          d.reason ? `Reason: ${d.reason}` : null,
          d.resubmissionNote || "If you believe this was a mistake, please contact support or submit a new application.",
        ],
        infoRows: [
          { label: "Application ID", value: d.applicationRef },
          { label: "Decision Date", value: d.decidedAt },
          { label: "Status", value: "NOT APPROVED" },
        ],
      }),
    };
  },

  PASSWORD_RESET: (d) => {
    const brand = brandFromData(d);
    return {
      subject: "Your Nirka POS password was reset",
      html: emailLayout({
        data: d,
        title: "Password reset",
        greeting: greetFor(d.name),
        bodyHtml:
          p(`A password reset was requested for your account. Your new temporary password is shown below.`) +
          p(`You will be asked to set a new password immediately after signing in.`),
        credentialsBox: [
          { label: "TEMPORARY Password", value: d.temporaryPassword },
          { label: "Login URL", value: d.loginUrl },
        ],
        cta: safe(d.loginUrl) ? { label: "Login to Nirka POS", url: d.loginUrl } : null,
        alert: { type: "warning", message: "If you did not request this reset, contact support immediately — your previous password no longer works." },
      }),
      text: textLayout({
        data: d,
        title: "Password reset",
        greeting: greetFor(d.name),
        lines: [
          "A password reset was requested for your account.",
          d.temporaryPassword ? `TEMPORARY Password: ${d.temporaryPassword}` : null,
          d.loginUrl ? `Login URL: ${d.loginUrl}` : null,
          "You will be asked to set a new password immediately after signing in.",
        ],
        cta: safe(d.loginUrl) ? { label: "Login to Nirka POS", url: d.loginUrl } : null,
      }),
    };
  },

  EMAIL_CHANGE_OTP: (d) => {
    const brand = brandFromData(d);
    return {
      subject: "Confirm your new email address — Nirka POS",
      html: emailLayout({
        data: d,
        title: "Confirm your new email",
        greeting: greetFor(d.name),
        bodyHtml: p(`Use the verification code below to confirm your new email address:`) + emailOtpBox(d.otp, brand) + p(`This code expires in <strong>${escapeHtml(d.expiresInMinutes || 10)} minutes</strong>.`, null, "margin-top:12px;"),
        alert: { type: "warning", message: `Never share this code with anyone. ${brand.name} support will never ask for your verification code.` },
      }),
      text: textLayout({
        data: d,
        title: "Confirm your new email",
        greeting: greetFor(d.name),
        lines: [`Your email change code is: ${d.otp || ""}`, `This code expires in ${d.expiresInMinutes || 10} minutes.`],
      }),
    };
  },
};

/**
 * Render a template by name. Unknown names fail loudly (programming error —
 * never silently send an empty email).
 */
function renderTemplate(templateName, data) {
  const builder = templates[templateName];
  if (!builder) throw new Error(`Unknown email template: ${templateName}`);
  return builder(data || {});
}

module.exports = { renderTemplate, EMAIL_SUBJECTS, BRAND, brandFromData, escapeHtml, safe };
