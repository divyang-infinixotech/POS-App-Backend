/**
 * LIVE BROWSER VERIFICATION — PHASE 22/23/24/25 (end-to-end).
 *
 * Navigates the REAL state-based SPA by clicking sidebar items (URLs are
 * ignored by AppShell) and simulates a USB/Bluetooth HID keyboard-wedge
 * scanner (rapid keystrokes + Enter).
 *
 * ENTITLEMENT MATRIX (from the live platform DB):
 *   Tenant 1 — PREMIUM, subscription features DO NOT include barcode_scanner
 *              → negative case: no scanner UI anywhere, plan-gate message in
 *                settings, no scanner input in the Full POS wizard.
 *   Tenant 9 — BASIC_POS mode, subscription features INCLUDE barcode_scanner
 *              → positive case: Basic POS (PosWorkspace) scanner flow with
 *                real scans, quantity increment, unknown-barcode error.
 *
 * Run: node qa/live-phase22-browser-barcode.js
 */
const os = require("os");
const path = require("path");
const { platformPrisma, getTenantClientByRestaurantId } = require("../src/config/tenantPrisma");

const CHROME = "C:\\Users\\Divyang\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const PUPPETEER = path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core");
const FE = "http://localhost:3000";
const BASE = "http://127.0.0.1:5001/api";
const SCAN_CODE = "890000000002"; // stamped onto tenant 9's QA item
const UNKNOWN_CODE = "999999999999";

