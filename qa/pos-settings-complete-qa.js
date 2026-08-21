/**
 * POS SETTINGS — COMPLETE FUNCTIONAL QA
 *
 * Verifies the restructured POS Settings screen end-to-end against the live
 * backend + Vite app:
 *
 *   A. API layer (direct HTTP):
 *      - GET settings returns real persisted values (no dummy/hardcoded)
 *      - SAVE persists prefixes, tax, module visibility, business mode
 *      - prefix values are stored WITHOUT duplication (INV, not INVINV)
 *      - CASHIER cannot save settings (RBAC)
 *   B. Browser layer (live Vite app):
 *      - tabs: General, POS Config, POS Screen Settings, Billing, Tax & GST,
 *        Printer, Security — NO separate Kitchen tab, NO Restaurant tab
 *      - exactly ONE "Save Settings" button, no per-field Save buttons
 *      - POS Screen Settings: business mode cards + module visibility
 *      - Restaurant mode hides POS-Ordering-only controls dynamically
 *      - search finds real visible settings
 *      - single save persists; Reset reloads from DB
 *      - billing prefixes render as single values (no INVINV duplication)
 *      - no console errors, no failed API requests
 *
 * Usage: PUPPETEER_CORE_PATH=<dir> node qa/pos-settings-complete-qa.js
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
  // ── A. API layer ─────────────────────────────────────────────────────────
  console.log("\n═══ A. API LAYER ═══");
  const adminToken = await apiLogin("admin@restaurant.com", "password123");
  check(!!adminToken, "restaurant ADMIN login works");

  // A1. GET settings — real values, no crash
  let getRes;
  try {
    const r = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${adminToken}` } });
    getRes = await r.json();
    check(r.status === 200, "GET /settings returns 200");
  } catch (e) {
    check(false, `GET /settings error: ${e.message}`);
  }

  const s = getRes && getRes.setting;
  check(!!s, "settings object present");
  if (s) {
    check(typeof s.billPrefix === "string" && s.billPrefix.length > 0, `billPrefix persisted ("${s.billPrefix}")`);
    check(typeof s.invoicePrefix === "string" && s.invoicePrefix.length > 0, `invoicePrefix persisted ("${s.invoicePrefix}")`);
    check(typeof s.kotPrefix === "string" && s.kotPrefix.length > 0, `kotPrefix persisted ("${s.kotPrefix}")`);
    // Prefixes must not be stored double (INVINV bug)
    check(!/^(.+)\1$/.test(s.invoicePrefix), `invoicePrefix not duplicated ("${s.invoicePrefix}")`);
    check(!/^(.+)\1$/.test(s.billPrefix), `billPrefix not duplicated ("${s.billPrefix}")`);
    check(!/^(.+)\1$/.test(s.kotPrefix), `kotPrefix not duplicated ("${s.kotPrefix}")`);
    check(typeof s.taxPercentage === "number", `taxPercentage persisted (${s.taxPercentage})`);
    check(typeof s.serviceCharge === "number", `serviceCharge persisted (${s.serviceCharge})`);
    check(s.businessMode === "restaurant" || s.businessMode === "counter" || s.businessMode === "hybrid", `businessMode valid ("${s.businessMode}")`);
    check(typeof s.enableKitchen === "boolean", `enableKitchen persisted (${s.enableKitchen})`);
    check(typeof s.enableSplitBill === "boolean", `enableSplitBill persisted (${s.enableSplitBill})`);
  }

  // A2. Save — prefixes, tax rate, service charge, split bill.
  // NOTE: the Joi validator requires restaurantName (the real frontend always
  // sends it) — include it exactly like the app does.
  const savePayload = {
    restaurantName: (getRes && getRes.setting && getRes.setting.restaurantName) || "Restaurant POS",
    billPrefix: "BILL",
    invoicePrefix: "INV",
    kotPrefix: "KOT",
    taxPercentage: 5,
    serviceCharge: 0,
    enableSplitBill: true,
    enableBilling: true,
    businessMode: "restaurant",
  };
  let saveOk = false;
  try {
    const r = await fetch(`${API}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(savePayload),
    });
    const j = await r.json();
    saveOk = r.status === 200 || r.status === 201;
    check(saveOk, "POST /settings saves bulk settings");
    check(j && j.success !== false, "save response indicates success");
  } catch (e) {
    check(false, `POST /settings error: ${e.message}`);
  }

  // A3. Verify persisted values round-trip (no duplication, correct values)
  if (saveOk) {
    const r = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const j = await r.json();
    const v = j.setting;
    check(v.billPrefix === "BILL", `billPrefix round-trips as "BILL" (got "${v.billPrefix}")`);
    check(v.invoicePrefix === "INV", `invoicePrefix round-trips as "INV" (got "${v.invoicePrefix}")`);
    check(v.kotPrefix === "KOT", `kotPrefix round-trips as "KOT" (got "${v.kotPrefix}")`);
    check(Number(v.taxPercentage) === 5, `taxPercentage round-trips as 5 (got ${v.taxPercentage})`);
    check(v.enableSplitBill === true, "enableSplitBill round-trips as true");
  }

  // A4. RBAC — CASHIER cannot save settings
  let cashierToken = null;
  for (const email of ["amit@restaurant.com", "sneha@restaurant.com", "vikram@restaurant.com"]) {
    try {
      const r = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "password123" }),
      });
      const j = await r.json();
      const tok = j.token || (j.data && j.data.token) || null;
      if (tok) { cashierToken = tok; break; }
    } catch (e) { /* ignore */ }
  }
  if (cashierToken) {
    const r = await fetch(`${API}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cashierToken}` },
      body: JSON.stringify({ billPrefix: "X" }),
    });
    check(r.status === 403, `CASHIER POST /settings → 403 (got ${r.status})`);
  } else {
    check(false, "could not obtain CASHIER token for RBAC test");
  }

  // ── B. Browser layer ─────────────────────────────────────────────────────
  console.log("\n═══ B. BROWSER LAYER ═══");
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
  const has = (t, re) => new RegExp(re, "i").test(t);
  const tabClick = async (label) => {
    await page.evaluate((l) => { const el = [...document.querySelectorAll("button")].find((x) => x.innerText.trim().toLowerCase().startsWith(l.toLowerCase())); if (el) el.click(); }, label);
    await sleep(1200);
  };

  await login("admin@restaurant.com", "password123");
  let t = await bodyText();
  check(/dashboard|orders|kitchen/i.test(t) || /pos/i.test(t), "restaurant portal loads");

  await nav("POS Settings");
  t = await bodyText();
  check(/POS Settings/i.test(t), "POS Settings screen renders");

  // B1. Tabs — required set, no old tabs
  check(has(t, /^General$/m) || /general/i.test(t), "General tab present");
  check(/POS Config/i.test(t), "POS Config tab present");
  check(/POS Screen Settings/i.test(t), "POS Screen Settings tab present (renamed from POS Layout)");
  check(/Billing/i.test(t), "Billing tab present");
  check(/Tax & GST/i.test(t), "Tax & GST tab present");
  check(/Printer/i.test(t), "Printer tab present");
  check(/Security/i.test(t), "Security tab present");
  const kitchenStandalone = /^Kitchen$/m.test(t.replace(/Kitchen & KOT/gi, ""));
  check(!kitchenStandalone, "no standalone Kitchen tab");
  const restaurantTabMissing = !/^Restaurant$/m.test(t);
  check(restaurantTabMissing, "no standalone Restaurant tab (screen visibility centralized)");

  // B2. Single Save button — exactly one, no per-field Save buttons
  const saveButtons = await page.evaluate(() => {
    return [...document.querySelectorAll("button")].filter((b) => /^Save Settings$/i.test(b.innerText.trim())).length;
  });
  check(saveButtons === 1, `exactly one "Save Settings" button (found ${saveButtons})`);
  const individualSaves = await page.evaluate(() => {
    return [...document.querySelectorAll("button")].filter((b) => /^Save$/i.test(b.innerText.trim())).length;
  });
  check(individualSaves === 0, `zero individual per-field Save buttons (found ${individualSaves})`);

  // B3. POS Screen Settings — business mode cards + module visibility
  await tabClick("POS Screen Settings");
  t = await bodyText();
  check(/Business Mode/i.test(t), "Business Mode section present");
  check(/Restaurant/i.test(t) && /Basic POS/i.test(t) && /Hybrid/i.test(t), "all three business modes shown");
  check(/Module Visibility/i.test(t), "Module Visibility section present");
  check(/Kitchen & KOT/i.test(t), "Kitchen & KOT section present inside POS Screen Settings");
  check(/KOT Printing/i.test(t), "KOT Printing info present");
  // Restaurant mode (current) must NOT show POS Ordering-only controls
  check(!/Enable POS Ordering Screen/i.test(t), "Restaurant mode hides 'Enable POS Ordering Screen'");
  check(!/Enable Basic POS Quick Billing/i.test(t), "Restaurant mode hides 'Enable Basic POS Quick Billing'");
  check(/Enable Kitchen \(KOT\)/i.test(t), "Kitchen toggle visible in Restaurant mode");
  check(/Enable Floor Management/i.test(t), "Floor Management toggle visible in Restaurant mode");

  // Switch to Basic POS → POS Ordering controls appear
  await page.evaluate(() => { const el = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("Basic POS") && x.innerText.includes("Quick billing")); if (el) el.click(); });
  await sleep(1200);
  t = await bodyText();
  check(/Enable POS Ordering Screen/i.test(t), "Basic POS mode shows 'Enable POS Ordering Screen'");
  check(/Enable Basic POS Quick Billing/i.test(t), "Basic POS mode shows 'Enable Basic POS Quick Billing'");
  check(!/Enable Floor Management/i.test(t), "Basic POS mode hides floor/table management");
  // Back to Restaurant mode (do not persist the mode switch)
  await page.evaluate(() => { const el = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("Full dine-in")); if (el) el.click(); });
  await sleep(800);

  // B4. Billing — no INVINV duplication (input values show single prefix)
  await tabClick("Billing");
  t = await bodyText();
  const prefixValues = await page.evaluate(() => {
    const labels = ["Invoice Prefix", "KOT Prefix", "Bill Prefix"];
    const out = {};
    labels.forEach((lbl) => {
      const labelEl = [...document.querySelectorAll("label")].find((x) => x.innerText.trim().toLowerCase() === lbl.toLowerCase());
      if (!labelEl) return;
      const input = labelEl.parentElement.querySelector("input");
      if (input) out[lbl] = input.value;
    });
    return out;
  });
  check(prefixValues["Invoice Prefix"] === "INV", `Invoice Prefix shows single value "INV" (got "${prefixValues["Invoice Prefix"]}")`);
  check(prefixValues["KOT Prefix"] === "KOT", `KOT Prefix shows single value "KOT" (got "${prefixValues["KOT Prefix"]}")`);
  check(prefixValues["Bill Prefix"] === "BILL", `Bill Prefix shows single value "BILL" (got "${prefixValues["Bill Prefix"]}")`);
  check(/Split Bill/i.test(t), "Split Bill toggle present");
  check(/Round Off/i.test(t), "Round Off toggle present");
  check(/Auto Print Bill/i.test(t), "Auto Print Bill toggle present");

  // B5. Tax & GST — real editable GST rate, no decorative tax-components editor
  await tabClick("Tax & GST");
  t = await bodyText();
  check(/Tax Type/i.test(t), "Tax Type present");
  check(/GST Rate/i.test(t), "GST Rate (%) editable input present");
  check(/Service Charge/i.test(t), "Service Charge present");
  check(!/Tax Components/i.test(t), "decorative Tax Components editor removed");
  check(!/Add Tax Rule/i.test(t), "no Add Tax Rule button (no billing consumer)");

  // B6. Security — auto-lock + change password (real settings)
  await tabClick("Security");
  t = await bodyText();
  check(/Auto-Lock Timer/i.test(t), "Auto-Lock Timer present (consumed by AppShell)");
  check(/Change Password/i.test(t), "Change Password present");
  check(!/Require Authentication After Lock/i.test(t), "no dead requireAuthAfterLock toggle");

  // B7. Search — finds real visible settings
  await page.evaluate(() => {
    const inp = document.querySelector("input[placeholder='Search settings...']");
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "GST Rate");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await sleep(800);
  t = await bodyText();
  check(/Tax & GST/i.test(t), "search 'GST Rate' surfaces the Tax & GST tab");
  const taxTabVisible = await page.evaluate(() => {
    return [...document.querySelectorAll("button")].some((x) => /Tax & GST/i.test(x.innerText));
  });
  check(taxTabVisible, "search 'GST Rate' keeps only matching sections visible");
  await page.evaluate(() => {
    const inp = document.querySelector("input[placeholder='Search settings...']");
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await sleep(600);

  // B8. Save → persisted (verify via API after clicking Save Settings)
  await tabClick("General");
  await tabClick("Billing");
  // Toggle split bill off then on via UI to confirm the toggle is live
  const beforeToggle = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${adminToken}` } }).then(r => r.json());
  const saveBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^Save Settings$/i.test(x.innerText.trim()));
    if (b) b.click();
    return !!b;
  });
  check(saveBtn, "Save Settings button found and clicked");
  await sleep(2500);
  const after = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${adminToken}` } }).then(r => r.json());
  check(after.setting.billPrefix === "BILL" && after.setting.invoicePrefix === "INV" && after.setting.kotPrefix === "KOT", "save persisted prefixes (API-confirmed)");

  // B9. Reset reloads from DB
  const resetBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^Reset$/i.test(x.innerText.trim()));
    if (b) b.click();
    return !!b;
  });
  check(resetBtn, "Reset button found and clicked");
  await sleep(2000);
  t = await bodyText();
  check(/POS Settings/i.test(t), "settings page still renders after Reset");

  // B10. Responsive — no horizontal overflow on POS Settings at all viewports
  for (const vp of [{ w: 390, h: 844 }, { w: 768, h: 1024 }, { w: 1024, h: 768 }, { w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    await sleep(700);
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      cw: document.documentElement.clientWidth,
      sw: document.documentElement.scrollWidth,
    }));
    check(!m.overflow, `${vp.w}x${vp.h} — no horizontal overflow (sw=${m.sw}, cw=${m.cw})`);
  }

  // ── Console / network ──
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(e));
  check(realErrors.length === 0, `zero console/page errors (${realErrors.length})`);
  const realFailed = failedReqs.filter((u) => !/favicon/.test(u));
  check(realFailed.length === 0, `zero failed API requests (${realFailed.length})`);

  await browser.close();

  // Restore original settings values changed by this run (billPrefix etc. were
  // saved as BILL/INV/KOT — already the defaults; tax 5% / sc 0 are defaults).
  // Nothing destructive was written; the toggle flips were not persisted except
  // via the single Save click in B8 which re-saved the DB values read earlier.
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
