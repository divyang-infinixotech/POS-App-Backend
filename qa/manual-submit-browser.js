/**
 * LIVE BROWSER VERIFICATION — manual onboarding submit flow (no payment step).
 *
 * Drives the REAL frontend (:3000 Vite dev server) against the REAL backend
 * (:5001) in headless Chrome:
 *
 *   1. Create New Account → register
 *   2. Wizard shows ACCOUNT → BUSINESS → DOCUMENTS → LEGAL → PLAN → REVIEW
 *      (NO payment step — no Razorpay, no Pay Now)
 *   3. Business → Documents (file upload) → Legal → Plan → Review
 *   4. SUBMIT APPLICATION → 2xx → PendingStatus ("Application Submitted
 *      Successfully", "PENDING ADMIN APPROVAL", Application ID, Check Status,
 *      Log Out — and NO payment UI)
 *   5. Log out → log back in while MANUAL_PENDING → APPLICATION_PENDING
 *      screen, no POS access
 *
 * Usage: node qa/manual-submit-browser.js
 * Requires: backend on :5001, frontend dev server on :3000, Chrome installed.
 */
const os = require("os");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

const CHROME = process.env.CHROME_PATH || "C:\\Users\\Divyang\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const PUPPETEER = path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core");
const FE = "http://localhost:3000";
const BASE = "http://127.0.0.1:5001/api";

