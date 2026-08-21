/**
 * SUPER ADMIN — SUPPORT TICKETS REMOVAL VERIFICATION
 *
 * 1. Login as Super Admin
 * 2. Verify "Support Tickets" is NOT in the sidebar
 * 3. Open every remaining sidebar module and verify it renders
 * 4. Verify zero console/page errors and zero failed API requests
 * 5. Hard refresh → Support Tickets does not reappear
 *
 * Usage: PUPPETEER_CORE_PATH=<dir with puppeteer-core> node qa/sa-no-tickets-browser.js
 * Requires backend (:5001) + Vite frontend (:3000) running.
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The 12 modules that must remain in the SA sidebar (button title = label)
const REMAINING = [
  "Dashboard", "Restaurants", "Subscriptions", "Users", "Plans",
  "Invoices", "Platform Reports", "Notifications", "System Settings",
  "Payment Gateway", "Audit Logs", "Profile",
];

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 1 }); // tablet portrait — primary target

  const errors = [];
  const failedReqs = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { if (r.status() >= 400) failedReqs.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on("requestfailed", (r) => failedReqs.push(`${r.url()} ${r.failure()?.errorText || ""}`));

  // ── Login as Super Admin ──
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
  const onPortal = await page.evaluate(() => /restaurants|subscription/i.test(document.body.innerText));
  check(onPortal, "SA login lands in the portal");

  // ── 1. Sidebar must NOT contain Support Tickets ──
  const sidebarTitles = await page.evaluate(() =>
    [...document.querySelectorAll("aside button")].map((b) => b.title || b.innerText.trim()).filter(Boolean)
  );
  check(sidebarTitles.includes("Support Tickets") === false, "Sidebar has no Support Tickets item");
  check(sidebarTitles.includes("Tickets") === false, "Sidebar has no Tickets item");

  // ── 2. Every remaining module opens and renders ──
  for (const title of REMAINING) {
    const clicked = await page.evaluate((t) => {
      const el = [...document.querySelectorAll("aside button, button")].find((x) => x.title === t);
      if (!el) return false;
      el.click();
      return true;
    }, title);
    await sleep(1800);
    const text = await page.evaluate(() => document.body.innerText);
    check(clicked && text.length > 50 && !/access denied/i.test(text), `${title} opens and renders`);
  }

  // ── 3. Console / network audit ──
  const realErrors = errors.filter((e) => !/favicon|net::ERR_ABORTED|download the react devtools/i.test(e));
  check(realErrors.length === 0, `zero console/page errors (${realErrors.length})`);
  const realFailed = failedReqs.filter((u) => !/favicon/.test(u));
  check(realFailed.length === 0, `zero failed API requests (${realFailed.length})`);

  // ── 4. Hard refresh → Support Tickets does not reappear ──
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(3000);
  const afterRefresh = await page.evaluate(() =>
    [...document.querySelectorAll("aside button")].map((b) => b.title || b.innerText.trim()).filter(Boolean)
  );
  check(afterRefresh.includes("Support Tickets") === false, "After refresh, Support Tickets does not reappear");
  check(afterRefresh.includes("Tickets") === false, "After refresh, no Tickets item reappears");

  // ── 5. No horizontal overflow on the SA shell ──
  const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(dims.sw <= dims.cw + 1, `no horizontal overflow at 768x1024 (${dims.sw} <= ${dims.cw})`);

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
