/**
 * POS SETTINGS — FOOTER / SIDEBAR OVERLAP VERIFICATION
 *
 * Verifies in the live Vite app that the sticky Save bar on the POS Settings
 * screen stays inside the main content column (never covers the sidebar's
 * Logout item) at every target viewport, and that Logout actually works.
 *
 * Checks per viewport:
 *   - footer rect is entirely to the RIGHT of the sidebar rect (no overlap)
 *   - footer bottom is within the viewport and its buttons are reachable
 *   - sidebar Logout item is visible (not covered by the footer)
 *   - no horizontal overflow
 * Then: click Logout → login screen appears → login again → Settings loads.
 *
 * Usage: PUPPETEER_CORE_PATH=<dir containing puppeteer-core> node qa/settings-footer-overlap.js
 * Requires backend (:5001) + Vite frontend (:3000) running.
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
const API = "http://localhost:5001/api";
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedReqs = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("response", (r) => { if (r.status() >= 400) failedReqs.push(`HTTP ${r.status()} ${r.url()}`); });

  const login = async (email, password) => {
    await page.goto(BASE, { waitUntil: "networkidle2" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE, { waitUntil: "networkidle2" });
    await sleep(1500);
    const inputs = await page.$$("input");
    if (inputs.length >= 2) {
      await inputs[0].click({ clickCount: 3 }); await inputs[0].type(email);
      await inputs[1].click({ clickCount: 3 }); await inputs[1].type(password);
      await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /sign in|login|log in/i.test(x.innerText)); if (b) b.click(); });
    }
    await sleep(4000);
  };
  const nav = async (title) => {
    await page.evaluate((t) => { const el = [...document.querySelectorAll("button, a")].find((x) => x.title === t); if (el) el.click(); }, title);
    await sleep(2200);
  };
  const bodyText = () => page.evaluate(() => document.body.innerText);

  const VIEWPORTS = [
    { w: 390, h: 844 },
    { w: 768, h: 1024 },
    { w: 1024, h: 768 },
    { w: 1366, h: 768 },
    { w: 1920, h: 1080 },
  ];

  await login("admin@restaurant.com", "password123");
  let t = await bodyText();
  check(/dashboard|orders|kitchen/i.test(t) || /pos/i.test(t), "restaurant portal loads");

  const measure = () => page.evaluate(() => {
    const aside = document.querySelector("aside");
    const footer = [...document.querySelectorAll("div")].find((el) =>
      /Editing:/.test(el.innerText || "") && /Save Settings/i.test(el.innerText || "") && getComputedStyle(el).position === "sticky"
    );
    if (!aside || !footer) return { ok: false, reason: !aside ? "no sidebar" : "no sticky footer", aside: aside ? aside.getBoundingClientRect().toJSON() : null, footer: footer ? footer.getBoundingClientRect().toJSON() : null };
    const a = aside.getBoundingClientRect();
    const f = footer.getBoundingClientRect();
    const overlapX = f.left < a.right && f.right > a.left;
    const overlapY = f.top < a.bottom && f.bottom > a.top;
    const cw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    // Logout: the sidebar's last button (bottom area of the aside)
    const logoutBtn = [...aside.querySelectorAll("button, a")].find((el) => /log\s*out|logout/i.test((el.innerText || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.title || "")));
    const lr = logoutBtn ? logoutBtn.getBoundingClientRect() : null;
    return {
      ok: !(overlapX && overlapY),
      overlapX, overlapY,
      aside: { left: a.left, right: a.right, top: a.top, bottom: a.bottom },
      footer: { left: f.left, right: f.right, top: f.top, bottom: f.bottom },
      footerFullyVisible: f.bottom <= window.innerHeight + 1 && f.left >= 0,
      logout: lr ? { left: lr.left, right: lr.right, top: lr.top, bottom: lr.bottom, covered: !!(overlapX && overlapY) } : null,
      horizontalOverflow: sw > cw + 1,
    };
  });

  // Navigate to POS Settings
  await nav("POS Settings");
  t = await bodyText();
  check(/POS Settings/i.test(t), "POS Settings screen renders");

  // Scroll the settings content a bit to make sure the footer sticks mid-scroll
  await page.evaluate(() => { const main = document.querySelector("main"); if (main) main.scrollTop = main.scrollHeight * 0.4; });
  await sleep(500);

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    await sleep(800);
    const m = await measure();
    const label = `${vp.w}x${vp.h}`;
    if (!m.ok) {
      check(false, `${label} — ${m.reason}`);
      continue;
    }
    check(!m.overlapX || !m.overlapY, `${label} — footer does not overlap sidebar (footer x:[${Math.round(m.footer.left)},${Math.round(m.footer.right)}] vs sidebar x:[${Math.round(m.aside.left)},${Math.round(m.aside.right)}])`);
    check(m.footer.left >= m.aside.right - 1, `${label} — footer starts after sidebar width (footer.left=${Math.round(m.footer.left)}, sidebar.right=${Math.round(m.aside.right)})`);
    check(m.footerFullyVisible, `${label} — footer buttons visible in viewport (bottom=${Math.round(m.footer.bottom)} <= ${vp.h})`);
    check(!!m.logout && m.logout.left >= m.aside.left && m.logout.right <= m.aside.right + 1, `${label} — sidebar Logout item present in sidebar bounds`);
    check(!m.horizontalOverflow, `${label} — no horizontal overflow`);
    check(m.footer.left > 0 || vp.w <= m.aside.right, `${label} — footer confined to content column`);
  }

  // ── Logout click verification (desktop) ──
  await page.setViewport({ width: 1366, height: 768 });
  await page.evaluate(() => { const main = document.querySelector("main"); if (main) main.scrollTop = 0; });
  await sleep(400);
  const clickedLogout = await page.evaluate(() => {
    const aside = document.querySelector("aside");
    const el = aside && [...aside.querySelectorAll("button, a")].find((x) => /log\s*out|logout/i.test((x.innerText || "") + " " + (x.getAttribute("aria-label") || "") + " " + (x.title || "")));
    if (el) { el.click(); return true; }
    return false;
  });
  check(clickedLogout, "Logout button found and clicked in the sidebar");
  await sleep(2500);
  t = await bodyText();
  check(/sign in|login|log in/i.test(t) || /email/i.test(t), "Logout navigated to the login screen");

  // ── Re-login and reopen Settings ──
  await login("admin@restaurant.com", "password123");
  await nav("POS Settings");
  t = await bodyText();
  check(/POS Settings/i.test(t), "POS Settings reopens after re-login");
  const m = await measure();
  check(m.ok && m.footer && m.footer.left >= m.aside.right - 1, "footer correctly positioned after re-login");

  // ── Save / Reset still functional (no layout-only breakage) ──
  const hasSave = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^Save Settings$/i.test(x.innerText.trim()));
    return !!b;
  });
  const hasReset = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^Reset$/i.test(x.innerText.trim()));
    return !!b;
  });
  check(hasSave, "Save Settings button present in footer");
  check(hasReset, "Reset button present in footer");

  // ── Console / network ──
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(e));
  check(realErrors.length === 0, `zero console/page errors (${realErrors.length})`);
  const realFailed = failedReqs.filter((u) => !/favicon/.test(u));
  check(realFailed.length === 0, `zero failed API requests (${realFailed.length})`);

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
