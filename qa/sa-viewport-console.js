/**
 * SUPER ADMIN — CONSOLE + VIEWPORT SWEEP
 *
 * Loads every Super Admin screen in the live app at 5 viewports (390x844,
 * 768x1024, 1024x768, 1366x768, 1920x1080) and checks:
 *   - zero console/page errors, zero failed API requests
 *   - no horizontal overflow (document.scrollWidth <= clientWidth)
 *   - key dialogs open and fit the viewport
 *
 * Usage: PUPPETEER_CORE_PATH=<dir with puppeteer-core> node qa/sa-viewport-console.js
 * Requires backend (:5001) + Vite frontend (:3000) running.
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCREENS = [
  { title: "Dashboard", verify: /restaurants|subscription/i },
  { title: "Restaurants", verify: /restaurants/i },
  { title: "Subscriptions", verify: /subscription/i },
  { title: "Users", verify: /user/i },
  { title: "Plans", verify: /create plan|subscription plans/i },
  { title: "Invoices", verify: /invoice|payment/i },
  { title: "Platform Reports", verify: /report|revenue|growth/i },
  { title: "Notifications", verify: /notification/i },
  { title: "System Settings", verify: /setting|platform/i },
  { title: "Payment Gateway", verify: /gateway|razorpay|online payments/i },
  { title: "Audit Logs", verify: /audit|log/i },
  { title: "Profile", verify: /edit profile|account/i },
];

const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 1024, h: 768 },
  { w: 1366, h: 768 },
  { w: 1920, h: 1080 },
];

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();

  // ── Login once at desktop width ──
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await sleep(1500);
  const inputs = await page.$$("input");
  if (inputs.length >= 2) {
    await inputs[0].type("superadmin@pos.com");
    await inputs[1].type("SuperAdmin@123");
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /sign in|login|log in/i.test(x.innerText)); if (b) b.click(); });
  }
  await sleep(4000);
  const onApp = await page.evaluate(() => /restaurants|subscription/i.test(document.body.innerText));
  check(onApp, "SA login lands in the portal");

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    const errors = [];
    const failedReqs = [];
    const overflowSeen = { screens: [] };
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => { if (r.status() >= 400) failedReqs.push(`HTTP ${r.status()} ${r.url()}`); });
    page.on("requestfailed", (r) => failedReqs.push(`${r.url()} ${r.failure()?.errorText || ""}`));

    for (const s of SCREENS) {
      await page.evaluate((t) => { const el = [...document.querySelectorAll("button, a")].find((x) => x.title === t); if (el) el.click(); }, s.title);
      await sleep(1800);
      const text = await page.evaluate(() => document.body.innerText);
      check(new RegExp(s.verify).test(text), `${vp.w}x${vp.h} — ${s.title} renders`);
      const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      if (dims.sw > dims.cw + 1) overflowSeen.screens.push(`${s.title}(${dims.sw}>${dims.cw})`);
    }

    check(overflowSeen.screens.length === 0, `${vp.w}x${vp.h} — no horizontal overflow on any SA screen${overflowSeen.screens.length ? ": " + overflowSeen.screens.join(", ") : ""}`);
    const realErrors = errors.filter((e) => !/favicon|net::ERR_ABORTED/i.test(e));
    check(realErrors.length === 0, `${vp.w}x${vp.h} — zero console/page errors (${realErrors.length})`);
    const realFailed = failedReqs.filter((u) => !/favicon/.test(u));
    check(realFailed.length === 0, `${vp.w}x${vp.h} — zero failed API requests (${realFailed.length})`);
  }

  // ── Dialog fit check at tablet portrait ──
  await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 1 });
  await page.evaluate((t) => { const el = [...document.querySelectorAll("button, a")].find((x) => x.title === "Plans"); if (el) el.click(); });
  await sleep(2000);
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /create plan/i.test(x.innerText)); if (b) b.click(); });
  await sleep(1200);
  const dialogFit = await page.evaluate(() => {
    const m = document.querySelector(".fixed.inset-0.z-50");
    if (!m) return { ok: false, reason: "no modal" };
    const r = m.getBoundingClientRect();
    return { ok: r.width <= 768 && r.height <= 1024 && r.left >= 0 && r.top >= 0, w: Math.round(r.width), h: Math.round(r.height), reason: "fit" };
  });
  check(dialogFit.ok, `Create Plan dialog fits 768x1024 (${dialogFit.w}x${dialogFit.h})`);
  await page.evaluate(() => { const b = [...document.querySelectorAll(".fixed.inset-0 button")].find((x) => /^cancel$/i.test(x.innerText.trim())); if (b) b.click(); });
  await sleep(800);

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
