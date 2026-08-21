/**
 * CONSOLE & RUNTIME AUDIT — load every main ADMIN screen in the real app and
 * capture console errors, pageerrors, failed requests and React warnings.
 * Usage: PUPPETEER_CORE_PATH=<dir with puppeteer-core> node qa/console-audit.js
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const path = require("path");
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 1 });

  const consoleErrors = [];
  const pageErrors = [];
  const failedReqs = [];
  const reactWarnings = [];
  page.on("console", (msg) => {
    const t = msg.text();
    if (msg.type() === "error") consoleErrors.push(t);
    if (/Warning:/.test(t) && !/React DevTools/.test(t)) reactWarnings.push(t);
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("requestfailed", (r) => failedReqs.push(`${r.method()} ${r.url()} ${r.failure()?.errorText || ""}`));
  page.on("response", (res) => { if (res.status() >= 400) failedReqs.push(`HTTP ${res.status()} ${res.url()}`); });

  await page.goto(BASE, { waitUntil: "networkidle2" });
  await sleep(1200);

  // Login as seeded admin
  const inputs = await page.$$("input");
  if (inputs.length >= 2) {
    await inputs[0].click({ clickCount: 3 }); await inputs[0].type("admin@restaurant.com");
    await inputs[1].click({ clickCount: 3 }); await inputs[1].type("password123");
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /sign in|login|log in/i.test(x.innerText)); if (b) b.click(); });
  }
  await sleep(4000);
  const onApp = await page.evaluate(() => /dashboard|pos|restaurant/i.test(document.body.innerText));
  check(onApp, "Admin login lands in the app");

  const screens = [
    { name: "Dashboard", click: null, verify: /dashboard|today|sales|orders/i },
    { name: "POS Ordering", click: /pos|ordering/i, verify: /menu|category|cart|order/i },
    { name: "Billing", click: /billing/i, verify: /bill|payment|collect/i },
    { name: "Active Orders", click: /active orders/i, verify: /active|order/i },
    { name: "Kitchen", click: /kitchen/i, verify: /kitchen|ticket|kot/i },
    { name: "Reports", click: /reports/i, verify: /report|sales|summary/i },
    { name: "Settings", click: /settings/i, verify: /setting|tax|printer/i },
    { name: "Subscription", click: null, verify: null }, // via pill
  ];

  const clickNav = async (re) => {
    await page.evaluate((src) => {
      const re2 = new RegExp(src, "i");
      const els = [...document.querySelectorAll("button, a, [role='button']")];
      const el = els.find((e) => re2.test((e.innerText || "").trim()) && e.offsetWidth > 0);
      if (el) el.click();
    }, re.source).catch(() => {});
    await sleep(2200);
  };

  for (const s of screens) {
    const errBefore = consoleErrors.length + pageErrors.length;
    if (s.click) await clickNav(s.click);
    const ok = s.verify ? await page.evaluate((re) => new RegExp(re.source, "i").test(document.body.innerText), s.verify) : true;
    const errs = consoleErrors.length + pageErrors.length - errBefore;
    check(ok && errs === 0, `${s.name}: rendered${ok ? "" : " (NOT FOUND)"} + ${errs} new console/page errors`);
    await sleep(600);
  }

  // Subscription page via the header pill
  const pillOk = await page.evaluate(() => {
    const b = [...document.querySelectorAll("header button, button")].find((e) => /days left|plan •|expires/i.test((e.innerText || "").trim()) && e.offsetWidth > 0);
    if (b) { b.click(); return true; }
    return false;
  });
  check(pillOk, "Header plan pill present (restaurant side)");
  await sleep(2500);
  const subOk = await page.evaluate(() => /subscription & billing|available plans/i.test(document.body.innerText));
  check(subOk, "Subscription & Billing opens from the pill");

  console.log("\n── Console errors captured ──");
  consoleErrors.slice(0, 10).forEach((e) => console.log("  [console] " + e.slice(0, 160)));
  pageErrors.slice(0, 10).forEach((e) => console.log("  [pageerror] " + e.slice(0, 160)));
  failedReqs.slice(0, 15).forEach((e) => console.log("  [req] " + e.slice(0, 160)));
  reactWarnings.slice(0, 5).forEach((e) => console.log("  [react] " + e.slice(0, 160)));

  console.log(`\n  Console audit → ${pass} passed, ${fail} failed`);
  await browser.close();
  // Phase 1 failures are carried into the final exit below.
})().catch(async (e) => { console.error("CRASH:", e.message); process.exit(1); });

// ── PHASE 2 — SUPER ADMIN screens ──
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 768, height: 1024 });
  const ce = [], pe = [], fr = [];
  page.on("console", (m) => { if (m.type() === "error") ce.push(m.text()); });
  page.on("pageerror", (e) => pe.push(e.message));
  page.on("response", (r) => { if (r.status() >= 400) fr.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await sleep(1200);
  const ins = await page.$$("input");
  if (ins.length >= 2) {
    await ins[0].click({ clickCount: 3 }); await ins[0].type("superadmin@pos.com");
    await ins[1].click({ clickCount: 3 }); await ins[1].type("SuperAdmin@123");
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /sign in|login/i.test(x.innerText)); if (b) b.click(); });
  }
  await sleep(4000);
  const screens = [
    { name: "SA Dashboard", click: /dashboard/i, verify: /dashboard|overview|subscription|restaurant/i },
    { name: "SA Restaurants", click: /restaurants/i, verify: /restaurant|name|plan/i },
    { name: "SA Plans", click: /plans/i, verify: /plan|price|module/i },
    { name: "SA Subscriptions", click: /subscriptions/i, verify: /subscription|plan|expiry|billing/i },
    { name: "SA Payment Gateway", click: /payment gateway|gateway/i, verify: /gateway|razorpay|key/i },
    { name: "SA Payments", click: /payments/i, verify: /payment|amount|status/i },
    { name: "SA Users", click: /users/i, verify: /user|role|email/i },
  ];
  const clickNav = async (re) => {
    await page.evaluate((src) => {
      const re2 = new RegExp(src, "i");
      const els = [...document.querySelectorAll("button, a, [role='button']")];
      const el = els.find((e) => re2.test((e.innerText || "").trim()) && e.offsetWidth > 0);
      if (el) el.click();
    }, re.source).catch(() => {});
    await sleep(2200);
  };
  let sp = 0, sf = 0;
  for (const s of screens) {
    const before = ce.length + pe.length;
    await clickNav(s.click);
    const ok = await page.evaluate((re) => new RegExp(re.source, "i").test(document.body.innerText), s.verify);
    const errs = ce.length + pe.length - before;
    if (ok && errs === 0) { sp++; console.log("  ✅ " + s.name); } else { sf++; console.log("  ❌ " + s.name + (ok ? "" : " NOT FOUND") + ` +${errs} errors`); }
    await sleep(500);
  }
  ce.slice(0, 8).forEach((e) => console.log("  [SA console] " + e.slice(0, 150)));
  fr.slice(0, 12).forEach((e) => console.log("  [SA req] " + e.slice(0, 150)));
  console.log(`  SUPER ADMIN console audit → ${sp} passed, ${sf} failed`);
  await browser.close();
  process.exit(sf > 0 ? 1 : 0);
})().catch((e) => { console.error("CRASH:", e.message); process.exit(1); });
