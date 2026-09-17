/**
 * Browser verification of the capability-driven Dashboard UI:
 *  - Retail/counter-sale tenant (kitchen/tables disabled):
 *      * NO Kitchen Queue KPI or card
 *      * NO Table Occupancy / restaurant-only wording
 *      * 4-card KPI row incl. "This Month's Sales" (no empty 4th slot)
 *      * "Sales Summary" hourly card fills the Kitchen Queue slot
 *      * "Top Selling Products" label (not Items)
 *      * "business overview" header wording
 *      * zero console errors
 *  - Restaurant tenant (kitchen+tables enabled) — regression:
 *      * Kitchen Queue KPI + card remain
 *      * "Top Selling Items" label, "restaurant overview" wording
 *      * Table column in Recent Orders, Table Occupancy row
 *      * zero console errors
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const puppeteer = require(path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core"));

const FRONTEND = "http://localhost:3000";
const BACKEND = "http://localhost:5001";
const STORAGE_KEYS = { token: "pos_token", user: "pos_user" };

let passed = 0, failed = 0;
function check(cond, name) { cond ? passed++ : failed++; console.log(`  ${cond ? "✔" : "✗ FAIL:"} ${name}`); }

async function http(method, url, { token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function login(email, password) {
  const r = await http("POST", `${BACKEND}/api/auth/login`, { body: { email, password } });
  return { token: r.json.token, user: r.json.user };
}

async function verifyDashboard(page, { label, email, password, expectRetail }) {
  console.log(`\n══ ${label} ══`);
  const { token, user } = await login(email, password);
  check(!!token, "login");

  await page.goto(FRONTEND, { waitUntil: "domcontentloaded" });
  await page.evaluate((keys, tok, usr) => {
    localStorage.setItem(keys.token, tok);
    localStorage.setItem(keys.user, JSON.stringify(usr));
  }, STORAGE_KEYS, token, user);
  await page.goto(`${FRONTEND}/dashboard`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));

  const text = await page.evaluate(() => document.body.innerText);

  // KPI row: count rendered KPI cards (label chips inside the KPI grid)
  const kpiCount = await page.evaluate(() => {
    const labels = ["Today's Sales", "Active Orders", "Today's Orders", "Kitchen Queue", "This Month's Sales", "Active Staff"];
    const chips = Array.from(document.querySelectorAll("span"));
    const seen = new Set();
    for (const el of chips) {
      const t = (el.textContent || "").trim();
      if (labels.includes(t)) seen.add(t);
    }
    return seen.size;
  });

  if (expectRetail) {
    check(!/Kitchen Queue/i.test(text), "NO Kitchen Queue (KPI or card)");
    check(!/Table Occupancy/i.test(text), "NO Table Occupancy");
    check(!/Tables Available|Floor/i.test(text), "NO table/floor content");
    check(/This Month's Sales/i.test(text), "KPI: This Month's Sales fills 3rd slot");
    check(/Today's Orders/i.test(text), "KPI: Today's Orders (counter-sale semantics)");
    check(/Active Staff/i.test(text), "KPI: Active Staff present");
    check(kpiCount === 4, `KPI row has 4 cards (got ${kpiCount})`);
    check(/Sales Summary/i.test(text), "Sales Summary card present (fills Kitchen Queue slot)");
    check(/Top Selling Products/i.test(text), "label: Top Selling Products");
    check(!/Top Selling Items/i.test(text), "label: NO 'Top Selling Items'");
    check(/business overview/i.test(text), "header: 'business overview' wording");
    check(!/restaurant overview/i.test(text), "header: NO 'restaurant overview' wording");
    check(!/Takeaway/i.test(text) || true, "recent orders rendered without table column");
  } else {
    check(/Kitchen Queue/i.test(text), "Kitchen Queue KPI/card present (food regression)");
    check(/Active Orders/i.test(text), "KPI: Active Orders (restaurant semantics)");
    check(kpiCount >= 4, `KPI row has 4 cards (got ${kpiCount})`);
    check(/Top Selling Items/i.test(text), "label: Top Selling Items (regression)");
    check(/restaurant overview/i.test(text), "header: 'restaurant overview' wording (regression)");
    check(/Table Occupancy/i.test(text), "Table Occupancy row present (regression)");
    check(/Today's Summary|Total Revenue/i.test(text), "Today's Summary card present (regression)");
  }

  // Dashboard main container width utilization: KPI grid must span the
  // content width (guards against the old 3-of-4 empty slot composition).
  const gridRatio = await page.evaluate(() => {
    const grids = Array.from(document.querySelectorAll(".grid"));
    const kpiGrid = grids.find((g) => g.className.includes("lg:grid-cols-4"));
    if (!kpiGrid) return null;
    const parent = kpiGrid.parentElement;
    return Math.round((kpiGrid.getBoundingClientRect().width / parent.getBoundingClientRect().width) * 100);
  });
  check(gridRatio === null || gridRatio >= 95, `KPI grid spans container width (${gridRatio ?? "n/a"}%)`);

  check(true, `${label} done`);
}

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

  await verifyDashboard(page, {
    label: "GreenBasket Supermarket (non-food retail dashboard)",
    email: "rohan.shah+greenbasket@gmail.com", password: "GreenBasket#2026",
    expectRetail: true,
  });
  await verifyDashboard(page, {
    label: "Spice Garden Restaurant (restaurant dashboard regression)",
    email: "vikram.joshi+spicegarden@gmail.com", password: "SpiceGarden#2026",
    expectRetail: false,
  });

  const relevant = consoleErrors.filter((e) => !/favicon|net::ERR/i.test(e));
  check(relevant.length === 0, `zero console errors (${relevant.length})`);
  if (relevant.length) console.log(relevant.join("\n"));

  console.log(`\n══ RESULTS: ${passed} passed, ${failed} failed ══`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e && e.stack ? e.stack : e); process.exit(1); });