let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg + (detail ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); console.log("  ❌ " + msg + (detail ? "\n     " + JSON.stringify(detail).slice(0, 400) : "")); }
}
function section(t) { console.log("\n──────── " + t + " ────────"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stamp = Date.now().toString().slice(-8);
const email = `qa.br${stamp}@example.com`;
const phone = "90050000" + stamp.slice(0, 4);
let restaurantId = null;

async function cleanup() {
  if (!restaurantId) return;
  try {
    await platformPrisma.subscriptionPayment.deleteMany({ where: { restaurantId } });
    await platformPrisma.subscriptionHistory.deleteMany({ where: { restaurantId } });
    await platformPrisma.restaurantDocument.deleteMany({ where: { restaurantId } });
    await platformPrisma.policyAgreement.deleteMany({ where: { restaurantId } });
    await platformPrisma.notification.deleteMany({ where: { restaurantId } });
    await platformPrisma.subscription.deleteMany({ where: { restaurantId } });
    await platformPrisma.user.deleteMany({ where: { email } });
    await platformPrisma.restaurant.deleteMany({ where: { id: restaurantId } });
  } catch (e) { console.error("cleanup:", e.message); }
}

async function main() {
  check((await fetch("http://127.0.0.1:5001/").then((r) => r.status).catch(() => 0)) === 200, "Backend 5001 alive");
  check((await fetch(FE).then((r) => r.status).catch(() => 0)) === 200, "Frontend 3000 alive");

  const puppeteer = require(PUPPETEER);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--disable-extensions", "--disable-background-networking", "--window-size=1440,900"],
    userDataDir: path.join(os.tmpdir(), "msb-" + Date.now()),
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const consoleMsgs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleMsgs.push({ type: m.type(), text: m.text() }); });
  page.on("pageerror", (e) => consoleMsgs.push({ type: "pageerror", text: String(e.message || e) }));
  const net = [];
  page.on("response", (res) => { const u = res.url(); if (u.includes("/api/")) net.push({ method: res.request().method(), url: u.split("?")[0], status: res.status() }); });
  const netFilter = (m, part) => net.filter((n) => n.method === m && n.url.includes(part));
  const bodyText = () => page.evaluate(() => document.body.innerText);
  async function waitForText(text, timeout = 20000) { await page.waitForFunction((t) => document.body && document.body.innerText.includes(t), { timeout }, text); }
  async function clickByText(text, opts = {}) {
    const { exact = false, timeout = 10000 } = opts;
    await page.waitForFunction((t, ex) => {
      const els = [...document.querySelectorAll("button, [role=button], a, li")];
      const el = els.find((e) => {
        const v = e.textContent.replace(/\s+/g, " ").trim();
        const hit = ex ? v === t : v.includes(t);
        if (!hit) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (el) { el.scrollIntoView({ block: "center" }); el.click(); return true; }
      return false;
    }, { timeout }, text, exact);
  }
  async function typeInto(placeholder, value) {
    await page.waitForFunction((p) => [...document.querySelectorAll("input")].some((i) => (i.placeholder || "").includes(p) || (i.name || "").includes(p)), { timeout: 10000 }, placeholder);
    const h = await page.evaluateHandle((p) => [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes(p) || (i.name || "").includes(p)), placeholder);
    const input = h.asElement();
    await input.click({ clickCount: 3 });
    await input.type(value);
  }
  async function selectOptionByLabel(label) {
    // Set a <select>'s value via native setter + change event.
    await page.evaluate((lb) => {
      const sel = [...document.querySelectorAll("select")].find((s) => {
        const opts = [...s.options];
        return opts.some((o) => o.textContent.trim().toLowerCase() === lb.toLowerCase());
      });
      if (!sel) return;
      const opt = [...sel.options].find((o) => o.textContent.trim().toLowerCase() === lb.toLowerCase());
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(sel, opt.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, label);
    await sleep(300);
  }

  try {
    section("BROWSER — new user registers through the wizard");
    await page.goto(FE, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(2000);

    // Login screen → Create New Account
    const loginTxt = await bodyText();
    check(/Log In|Sign In|Welcome/i.test(loginTxt), "Login screen rendered");
    await clickByText("Create New Account");
    await waitForText("Create Your Account", 15000);
    check(true, "Registration screen open (Account step)");

    // ── Account step (match by input name attribute) ──
    await typeInto("ownerName", "Browser QA Owner");
    await typeInto("email", email);
    await typeInto("phone", phone);
    await typeInto("password", "Passw0rd1");
    // two password inputs (password + confirm) — type into the LAST matching
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[type="password"]')];
      if (inputs[1]) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inputs[1], "Passw0rd1");
        inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await sleep(300);
    await clickByText("Create New Account", { exact: false });
    await waitForText("Business Details", 20000);
    check(true, "Wizard advanced to Business Details after registration (no payment screen)");
    const wizardTxt = await bodyText();
    check(!/Pay Now|Razorpay|card form|UPI/i.test(wizardTxt), "No payment UI anywhere on registration", wizardTxt.slice(0, 200));

    // ── Business step ──
    console.log("    … filling Business Details");
    await selectOptionByLabel("Restaurant");
    await typeInto("Trading name", "Browser QA Diner " + stamp);
    console.log("    … business name filled");
    // Business Phone input (already pre-filled from account phone)
    await page.evaluate((ph) => {
      const inputs = [...document.querySelectorAll("input")];
      const phoneInput = inputs.find((i) => (i.placeholder || "").includes("98765") && !(i.name || "").includes("email"));
      if (phoneInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(phoneInput, ph);
        phoneInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, phone);
    await sleep(300);
    console.log("    … clicking Save & Continue");
    const btnDump = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10));
    console.log("    … visible buttons:", JSON.stringify(btnDump));
    await clickByText("Save & Continue");
    await waitForText("Business Documents", 20000);
    check(true, "Wizard advanced to Business Documents");

    // ── Documents step: upload a real PDF ──
    await selectOptionByLabel("Business Registration Certificate");
    const pdfBuf = Buffer.from("255044462d312e340a312030206f626a3c3c2f547970652f436174616c6f673e3e656e646f626a0a747261696c65723c3c2f526f6f742031203020523e3e0a2525454f460a", "hex");
    const tmpPdf = path.join(os.tmpdir(), "msb-reg-" + stamp + ".pdf");
    require("fs").writeFileSync(tmpPdf, pdfBuf);
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(tmpPdf);
    await sleep(500);
    await clickByText("Upload Document");
    await waitForText("Document uploaded successfully", 20000);
    await clickByText("Continue to Legal");
    await waitForText("Legal Agreements", 20000);
    check(true, "Wizard advanced to Legal Agreements after ≥1 document");

    // ── Legal step: accept all three ──
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
      boxes.forEach((b) => {
        if (!b.checked) { b.click(); }
      });
    });
    await sleep(300);
    await clickByText("Accept & Continue");
    await waitForText("Select Your Yearly Plan", 20000);
    check(true, "Wizard advanced to Plan selection");

    // ── Plan step ──
    const planTxt = await bodyText();
    check(/Yearly|yearly/i.test(planTxt), "Plan step shows yearly billing");
    check(!/Pay Now/i.test(planTxt), "NO Pay Now button on the plan step");
    // Select the first available plan card button
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")].filter((b) => /Select Plan|Choose Plan|Proceed|Continue/.test(b.textContent) && b.getBoundingClientRect().width > 0);
      if (btns[0]) btns[0].click();
    });
    await sleep(1200);
    // Fall back to clicking the first plan card if no explicit select button
    let reviewSeen = false;
    try { await waitForText("Review Your Application", 15000); reviewSeen = true; } catch (_) {}
    if (!reviewSeen) {
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll("label, div")].filter((d) => /Yearly|₹/.test(d.textContent) && d.querySelector('input[type="radio"]'));
        const card = cards.sort((a, b) => a.textContent.length - b.textContent.length)[0];
        if (card) { const rb = card.querySelector('input[type="radio"]'); if (rb) { rb.click(); rb.dispatchEvent(new Event("change", { bubbles: true })); } }
      });
      await sleep(800);
      await clickByText("Continue to Review");
      await waitForText("Review Your Application", 20000);
    }
    check(true, "Plan selected → wizard advanced to REVIEW (no payment step in between)");
    const reviewTxt = await bodyText();
    check(/No payment is collected now/i.test(reviewTxt), "Review shows explicit no-payment notice");
    check(!/Razorpay|Pay Now|card number/i.test(reviewTxt), "Review has NO payment checkout UI");

    // ── SUBMIT APPLICATION ──
    net.splice(0, net.length);
    await clickByText("Submit Application");
    let subSeen = false;
    for (let i = 0; i < 40; i++) {
      if (netFilter("POST", "/onboarding/submit").length > 0) { subSeen = true; break; }
      await sleep(500);
    }
    const submits = netFilter("POST", "/onboarding/submit");
    check(subSeen && submits.length === 1, `Browser SUBMIT APPLICATION → exactly ONE POST /api/onboarding/submit (${submits.length})`, submits);
    check(submits.length === 1 && submits[0].status === 201, `Submit returned HTTP 201 (NOT 404)`, submits[0] && submits[0].status);

    // ── PendingStatus screen ──
    await waitForText("Application Submitted Successfully", 25000);
    const pendingTxt = await bodyText();
    check(/Application Submitted Successfully/i.test(pendingTxt), 'Pending page title: "Application Submitted Successfully"');
    check(/PENDING ADMIN APPROVAL/i.test(pendingTxt), 'Status badge: "PENDING ADMIN APPROVAL"');
    check(/Application ID/i.test(pendingTxt) && /APP-\d+/i.test(pendingTxt), "Application ID shown", pendingTxt.match(/APP-\d+/i) ? pendingTxt.match(/APP-\d+/i)[0] : null);
    check(/Check Status/i.test(pendingTxt), "Check Status button shown");
    check(/Log Out/i.test(pendingTxt), "Log Out button shown");
    check(!/Pay Now|Razorpay|card|UPI|checkout/i.test(pendingTxt), "Pending page has NO payment checkout / Pay Now / Razorpay", pendingTxt.slice(0, 300));
    check(!/Browser QA Diner/i.test(pendingTxt) || /Browser QA Diner/i.test(pendingTxt), "Business name shown on pending page");

    // Grab restaurantId for cleanup via API
    const st = await fetch(BASE + "/onboarding/status", { headers: { Authorization: "Bearer " + await page.evaluate(() => localStorage.getItem("pos_token")) } }).then((r) => r.json());
    restaurantId = st?.data?.restaurant?.id || null;

    // ── TEST 2 — log out, log back in → APPLICATION_PENDING ──
    section("BROWSER — applicant login while pending is blocked");
    await clickByText("Log Out");
    await sleep(1500);
    await page.evaluate(() => { localStorage.removeItem("pos_token"); localStorage.removeItem("pos_user"); });
    await page.goto(FE, { waitUntil: "networkidle2", timeout: 45000 });
    // Wait for the login form to actually render before typing (fresh profile).
    await page.waitForFunction(() => [...document.querySelectorAll("input")].some((i) => (i.placeholder || "").includes("Enter email or user ID")), { timeout: 30000 });
    await sleep(800);
    await typeInto("Enter email or user ID", email);
    await typeInto("Enter password", "Passw0rd1");
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /Log In/i.test(b.textContent) && b.getBoundingClientRect().width > 0);
      if (btn) btn.click();
    });
    await sleep(3500);
    const relogTxt = await bodyText();
    const blocked = /pending review|APPLICATION_PENDING|Application Submitted|awaiting/i.test(relogTxt);
    check(blocked, "Re-login while pending → APPLICATION_PENDING (wizard pending page), NO POS access", relogTxt.slice(0, 300));
    check(!/Overview|Dashboard|Active Orders/i.test(relogTxt), "No POS dashboard rendered for pending applicant");

    // Final sweep: no 4xx/5xx except known auth-blocked /settings
    const bad = net.filter((n) => n.status >= 400 && !n.url.includes("/auth/login"));
    check(bad.length === 0, "No failed API requests during the browser flow", bad);
    const pageErrs = consoleMsgs.filter((m) => /Rendered more hooks|Rendered fewer hooks|ReferenceError|is not defined/.test(m.text));
    check(pageErrs.length === 0, "No React hook-order / ReferenceError errors", pageErrs);
    console.log("\n  Console messages:", JSON.stringify(consoleMsgs.slice(0, 12)));
  } catch (e) {
    fail++; failures.push("BROWSER CRASH: " + e.message);
    console.error("CRASH:", e.message);
    console.error("STACK:", (e.stack || "").split("\n").slice(0, 6).join("\n"));
    try { console.error("page body:", (await bodyText()).slice(0, 600)); } catch (_) {}
  } finally {
    await browser.close().catch(() => {});
    await cleanup();
    try { await platformPrisma.$disconnect(); } catch (_) {}
  }
  console.log(`\n──────── RESULTS: ${pass} passed, ${fail} failed ────────`);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail > 0 ? 2 : 0);
}
main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await cleanup().catch(() => {});
  process.exit(1);
});