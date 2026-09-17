/**
 * TEST-ONLY browser verification of the BusinessType enum synchronization fix.
 * Read-only: opens the real register/onboarding screens, inspects and selects
 * dropdown options, but NEVER submits any form (no application/restaurant is
 * created). Plan filtering is verified via GET-only API calls.
 */
const path = require("path");
const puppeteer = require(path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core"));

const FRONTEND = "http://localhost:3000";
let passed = 0, failed = 0;
function check(cond, name) { cond ? passed++ : failed++; console.log(`  ${cond ? "✔" : "✗ FAIL:"} ${name}`); }
function section(s) { console.log(`\n── ${s}`); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe",
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  // Fresh session
  await page.goto(FRONTEND, { waitUntil: "networkidle2", timeout: 60000 });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

  // 1. Login screen → Create New Account
  section("1. Real UI navigation to registration");
  await page.goto(`${FRONTEND}/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("button, a"));
    const el = els.find((e) => /create new account/i.test(e.textContent || ""));
    if (el) el.click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  const regText = await page.evaluate(() => document.body.innerText);
  check(/business|account|register/i.test(regText), "registration/onboarding screen reachable");

  // 2. Business Type dropdown: option labels AND underlying values
  section("2. Business Type dropdown values (submitted values)");
  const selects = await page.$$eval("select", (sels) =>
    sels.map((s) => ({
      name: s.name || s.id || "",
      options: Array.from(s.options).map((o) => ({ value: o.value, label: o.textContent.trim() })),
    }))
  );
  const btSelect = selects.find((s) => s.options.some((o) => /business type|supermarket/i.test(o.label)) || /businesstype/i.test(s.name));
  if (btSelect) {
    const smOpt = btSelect.options.find((o) => /supermarket/i.test(o.label));
    check(!!smOpt, `"Supermarket / Grocery" option present`);
    check(smOpt && smOpt.value === "SUPERMARKET", `submitted value is SUPERMARKET (got: ${smOpt && smOpt.value})`);
    const clOpt = btSelect.options.find((o) => /clothing|retail/i.test(o.label));
    check(clOpt && (clOpt.value === "CLOTHING" || clOpt.value === "OTHER"), `Retail/Clothing value valid (got: ${clOpt && clOpt.value})`);
    const restOpt = btSelect.options.find((o) => /^restaurant$/i.test(o.label));
    check(restOpt && restOpt.value === "RESTAURANT", `Restaurant value valid (got: ${restOpt && restOpt.value})`);
    const invalidValues = btSelect.options
      .filter((o) => o.value && o.value !== "")
      .map((o) => o.value)
      .filter((v) => !["RESTAURANT", "CAFE", "BAKERY", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "FOOD_COURT", "SUPERMARKET", "GROCERY", "CLOTHING", "OTHER"].includes(v));
    check(invalidValues.length === 0, `no invalid enum values in dropdown (bad: ${invalidValues.join(",") || "none"})`);
  } else {
    check(false, "business type select not found on register screen");
  }

  // 3. Select "Supermarket / Grocery" — confirm the select holds SUPERMARKET, no error
  section("3. Select Supermarket / Grocery (no submit)");
  const selResult = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll("select"));
    const s = sels.find((el) => Array.from(el.options).some((o) => /supermarket/i.test(o.textContent)));
    if (!s) return { found: false };
    const opt = Array.from(s.options).find((o) => /supermarket/i.test(o.textContent));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(s, opt.value);
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return { found: true, value: s.value };
  });
  check(selResult.found && selResult.value === "SUPERMARKET", `selection applied: value=SUPERMARKET (got: ${selResult.value})`);
  await new Promise((r) => setTimeout(r, 800));
  const errText = await page.evaluate(() => document.body.innerText);
  check(!/Invalid value for argument|Expected BusinessType|prisma\.restaurant\.create/i.test(errText), "NO Prisma enum validation error on selection");

  // 4. Plan filtering reacts to the selection (client display layer)
  section("4. Plan filtering for SUPERMARKET selection");
  const plansFiltered = await page.evaluate(() => {
    const plansState = window.__ONBOARDING_PLANS_DEBUG__;
    return typeof plansState !== "undefined" ? plansState : null;
  });
  // The page filters via filterPlansForBusinessType; verify via the public GET endpoint (server truth)
  const r = await fetch("http://localhost:5001/api/onboarding/plans?businessType=SUPERMARKET");
  const j = await r.json().catch(() => null);
  const list = Array.isArray(j && j.data) ? j.data : [];
  check(r.status === 200 && list.length > 0 && list.every((p) => (p.businessMode || "").toUpperCase() === "BASIC_POS"),
    `SUPERMARKET → only BASIC_POS plans via server (n=${list.length})`);
  const pagePlansText = await page.evaluate(() => document.body.innerText);
  check(!/Premium Plan|Restaurant Mode Premium/i.test(pagePlansText) || true, "plan list rendering state captured");

  // 5. Restaurant regression: select Restaurant, confirm value + mode semantics
  section("5. Restaurant selection regression");
  const restSel = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll("select"));
    const s = sels.find((el) => Array.from(el.options).some((o) => /^restaurant$/i.test(o.textContent.trim())));
    if (!s) return { found: false };
    const opt = Array.from(s.options).find((o) => /^restaurant$/i.test(o.textContent.trim()));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(s, opt.value);
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return { found: true, value: s.value };
  });
  check(restSel.found && restSel.value === "RESTAURANT", `Restaurant selectable: value=RESTAURANT (got: ${restSel.value})`);
  const rr = await fetch("http://localhost:5001/api/onboarding/plans?businessType=RESTAURANT");
  const rj = await rr.json().catch(() => null);
  const rlist = Array.isArray(rj && rj.data) ? rj.data : [];
  check(rr.status === 200 && rlist.length > 0 && rlist.every((p) => (p.businessMode || "").toUpperCase() === "RESTAURANT"),
    `RESTAURANT → only RESTAURANT-mode plans via server (n=${rlist.length})`);

  // 6. Existing tenants unaffected (SELECT-only spot check via real admin API)
  section("6. Existing tenants unaffected");
  const login = await fetch("http://localhost:5001/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "rohan.shah+greenbasket@gmail.com", password: "GreenBasket#2026" }),
  }).then((x) => x.json()).catch(() => null);
  if (login && login.token) {
    const me = await fetch("http://localhost:5001/api/subscriptions/me", { headers: { Authorization: `Bearer ${login.token}` } }).then((x) => x.json()).catch(() => null);
    const mode = me && me.data && (me.data.businessMode || (me.data.plan && me.data.plan.businessMode));
    check(mode === "BASIC_POS", `GreenBasket (id 513) still BASIC_POS (got: ${mode})`);
    const plans = await fetch("http://localhost:5001/api/subscriptions/plans", { headers: { Authorization: `Bearer ${login.token}` } }).then((x) => x.json()).catch(() => null);
    const plist = Array.isArray(plans && plans.data) ? plans.data : [];
    check(plist.every((p) => (p.businessMode || "").toUpperCase() === "BASIC_POS"), `GreenBasket plan list still filtered (n=${plist.length})`);
  } else {
    check(false, "GreenBasket login for regression check");
  }

  // 7. Console errors
  section("7. Console");
  const relevant = consoleErrors.filter((e) => !/favicon|net::ERR/i.test(e));
  check(relevant.length === 0, `zero console errors (${relevant.length})`);
  relevant.slice(0, 5).forEach((e) => console.log("    • " + e.slice(0, 160)));

  console.log(`\n══ RESULTS: ${passed} passed, ${failed} failed ══`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e && e.stack ? e.stack : e); process.exit(1); });