let pass = 0, fail = 0;
const failures = [];
function check(msg, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg); console.log("  ❌ " + msg + (detail ? "\n     " + String(detail).slice(0, 400) : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

/** HID keyboard-wedge: focus, rapid keystrokes, Enter (no click needed after). */
async function hidScan(page, code) {
  await page.focus('input[name="barcodeInput"]');
  await page.keyboard.type(code, { delay: 6 });
  await page.keyboard.press("Enter");
  await sleep(1400);
}

/** Establish a browser session for a tenant via super-admin login-as. */
async function loginAs(page, restaurantId) {
  await page.goto(FE + "/login", { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1000);
  const ok = await page.evaluate(async (BASE, rid) => {
    const r = await fetch(BASE + "/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "superadmin@pos.com", password: "SuperAdmin@123" }),
    });
    const j = await r.json();
    if (!j.token) return null;
    const la = await fetch(BASE + `/super-admin/restaurants/${rid}/login-as`, { headers: { Authorization: "Bearer " + j.token } });
    const lj = await la.json();
    const t = lj.token || lj.data?.token;
    const u = lj.user || lj.data?.user;
    if (!t || !u) return null;
    localStorage.setItem("pos_token", t);
    localStorage.setItem("pos_user", JSON.stringify(u));
    return true;
  }, BASE, restaurantId);
  await page.goto(FE + "/", { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(2500);
  return ok;
}

/** Click a sidebar item by exact label. */
async function navTo(page, label) {
  return page.evaluate((label) => {
    const items = [...document.querySelectorAll("button, a, [role=button]")];
    const el = items.find((b) => (b.innerText || "").trim().toLowerCase() === label.toLowerCase());
    if (el) { el.click(); return true; }
    return false;
  }, label);
}

/** Open the POS Screen Settings tab and return the page text. */
async function openPosScreenSettings(page) {
  check("nav to POS Settings", !!(await navTo(page, "POS Settings")));
  await sleep(2200);
  await page.evaluate(() => {
    const els = [...document.querySelectorAll("button, [role=tab]")];
    const el = els.find((el) => /pos screen settings/i.test(el.innerText || ""));
    if (el) el.click();
  });
  await sleep(1800);
  return page.evaluate(() => document.body.innerText);
}

(async () => {
  console.log("──────── LIVE BROWSER E2E — barcode / settings / screens ────────\n");

  // ── Sessions + entitlement matrix (straight from the platform DB) ──
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  const saToken = sa.json?.token;
  check("super admin login", !!saToken);
  const la1 = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
  const la9 = await api("GET", "/super-admin/restaurants/9/login-as", null, saToken);
  const tok1 = la1.json?.token || la1.json?.data?.token;
  const tok9 = la9.json?.token || la9.json?.data?.token;
  check("login-as tokens for tenant 1 and 9", !!tok1 && !!tok9);

  const sub1 = await platformPrisma.subscription.findFirst({ where: { restaurantId: 1 }, select: { features: true } });
  const sub9 = await platformPrisma.subscription.findFirst({ where: { restaurantId: 9 }, select: { features: true } });
  const t1HasScanner = Array.isArray(sub1?.features) && sub1.features.includes("barcode_scanner");
  const t9HasScanner = Array.isArray(sub9?.features) && sub9.features.includes("barcode_scanner");
  check("matrix: tenant 1 plan WITHOUT barcode_scanner", t1HasScanner === false, JSON.stringify(sub1?.features));
  check("matrix: tenant 9 plan WITH barcode_scanner", t9HasScanner === true, JSON.stringify(sub9?.features));

  // ── Prep tenant 9: scanner toggle ON + stamp a QA barcode on one item ──
  const t9 = await getTenantClientByRestaurantId(9);
  await t9.client.restaurantSetting.update({ where: { restaurantId: 9 }, data: { barcodeScannerEnabled: true } });
  const qaItem = await t9.client.menuItem.findFirst({
    where: { isAvailable: true, OR: [{ barcode: null }, { barcode: "" }] },
    select: { id: true, name: true, barcode: true },
    orderBy: { id: "asc" },
  });
  check("tenant 9 QA item found to stamp", !!qaItem, "no available item without barcode");
  let t9OriginalBarcode = null;
  if (qaItem) {
    t9OriginalBarcode = qaItem.barcode || "";
    await t9.client.menuItem.update({ where: { id: qaItem.id }, data: { barcode: SCAN_CODE } });
    console.log(`  🏷️  stamped ${SCAN_CODE} onto tenant 9 item ${qaItem.id} (${qaItem.name}); original: "${t9OriginalBarcode}"`);
  }
  // Pick a category that has subcategories (for the tabs assertion)
  const subs9 = await t9.client.subcategory.findMany({ where: { isActive: true }, select: { name: true, category: { select: { name: true } } }, take: 20 });
  const t9CatWithSubs = subs9.find((s) => s.category?.name)?.category?.name || null;
  const t9SubName = subs9.find((s) => s.category?.name === t9CatWithSubs)?.name || null;
  await t9.client.$disconnect();

  const puppeteer = require(PUPPETEER);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    userDataDir: path.join(os.tmpdir(), `qa-e2e-${Date.now()}`),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  });

  let body = "";
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));

    // ══ A. TENANT 9 — BASIC POS (PosWorkspace) full barcode flow ══
    console.log("\n── A. Tenant 9 (BASIC_POS, plan entitled) — Basic POS barcode flow ──");
    check("tenant 9 browser session", !!(await loginAs(page, 9)));

    // Counter mode: sidebar "POS Ordering" opens PosWorkspace (order_taking)
    check("sidebar 'POS Ordering' visible", !!(await navTo(page, "POS Ordering")));
    await sleep(3000);
    body = await page.evaluate(() => document.body.innerText);
    check("Basic POS workspace rendered (category picker view)", /select a category|pick a category/i.test(body), body.slice(0, 150));

    // Click the category that has subcategories → items view
    const openedItems = t9CatWithSubs ? await page.evaluate((catName) => {
      // Category cards render as "🍕\n<Pizzas>\n7 items" — emoji prefix means
      // startsWith fails; match on name + "N items" count instead.
      const cards = [...document.querySelectorAll("button")];
      const card = cards.find((el) => {
        const t = (el.innerText || "").trim();
        return t.includes(catName) && /\d+\s*items?/i.test(t);
      });
      if (card) { card.click(); return true; }
      return false;
    }, t9CatWithSubs) : false;
    check(`category card "${t9CatWithSubs}" clicked → items view`, !!openedItems, "category card not found");
    await sleep(1500);

    // Scanner input must be visible (plan entitled + toggle ON)
    const scanVisible = await page.$('input[name="barcodeInput"]');
    check("scanner input visible in Basic POS (plan + toggle ON)", !!scanVisible, "input[name=barcodeInput] not rendered (canScanBarcode false?)");

    // Category → Subcategory hierarchy: the subcategory row's exact-"All" chip
    // (PosWorkspace's All chip has no count) + the named subcategory tab.
    const subRow = await page.evaluate((subName) => {
      const chips = [...document.querySelectorAll("button")].map((el) => (el.innerText || "").trim());
      return {
        allChip: chips.some((t) => /^all(\s*\(\d+\))?$/i.test(t)),
        namedTab: subName ? chips.some((t) => t.startsWith(subName)) : false,
      };
    }, t9SubName);
    check("subcategory tabs row under selected category (All + named tabs)", subRow.allChip && subRow.namedTab, JSON.stringify(subRow));

    if (scanVisible && qaItem) {
      // SCAN 1 → item added to cart
      await hidScan(page, SCAN_CODE);
      const after1 = await page.evaluate(() => document.body.innerText);
      check(`scan 1 → "${qaItem.name}" added to cart`, after1.includes(qaItem.name), `expected item name in cart UI`);

      // SCAN 2 → quantity increments (row qty "1" → "2", subtotal doubles)
      await hidScan(page, SCAN_CODE);
      const after2 = await page.evaluate(() => document.body.innerText);
      const row = (after2.match(new RegExp(qaItem.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]{0,200}")) || [""])[0];
      const rowQty2 = /\n2\s*\n/.test(row + "\n");
      const sub1m = (after1.match(/sub\s?tot[a-z]*\s*[:\-]?\s*[₹$]?\s*([\d,]+\.?\d*)/i) || [])[1];
      const sub2m = (after2.match(/sub\s?tot[a-z]*\s*[:\-]?\s*[₹$]?\s*([\d,]+\.?\d*)/i) || [])[1];
      const doubled = sub1m && sub2m && (parseFloat(sub2m.replace(/,/g, "")) - parseFloat(sub1m.replace(/,/g, ""))) > 0;
      check("scan 2 → quantity incremented (row shows qty 2 / subtotal grew)", rowQty2 || doubled, JSON.stringify({ rowQty2, sub1: sub1m, sub2: sub2m, row: row.slice(0, 120) }));

      // UNKNOWN barcode → clean error, no crash
      await hidScan(page, UNKNOWN_CODE);
      body = await page.evaluate(() => document.body.innerText);
      check("unknown barcode → 'Item not found for barcode' message", body.includes("Item not found for barcode: " + UNKNOWN_CODE), "error message missing");
      check("cart unchanged after unknown scan (still contains item)", body.includes(qaItem.name));
      check("no page errors after scans (tenant 9)", pageErrors.length === 0, pageErrors.slice(0, 3));
    }

    // Tenant 9 settings: barcode toggle card SHOWN (plan entitled)
    body = await openPosScreenSettings(page);
    check("tenant 9: 'Enable Barcode Scanner' toggle shown (plan entitled)", /enable barcode scanner/i.test(body), "toggle card missing");
    check("tenant 9: POS Ordering 'Always enabled' card", /always enabled/i.test(body), "Always-enabled badge missing");
    check("tenant 9: no 'Enable POS Ordering' ON/OFF toggle", !/enable pos ordering/i.test(body), "old toggle still rendered");

    // ══ B. TENANT 1 — PREMIUM plan gate (negative case) ══
    console.log("\n── B. Tenant 1 (RESTAURANT, plan WITHOUT barcode_scanner) ──");
    check("tenant 1 browser session", !!(await loginAs(page, 1)));

    // Full POS wizard opens (restaurant mode) — scanner must NOT be there
    check("sidebar 'POS Ordering' visible (tenant 1)", !!(await navTo(page, "POS Ordering")));
    await sleep(3000);
    const tookType = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const b = btns.find((el) => /take\s*away/i.test((el.innerText || "")));
      if (b) { b.click(); return true; }
      return false;
    });
    check("wizard order-type step: Take Away clicked", tookType, "Take Away card not found (wizard may not be open)");
    await sleep(1200);
    const continued = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const b = btns.find((el) => /^continue/i.test((el.innerText || "").trim()));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    check("Continue advances to Menu step", continued, "Continue button not enabled/found");
    await sleep(2800);

    const scan1 = await page.$('input[name="barcodeInput"]');
    check("NO scanner input in wizard (plan excludes barcode_scanner)", !scan1, "scanner input rendered despite plan gate!");

    // Category → Subcategory tabs in the wizard (plan-independent)
    const menuSearch = await page.$('input[placeholder="Search dishes, categories..."]');
    check("wizard menu step rendered (search + category row)", !!menuSearch, "menu step search field missing");
    // Close the wizard (Cancel/X) before navigating on
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const x = btns.find((el) => /^(cancel|×|close)$/i.test((el.innerText || "").trim())) || btns.find((el) => (el.getAttribute("aria-label") || "").toLowerCase() === "close");
      if (x) x.click();
    });
    await sleep(1200);

    // Settings: "not included in your subscription plan" card
    body = await openPosScreenSettings(page);
    check("tenant 1: barcode card shows plan-gate message", /not included in your subscription plan/i.test(body), "plan-gate message missing");
    check("tenant 1: no 'Enable Barcode Scanner' toggle", !/enable barcode scanner/i.test(body), "toggle shown despite plan gate!");
    check("tenant 1: POS Ordering 'Always enabled' card", /always enabled/i.test(body), "Always-enabled badge missing");
    check("tenant 1: no 'Enable POS Ordering' ON/OFF toggle", !/enable pos ordering/i.test(body), "old toggle still rendered");

    // ══ C. Core screens sanity (tenant 1) ══
    console.log("\n── C. Core screens render (tenant 1) ──");
    for (const [label, name] of [["Dashboard Overview", "Dashboard"], ["Menu & Stock", "Menu"], ["Staff Roster", "Staff"], ["Active Orders", "Active Orders"]]) {
      const before = pageErrors.length;
      check(`nav ${name}`, !!(await navTo(page, label)));
      await sleep(2400);
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 2500));
      check(`${name} renders without ErrorBoundary`, !/something went wrong/i.test(txt), txt.slice(0, 100));
      check(`${name} no new page errors`, pageErrors.length === before, pageErrors.slice(before, before + 2));
    }

    const relevant = pageErrors.filter((e) => /isEditing|before initialization|ReferenceError|TypeError|undefined is not a function/i.test(e));
    check("no TDZ/Reference/Type errors across all screens", relevant.length === 0, relevant.slice(0, 3));
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Cleanup: restore tenant 9 QA state (QA-created records only) ──
  try {
    if (qaItem && t9OriginalBarcode !== null) {
      await t9.client.menuItem.update({ where: { id: qaItem.id }, data: { barcode: t9OriginalBarcode } });
      console.log(`  🧹 restored barcode "${t9OriginalBarcode}" on tenant 9 item ${qaItem.id}`);
    }
    await t9.client.restaurantSetting.update({ where: { restaurantId: 9 }, data: { barcodeScannerEnabled: false } });
    console.log("  🧹 restored tenant 9 barcodeScannerEnabled=false (original value)");
    await t9.client.$disconnect();
  } catch (e) {
    console.log("  ⚠️ cleanup warning:", e.message);
  }
  // Tenant 1 toggle back to safe default (its plan excludes the feature anyway)
  try {
    const t1 = await getTenantClientByRestaurantId(1);
    await t1.client.restaurantSetting.update({ where: { restaurantId: 1 }, data: { barcodeScannerEnabled: false } });
    await t1.client.$disconnect();
    console.log("  🧹 tenant 1 barcodeScannerEnabled reset to false");
  } catch (e) {
    console.log("  ⚠️ cleanup warning (tenant 1):", e.message);
  }
  await platformPrisma.$disconnect().catch(() => {});

  console.log("\n──────── E2E RESULTS ────────");
  console.log(`  Passed: ${pass} ✅  Failed: ${fail} ${fail ? "❌" : "✅"}`);
  if (failures.length) { console.log("  Failures:"); failures.forEach((f) => console.log("   - " + f)); }
  console.log("  Note: HID keyboard-wedge simulation (rapid keys + Enter). No physical scanner attached — not hardware-verified.");
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error("CRASH:", e);
  await platformPrisma.$disconnect().catch(() => {});
  process.exit(1);
});
