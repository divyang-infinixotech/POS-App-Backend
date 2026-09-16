/**
 * Email template preview generator — development/QA only.
 *
 *   npm run email:preview
 *
 * Writes every template to ./email-previews/<name>.html and .txt using
 * REALISTIC DUMMY DATA. Never sends email, never touches the database, never
 * uses real OTPs, credentials or customer data. This is the safe way to QA
 * layout/branding/variable handling without an SMTP round-trip.
 */
const fs = require("fs");
const path = require("path");
const { renderTemplate, EMAIL_SUBJECTS } = require("../src/templates/email.templates");

const OUT_DIR = path.join(__dirname, "..", "email-previews");

const DUMMY = {
  brandName: "Nirka POS",
  primaryColor: "#16A34A",
  supportEmail: "support@nirka.example",
  restaurantName: "Spice Garden Bistro",
};

const CASES = [
  {
    name: "email-verification",
    template: "EMAIL_VERIFICATION_OTP",
    data: { applicantName: "Ravi Kumar", otp: "482913", expiresInMinutes: 10, ...DUMMY },
  },
  {
    name: "email-verified",
    template: "EMAIL_VERIFIED",
    data: { applicantName: "Ravi Kumar", applicationUrl: "http://localhost:3000/login", ...DUMMY },
  },
  {
    name: "application-submitted",
    template: "APPLICATION_SUBMITTED_APPLICANT",
    data: {
      applicantName: "Ravi Kumar", restaurantName: DUMMY.restaurantName,
      applicationRef: "APP-0042", submittedAt: "15 Sep 2026, 10:30 AM", ...DUMMY,
    },
  },
  {
    name: "application-admin",
    template: "APPLICATION_SUBMITTED_ADMIN",
    data: {
      applicantName: "Ravi Kumar", applicantEmail: "ravi@example.com",
      applicantPhone: "+91 98765 43210", restaurantName: DUMMY.restaurantName,
      businessType: "Fine Dining", city: "Bengaluru", state: "Karnataka",
      applicationRef: "APP-0042", submittedAt: "15 Sep 2026, 10:30 AM", ...DUMMY,
    },
  },
  {
    name: "application-expiring",
    template: "APPLICATION_EXPIRING",
    data: {
      applicantName: "Ravi Kumar", restaurantName: DUMMY.restaurantName,
      applicationRef: "APP-0042", expiresAt: "22 Sep 2026",
      applicationUrl: "http://localhost:3000/login", ...DUMMY,
    },
  },
  {
    name: "application-expired",
    template: "APPLICATION_EXPIRED",
    data: {
      applicantName: "Ravi Kumar", restaurantName: DUMMY.restaurantName,
      applicationRef: "APP-0042", expiredAt: "15 Sep 2026",
      applicationUrl: "http://localhost:3000/login", ...DUMMY,
    },
  },
  {
    name: "account-approved",
    template: "WELCOME_ADMIN_CREDENTIALS",
    data: {
      adminName: "Ravi", restaurantName: DUMMY.restaurantName,
      loginEmail: "ravi@example.com", temporaryPassword: "Kf9#mQx2$vLp",
      loginUrl: "http://localhost:3000/login", ...DUMMY,
    },
  },
  {
    name: "password-change-required",
    template: "PASSWORD_CHANGE_REQUIRED",
    data: { name: "Ravi", loginUrl: "http://localhost:3000/login", ...DUMMY },
  },
  {
    name: "smtp-test",
    template: "SMTP_TEST",
    data: { testedAt: "15 Sep 2026, 10:30 AM", fromEmail: "noreply@nirka.example", ...DUMMY },
  },
];

let failures = 0;
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

for (const c of CASES) {
  try {
    const { subject, html, text } = renderTemplate(c.template, c.data);
    const missing = [];
    // Variable-safety QA: rendered output must never contain raw bad values.
    for (const bad of ["undefined", "null", "[object Object]"]) {
      if (html.includes(bad) || text.includes(bad)) missing.push(bad);
    }
    if (missing.length) {
      failures++;
      console.error(`❌ ${c.name}: rendered output contains ${missing.join(", ")}`);
    }
    const banner = `<!-- Subject: ${typeof EMAIL_SUBJECTS[c.template] === "function" ? EMAIL_SUBJECTS[c.template](c.data.restaurantName) : (subject || "")} | PREVIEW ONLY — dummy data -->`;
    fs.writeFileSync(path.join(OUT_DIR, `${c.name}.html`), `${banner}\n${html}`);
    fs.writeFileSync(path.join(OUT_DIR, `${c.name}.txt`), `[Subject] ${subject}\n\n${text}`);
    console.log(`✅ ${c.name}.html / .txt  (subject: ${subject})`);
  } catch (e) {
    failures++;
    console.error(`❌ ${c.name}: ${e.message}`);
  }
}

console.log(`\nPreviews written to: ${OUT_DIR}`);
process.exit(failures ? 1 : 0);
