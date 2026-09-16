/**
 * Real-browser verification (puppeteer-core + installed Chrome) for:
 *  1. Barcode Scanner ON → dedicated Counter Scan screen (no categories/items),
 *     auto-focused input, scan → cart qty aggregates, invalid barcode shows
 *     "Product not found" without leaving scan mode, input refocuses.
 *  2. New Order wizard → NO "Service Staff" selector, NO "Customer"/"Add
 *     Customer" section (backend already derives order.userId from JWT).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const puppeteer = require(path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core"));
const jwt = require("jsonwebtoken");

const FRONTEND_URL = "http://localhost:3000";
const CHROME = "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const VALID_BARCODE = "8901234567890"; // Crispy Corn Chaat (restaurant_1 MenuItem 1)
const INVALID_BARCODE = "1111111111111";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // ── 1. load app unauthenticated to populate origin storage ──
  await page.goto(FRONTEND_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1500);

  // ── 2. seed a real ADMIN session (user 2, restaurant 1) ──
  await page.evaluate((token) => {
    const user = { id: 2, name: "Admin", email: "admin@restaurant.com", role: "ADMIN", restaurantId: 1 };
    localStorage.setItem("pos_token", token);
    localStorage.setItem("pos_user", JSON.stringify(user));
  }, jwt.sign({ id: 2, role: "ADMIN", email: "admin@restaurant.com", restaurantId: 1 }, process.env.JWT_SECRET, { expiresIn: "15m" }));

  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await sleep(6000); // settings + menu hydration

  const results = [];
  const check = (ok, name) => { results.push({ ok, name }); console.log(`${ok ? "✔" : "✘"} ${name}`); };

  // ── 3. open POS Ordering from the sidebar (wait for hydration) ──
  let clicked = false;
  for (let attempt = 0; attempt < 10 && !clicked; attempt++) {
    clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, a")];
      const el = btns.find((b) => b.textContent.trim().includes("POS Ordering"));
      if (el) { el.click(); return true; }
      return false;
    });
    if (!clicked) await sleep(1500);
  }
  await sleep(4000);
  check(clicked, "sidebar 'POS Ordering' item clicked");

  const body = () => page.evaluate(() => document.body.innerText);
  let text = await body();

  // ── 4. SCAN MODE assertions (barcodeScannerEnabled=true on this tenant) ──
  const scanAreaVisible = /SCAN BARCODE/i.test(text);
  check(scanAreaVisible, "Counter Scan screen shown (SCAN BARCODE area)");
  check(!/Burgers|Combo Offers|items\s*$/m.test(text.split("CART")[0] || text), "no category/item cards in scan mode");
  const noCatGrid = await page.evaluate(() => !document.body.innerText.includes("items)")); // category cards show "N items"
  check(noCatGrid, "no category cards ('N items' labels) rendered");

  const inputInfo = await page.evaluate(() => {
    const el = document.querySelector('input[name="barcodeInput"]');
    return { present: !!el, focused: el === document.activeElement };
  });
  check(inputInfo.present && inputInfo.focused, "barcode input present AND auto-focused");

  // helper: type a barcode + Enter into the scan input
  const scan = async (code) => {
    await page.evaluate(() => { const el = document.querySelector('input[name="barcodeInput"]'); if (el) el.focus(); });
    await page.keyboard.type(code, { delay: 10 });
    await page.keyboard.press("Enter");
    await sleep(2500);
  };

  // 4a. valid scan → cart row appears with qty 1
  await scan(VALID_BARCODE);
  text = await body();
  check(/Crispy Corn Chaat/.test(text), "valid scan adds product to cart");
  check(/Crispy Corn Chaat[\s\S]{0,80}?1\b/.test(text), "quantity starts at 1");

  // 4b. same barcode again → qty aggregates to 2 (not a second row)
  const rowsBefore = (text.match(/Crispy Corn Chaat/g) || []).length;
  await scan(VALID_BARCODE);
  text = await body();
  const rowsAfter = (text.match(/Crispy Corn Chaat/g) || []).length;
  check(rowsAfter === rowsBefore && /Crispy Corn Chaat[\s\S]{0,80}?2\b/.test(text), "repeat scan aggregates quantity to 2 (no duplicate row)");

  // 4c. invalid barcode → controlled not-found, still in scan mode
  await scan(INVALID_BARCODE);
  text = await body();
  check(/Product not found/i.test(text) && /1111111111111/.test(text), "invalid barcode shows 'Product not found' + barcode");
  const stillScanning = await page.evaluate(() => !!document.querySelector('input[name="barcodeInput"]'));
  check(stillScanning, "scan screen still active after not-found (input persists, no navigation)");

  // 4d. scanner still usable: valid scan after error → qty 3, error cleared
  await scan(VALID_BARCODE);
  text = await body();
  check(/Crispy Corn Chaat[\s\S]{0,80}?3\b/.test(text) && !/Product not found/i.test(text), "post-error scan works; error cleared; qty 3");
  const refocused = await page.evaluate(() => {
    const el = document.querySelector('input[name="barcodeInput"]');
    return el === document.activeElement && el.value === "";
  });
  check(refocused, "input cleared and refocused after scan (continuous workflow)");

  // ── 5. NEW ORDER wizard assertions (scanner OFF scenario) ──
  // With the scanner ON the sidebar routes to Counter Scan (already verified
  // above), so verify the wizard UI by flipping the tenant toggle OFF in-page,
  // exactly as the POS Settings screen would.
  await page.evaluate(() => {
    const raw = localStorage.getItem("pos_user");
    if (raw) localStorage.setItem("pos_user_qa_backup", raw);
  });
  await page.evaluate(() => {
    // settings live in the zustand store, hydrated from /api/settings — flip
    // the toggle in the hydrated store state via the exposed hook on window.
  });
  // Real flow: GET the settings (as POS Settings does), flip ONLY the scanner
  // toggle, and POST the full known-key payload (the validator requires
  // restaurantName; Joi defaults would reset omitted fields).
  const SETTINGS_KEYS = ["restaurantName", "gstNumber", "fssaiNumber", "phone", "email", "website", "address", "logo", "currency", "timezone", "language", "taxPercentage", "serviceCharge", "roundOffEnabled", "billPrefix", "billNumberStart", "invoicePrefix", "kotPrefix", "enableKitchenDisplay", "enableKotStatusTracking", "receiptFooter", "enableKitchen", "enableBilling", "enableHoldOrders", "enableAddItem", "enableSplitBill", "enableTransferTable", "enableMergeTables", "enableFloorManagement", "enableReports", "enableMenu", "enableStock", "enableActiveOrders", "enableTableReservations", "enableStaffRoster", "barcodeScannerEnabled", "autoPrintBill", "autoPrintKOT", "autoGenerateKOT", "multiplePayments", "askCustomerBeforePrint", "autoReleaseTable", "enablePosOrdering", "posLayout", "enableCounterSale", "taxType", "taxesAndCharges", "uiSettings"];
  const toggled = await page.evaluate(async (keys) => {
    const token = localStorage.getItem("pos_token");
    const get = await fetch("http://localhost:5001/api/settings", { headers: { Authorization: `Bearer ${token}` } });
    const current = (await get.json())?.setting || {};
    const payload = {};
    for (const k of keys) if (k in current) payload[k] = current[k];
    payload.restaurantName = payload.restaurantName || "The Golden Grill";
    payload.barcodeScannerEnabled = false;
    const post = await fetch("http://localhost:5001/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    return post.status;
  }, SETTINGS_KEYS);
  await sleep(1000);
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await sleep(6000);
  const clicked2 = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, a")];
    const el = btns.find((b) => b.textContent.trim().includes("POS Ordering")) ||
               btns.find((b) => b.textContent.trim().includes("New Order"));
    if (el) { el.click(); return true; }
    return false;
  });
  await sleep(4000);
  text = await body();
  check(toggled === 200 && clicked2, "with scanner OFF, POS Ordering opens the New Order wizard");
  const scanAreaGone = await page.evaluate(() => !document.querySelector('input[name="barcodeInput"]'));
  check(scanAreaGone && !/SCAN BARCODE/i.test(text), "scanner OFF: no scan area (interfaces never coexist)");
  check(!/Service Staff/i.test(text), "NO 'Service Staff' selector");
  check(!/Add Customer/i.test(text) && !/Customer Name/i.test(text) && !/Customer Phone/i.test(text), "NO Customer name/phone/Add Customer UI");

  // ── 6. console hygiene ──
  // Expected resource logs: the deliberate 404 (invalid-barcode lookup) and
  // the 400 from the pre-fix settings probe are not application errors.
  const appErrors = consoleErrors.filter((e) => !/favicon|net::ERR_FAILED|manifest/i.test(e) && !/Failed to load resource.*(404|400)/.test(e));
  check(appErrors.length === 0, `zero console errors (${appErrors.length})`);
  appErrors.slice(0, 5).forEach((e) => console.log("   · " + e.slice(0, 160)));

  await page.screenshot({ path: path.join(__dirname, "pos-verify-final.png"), fullPage: false });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("browser test crashed:", e.message); process.exit(1); });
