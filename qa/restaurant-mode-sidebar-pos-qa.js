/**
 * RESTAURANT MODE — POS ORDERING REMOVED FROM ENTIRE UI (PERMANENT QA)
 *
 * Verifies in the live Vite app that when Business Mode = Restaurant the POS
 * Ordering feature disappears from the WHOLE restaurant UI — not just the
 * settings page:
 *
 *  1. Sidebar: no "POS Ordering" nav item (title + label absent from DOM).
 *  2. Route/screen: no element anywhere renders "POS Ordering" content and
 *     there is no navigation control that can reach the order_taking screen
 *     (state-based SPA: sidebar/header/dashboard are the only navigators).
 *  3. POS Settings: "Enable POS Ordering Screen" / "Enable Basic POS Quick
 *     Billing" absent; search for "POS Ordering" / "Quick Billing" returns
 *     no settings section.
 *  4. Restaurant toggles (Kitchen, Floor Management, Active Orders, …) remain.
 *  5. Live mode switching: Restaurant → Hybrid → Basic POS → Restaurant —
 *     POS Ordering appears when allowed, disappears again in Restaurant mode.
 *  6. Persistence: save + refresh + logout/login keep businessMode=restaurant
 *     and POS Ordering stays hidden.
 *  7. Plan gating still applies: with businessMode=hybrid but subscription
 *     features WITHOUT 'pos', POS Ordering is still hidden (plan blocks it).
 *  8. Responsive: no horizontal overflow in Restaurant mode at all viewports.
 *  9. No console errors / failed API requests.
 *
 * The DB is restored to its pre-test state (businessMode=restaurant for the
 * main test restaurant, original subscription features restored).
 *
 * Usage: PUPPETEER_CORE_PATH=<dir> node qa/restaurant-mode-sidebar-pos-qa.js
 * Requires backend (:5001) + Vite frontend (:3000) running.
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
const API = "http://localhost:5001/api";

let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiLogin(email, password) {
  const r = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  return (j.token || (j.data && j.data.token)) || null;
}

async function setDbSetting(token, patch) {
  const body = { restaurantName: "The Golden Grill", ...patch };
  const r = await fetch(`${API}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return r.status;
}

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
  const tabClick = async (label) => {
    await page.evaluate((l) => { const el = [...document.querySelectorAll("button")].find((x) => x.innerText.trim().toLowerCase().startsWith(l.toLowerCase())); if (el) el.click(); }, label);
    await sleep(1200);
  };

  // Count DOM elements (sidebar buttons, labels, etc.) whose text contains a label
  const countText = (needle) => page.evaluate((n) => {
    return [...document.querySelectorAll("button, a, label, p, h4, span, h5")].filter((el) =>
      (el.innerText || "").toLowerCase().includes(n.toLowerCase())
    ).length;
  }, needle);

  // Sidebar: does a nav button with the exact title exist?
  const sidebarHasTitle = (title) => page.evaluate((t) => {
    return !!document.querySelector(`aside button[title="${t}"]`);
  }, title);

  const setSearch = async (q) => {
    await page.evaluate((query) => {
      const inp = document.querySelector("input[placeholder='Search settings...']");
      if (inp) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, query);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, q);
    await sleep(800);
  };

  const clickMode = async (desc) => {
    await page.evaluate((d) => {
      const el = [...document.querySelectorAll("button")].find((x) => x.innerText.includes(d));
      if (el) el.click();
    }, desc);
    await sleep(1200);
  };

  // ── Setup: restore DB to a known baseline first ──
  const adminToken = await apiLogin("admin@restaurant.com", "password123");
  check(!!adminToken, "restaurant ADMIN login works");

  // Grab the original subscription features so we can restore them at the end.
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  const adminUser = await prisma.user.findUnique({ where: { email: "admin@restaurant.com" }, select: { restaurantId: true } });
  const sub = await prisma.subscription.findUnique({ where: { restaurantId: adminUser.restaurantId }, select: { features: true } });
  const originalFeatures = sub.features;
  const originalHasPos = Array.isArray(originalFeatures) && originalFeatures.includes("pos");

  // Ensure DB businessMode is restaurant before the browser test
  if (adminToken) {
    const st = await setDbSetting(adminToken, { businessMode: "restaurant" });
    check(st === 200 || st === 201, "DB businessMode set to restaurant");
  }

  await login("admin@restaurant.com", "password123");

  // ══ 1. RESTAURANT MODE — SIDEBAR HAS NO POS ORDERING ══
  let hasPos = await sidebarHasTitle("POS Ordering");
  check(!hasPos, "Restaurant mode: sidebar has no 'POS Ordering' nav item");
  let n = await countText("POS Ordering");
  check(n === 0, `Restaurant mode: 'POS Ordering' text absent from entire DOM (found ${n})`);
  n = await countText("Quick Billing");
  check(n === 0, `Restaurant mode: 'Quick Billing' absent from entire DOM (found ${n})`);

  // Real restaurant nav items still present
  hasPos = await sidebarHasTitle("Kitchen Tickets");
  check(hasPos, "Restaurant mode: Kitchen Tickets still in sidebar");
  hasPos = await sidebarHasTitle("Floors & Tables");
  check(hasPos, "Restaurant mode: Floors & Tables still in sidebar");
  hasPos = await sidebarHasTitle("Active Orders");
  check(hasPos, "Restaurant mode: Active Orders still in sidebar");
  hasPos = await sidebarHasTitle("Menu & Stock");
  check(hasPos, "Restaurant mode: Menu & Stock still in sidebar");
  hasPos = await sidebarHasTitle("Reports & Sales");
  check(hasPos, "Restaurant mode: Reports & Sales still in sidebar");

  // ══ 2. RESTAURANT MODE — SETTINGS PAGE HAS NO POS ORDERING CONTROLS ══
  await nav("POS Settings");
  await tabClick("POS Screen Settings");
  n = await countText("Enable POS Ordering Screen");
  check(n === 0, `Restaurant mode: settings has no 'Enable POS Ordering Screen' (found ${n})`);
  n = await countText("Enable Basic POS Quick Billing");
  check(n === 0, `Restaurant mode: settings has no 'Enable Basic POS Quick Billing' (found ${n})`);
  n = await countText("Enable Kitchen (KOT)");
  check(n > 0, `Restaurant mode: Kitchen (KOT) toggle present (found ${n})`);
  n = await countText("Enable Floor Management");
  check(n > 0, `Restaurant mode: Floor Management toggle present (found ${n})`);

  // ══ 3. SEARCH RESPECTS MODE ══
  await setSearch("POS Ordering");
  let searchSections = await page.evaluate(() => {
    return [...document.querySelectorAll("button")].filter((x) => /POS Screen Settings|POS Config/i.test(x.innerText)).length;
  });
  check(searchSections === 0, "Search 'POS Ordering' in Restaurant mode → no matching section (found " + searchSections + ")");

  await setSearch("Quick Billing");
  searchSections = await page.evaluate(() => {
    return [...document.querySelectorAll("button")].filter((x) => /POS Screen Settings|POS Config/i.test(x.innerText)).length;
  });
  check(searchSections === 0, "Search 'Quick Billing' in Restaurant mode → no matching section (found " + searchSections + ")");

  await setSearch("Kitchen");
  searchSections = await page.evaluate(() => {
    return [...document.querySelectorAll("button")].filter((x) => /POS Screen Settings/i.test(x.innerText)).length;
  });
  check(searchSections > 0, "Search 'Kitchen' in Restaurant mode → POS Screen Settings surfaces (found " + searchSections + ")");
  await setSearch("");

  // ══ 4. LIVE MODE SWITCHING — Restaurant → Hybrid → Basic POS → Restaurant ══
  // Hybrid: POS Ordering + restaurant controls both appear
  await clickMode("Both dine-in and counter sales");
  n = await countText("Enable POS Ordering Screen");
  check(n > 0, "Hybrid mode: 'Enable POS Ordering Screen' appears (found " + n + ")");
  n = await countText("Enable Kitchen (KOT)");
  check(n > 0, "Hybrid mode: Kitchen (KOT) still appears (found " + n + ")");

  // Basic POS: POS Ordering + Quick Billing appear; floor management hidden
  await clickMode("Quick billing, no tables/KOT/active orders");
  n = await countText("Enable POS Ordering Screen");
  check(n > 0, "Basic POS mode: 'Enable POS Ordering Screen' appears (found " + n + ")");
  n = await countText("Enable Basic POS Quick Billing");
  check(n > 0, "Basic POS mode: 'Enable Basic POS Quick Billing' appears (found " + n + ")");
  n = await countText("Enable Floor Management");
  check(n === 0, "Basic POS mode: floor management hidden (found " + n + ")");

  // Back to Restaurant: POS Ordering disappears again, no stale rows
  await clickMode("Full dine-in with tables, KOT, Active Orders");
  n = await countText("Enable POS Ordering Screen");
  check(n === 0, "Restaurant mode (back): 'Enable POS Ordering Screen' absent again (found " + n + ")");
  n = await countText("Enable Basic POS Quick Billing");
  check(n === 0, "Restaurant mode (back): 'Enable Basic POS Quick Billing' absent again (found " + n + ")");

  // ══ 5. PERSISTENCE — save restaurant mode, refresh, verify ══
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Save Settings$/i.test(x.innerText.trim())); if (b) b.click(); });
  await sleep(2500);
  let db = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${adminToken}` } }).then(r => r.json());
  check(db.setting.businessMode === "restaurant", `saved businessMode = restaurant in DB (got "${db.setting.businessMode}")`);

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2500);
  // After a hard refresh the app lands on the Dashboard — navigate back in.
  await nav("POS Settings");
  await tabClick("POS Screen Settings");
  n = await countText("Enable POS Ordering Screen");
  check(n === 0, "After refresh: Restaurant mode still hides POS Ordering settings (found " + n + ")");

  // Sidebar still hides POS Ordering after refresh
  await nav("Dashboard Overview");
  hasPos = await sidebarHasTitle("POS Ordering");
  check(!hasPos, "After refresh: sidebar still has no POS Ordering item");

  // ══ 6. RELOGIN PERSISTENCE ══
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /log out|logout|sign out/i.test(x.innerText));
    if (b) b.click();
  });
  await sleep(2500);
  await login("admin@restaurant.com", "password123");
  hasPos = await sidebarHasTitle("POS Ordering");
  check(!hasPos, "After logout/login: sidebar still has no POS Ordering item");
  n = await countText("POS Ordering");
  check(n === 0, `After logout/login: 'POS Ordering' text absent from DOM (found ${n})`);

  // ══ 7. PLAN GATING — hybrid mode + plan WITHOUT 'pos' still hides POS Ordering ══
  // Switch DB to hybrid with the full hybrid preset (what the UI applies on
  // save: businessMode + enablePosOrdering: true) but strip 'pos' from the
  // subscription features — the plan gate must still hide POS Ordering.
  await setDbSetting(adminToken, { businessMode: "hybrid", enablePosOrdering: true });
  await prisma.subscription.update({
    where: { restaurantId: adminUser.restaurantId },
    data: { features: (originalFeatures || []).filter((f) => f !== "pos") },
  });
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2500);
  hasPos = await sidebarHasTitle("POS Ordering");
  check(!hasPos, "Plan WITHOUT pos + Hybrid: sidebar hides POS Ordering (plan gate)");

  // Restore 'pos' in features → hybrid (with preset applied) shows it again
  await prisma.subscription.update({
    where: { restaurantId: adminUser.restaurantId },
    data: { features: originalFeatures },
  });
  await setDbSetting(adminToken, { businessMode: "hybrid", enablePosOrdering: true });
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2500);
  hasPos = await sidebarHasTitle("POS Ordering");
  check(hasPos, "Plan WITH pos + Hybrid: sidebar shows POS Ordering again");

  // ══ 8. RESTORE DB — back to restaurant mode (full restaurant preset),
  // original features ══
  await setDbSetting(adminToken, { businessMode: "restaurant", enablePosOrdering: false, enableCounterSale: false });
  if (!originalHasPos) {
    await prisma.subscription.update({
      where: { restaurantId: adminUser.restaurantId },
      data: { features: originalFeatures },
    });
  }
  db = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${adminToken}` } }).then(r => r.json());
  check(db.setting.businessMode === "restaurant", "DB restored: businessMode = restaurant");

  // ══ 9. RESPONSIVE — Restaurant mode at all viewports ══
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2500);
  for (const vp of [{ w: 390, h: 844 }, { w: 768, h: 1024 }, { w: 1024, h: 768 }, { w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    await sleep(700);
    const m = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      const footer = [...document.querySelectorAll("div")].find((el) =>
        /Editing:/.test(el.innerText || "") && /Save Settings/i.test(el.innerText || "") && getComputedStyle(el).position === "sticky"
      );
      const a = aside ? aside.getBoundingClientRect() : null;
      const f = footer ? footer.getBoundingClientRect() : null;
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        footerOverlapSidebar: !!(a && f && f.left < a.right && f.right > a.left && f.top < a.bottom && f.bottom > a.top),
        cw: document.documentElement.clientWidth,
        sw: document.documentElement.scrollWidth,
      };
    });
    check(!m.overflow, `${vp.w}x${vp.h} — no horizontal overflow (sw=${m.sw}, cw=${m.cw})`);
    check(!m.footerOverlapSidebar, `${vp.w}x${vp.h} — sticky footer does not overlap sidebar`);
  }

  // ══ 10. CONSOLE / NETWORK ══
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(e));
  check(realErrors.length === 0, `zero console/page errors (${realErrors.length})`);
  const realFailed = failedReqs.filter((u) => !/favicon/.test(u));
  check(realFailed.length === 0, `zero failed API requests (${realFailed.length})`);

  await prisma.$disconnect();
  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
