/**
 * RESTAURANT MODE — PLAN-DRIVEN BUSINESS MODE (PERMANENT QA)
 *
 * Verifies in the live Vite app that the redesigned POS Screen Settings page
 * treats Business Mode as plan-driven (read-only banner, NO switcher cards)
 * and that module toggles stay scoped to the effective business mode.
 *
 *  1. Restaurant mode: "Enable POS Ordering Screen" toggle present (generic
 *     screen toggle); counter-only "Enable Basic POS Quick Billing" is
 *     completely absent from the DOM; real restaurant toggles (Kitchen, Floor
 *     Management, Active Orders, …) are present; plan-driven banner shown.
 *  2. No in-app mode switching: no Basic-POS/Hybrid switcher cards anywhere.
 *  3. Search respects mode: "POS Ordering" surfaces the section (toggle is
 *     visible in restaurant mode); "Quick Billing" returns nothing.
 *  4. Persistence: businessMode stays derived from the plan even when a
 *     client POSTs a different value (backend-authoritative).
 *  5. Responsive: no horizontal overflow in Restaurant mode at all viewports.
 *  6. No console errors / failed API requests.
 *
 * Usage: PUPPETEER_CORE_PATH=<dir> node qa/restaurant-mode-pos-qa.js
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

  // Count DOM elements whose text contains a label (0 = completely absent)
  const countText = (needle) => page.evaluate((n) => {
    return [...document.querySelectorAll("button, label, p, h4, span, h5")].filter((el) =>
      (el.innerText || "").toLowerCase().includes(n.toLowerCase())
    ).length;
  }, needle);

  // Count matches ONLY inside the Module Visibility card (excludes the
  // business-mode cards, which legitimately describe Basic POS as "Quick billing").
  const countTextInModuleVisibility = (needle) => page.evaluate((n) => {
    const cards = [...document.querySelectorAll("h4")].filter((h) => /Module Visibility/i.test(h.innerText));
    const scope = cards.length ? cards[0].closest("div").parentElement : document.body;
    return [...scope.querySelectorAll("button, label, p, h4, span, h5")].filter((el) =>
      (el.innerText || "").toLowerCase().includes(n.toLowerCase())
    ).length;
  }, needle);

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

  const adminToken = await apiLogin("admin@restaurant.com", "password123");
  check(!!adminToken, "restaurant ADMIN login works");

  await login("admin@restaurant.com", "password123");
  await nav("POS Settings");
  await tabClick("POS Screen Settings");

  // ══ 1. RESTAURANT MODE — plan-driven banner + mode-scoped toggles ══
  let n = await countText("Enable POS Ordering Screen");
  check(n > 0, `Restaurant mode: "Enable POS Ordering Screen" toggle present (found ${n})`);
  n = await countText("Enable Basic POS Quick Billing");
  check(n === 0, `Restaurant mode: "Enable Basic POS Quick Billing" absent from DOM (found ${n})`);
  n = await countTextInModuleVisibility("Quick Billing");
  check(n === 0, `Restaurant mode: no "Quick Billing" control inside Module Visibility (found ${n})`);
  n = await countText("Business mode is managed by your subscription plan");
  check(n > 0, `Restaurant mode: plan-driven Business Mode banner shown (found ${n})`);

  // Real restaurant toggles still present
  n = await countText("Enable Kitchen (KOT)");
  check(n > 0, `Restaurant mode: Kitchen (KOT) toggle present (found ${n})`);
  n = await countText("Enable Floor Management");
  check(n > 0, `Restaurant mode: Floor Management toggle present (found ${n})`);
  n = await countText("Enable Active Orders");
  check(n > 0, `Restaurant mode: Active Orders toggle present (found ${n})`);
  n = await countText("Enable Reports");
  check(n > 0, `Restaurant mode: Reports toggle present (found ${n})`);
  n = await countText("Enable Billing Module");
  check(n > 0, `Restaurant mode: Billing toggle present (found ${n})`);

  // ══ 2. NO IN-APP MODE SWITCHING (plan-driven) ══
  // The old mode-switcher cards (click-to-switch with description text) must
  // not exist anywhere — business mode comes from the subscription plan.
  n = await countText("Quick billing, no tables/KOT/active orders");
  check(n === 0, `No Basic-POS switcher card in DOM (found ${n})`);
  n = await countText("Both dine-in and counter sales");
  check(n === 0, `No Hybrid switcher card in DOM (found ${n})`);
  n = await countText("Full dine-in with tables, KOT, Active Orders");
  check(n === 0, `No Restaurant switcher card in DOM (found ${n})`);

  // ══ 3. SEARCH RESPECTS MODE ══
  // 'Enable POS Ordering Screen' is a visible restaurant-mode toggle, so its
  // section surfaces; counter-only 'Quick Billing' must never surface.
  await setSearch("POS Ordering");
  let searchSections = await page.evaluate(() => {
    return [...document.querySelectorAll("button")].filter((x) => /POS Screen Settings|POS Config/i.test(x.innerText)).length;
  });
  check(searchSections > 0, "Search 'POS Ordering' in Restaurant mode → POS Screen Settings surfaces (found " + searchSections + ")");

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

  // ══ 4. PERSISTENCE — businessMode is plan-authoritative ══
  // Even if a client POSTs a different businessMode, the backend derives the
  // effective mode from the subscription plan and ignores the input.
  if (adminToken) {
    const r = await fetch(`${API}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ restaurantName: "The Golden Grill", businessMode: "counter" }),
    });
    check(r.status === 200 || r.status === 201, "POST /settings with businessMode=counter accepted (field ignored)");
  }
  let db = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${adminToken}` } }).then(r => r.json());
  check(db.setting.businessMode === "restaurant", `businessMode still derived from plan (got "${db.setting.businessMode}")`);

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2500);
  // After a hard refresh the app lands on the Dashboard — navigate back in.
  await nav("POS Settings");
  await tabClick("POS Screen Settings");
  n = await countText("Enable POS Ordering Screen");
  check(n > 0, "After refresh: Restaurant mode still shows POS Ordering toggle (found " + n + ")");
  n = await countText("Enable Basic POS Quick Billing");
  check(n === 0, "After refresh: Restaurant mode still hides Quick Billing (found " + n + ")");
  n = await countText("Enable Kitchen (KOT)");
  check(n > 0, "After refresh: Restaurant mode still shows Kitchen (found " + n + ")");

  // ══ 5. RESPONSIVE — Restaurant mode at all viewports ══
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

  // ══ 6. CONSOLE / NETWORK ══
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(e));
  check(realErrors.length === 0, `zero console/page errors (${realErrors.length})`);
  const realFailed = failedReqs.filter((u) => !/favicon/.test(u));
  check(realFailed.length === 0, `zero failed API requests (${realFailed.length})`);

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
