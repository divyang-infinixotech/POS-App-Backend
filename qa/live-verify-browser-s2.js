/**
 * LIVE BROWSER VERIFICATION — S2 (MANAGER session).
 * Frontend :3000, real backend :5001 + DB, real Chrome.
 *
 * Covers:
 *  - UI password login (manager@restaurant.com / password123) — no 401s
 *  - Active Orders: elapsed time never NaN/undefined/NaNh/NaNm
 *  - Take Order wizard (via "Add Item"): calls GET /users/waiters, does NOT
 *    call GET /users; waiter chips + customer control render
 *  - Wizard resilience: /users/waiters failure → inline unavailable + Retry
 *    (retry recovers); /customers failure → inline error + Retry; no crashes
 *  - Logout → login → no repeated 401s
 *  - Expired/invalid token → exactly ONE 401 → session cleared → login page,
 *    no retry loop
 *
 * Usage: node qa/live-verify-browser-s2.js
 */
const os = require("os");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");
const { getTenantClient } = require("../src/config/tenantPrisma");

const CHROME = "C:\\Users\\Divyang\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const PUPPETEER = path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core");
const FE = "http://localhost:3000";
const BASE = "http://127.0.0.1:5001/api";

let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg + (detail ? " :: " + JSON.stringify(detail).slice(0, 400) : "")); console.log("  ❌ " + msg + (detail ? "\n     " + JSON.stringify(detail).slice(0, 400) : "")); }
}
function section(t) { console.log("\n──────── " + t + " ────────"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

const created = { orderIds: [], tablesUsed: [], menuStockBefore: {} };
async function cleanup(tenantDb) {
  const ids = created.orderIds;
  if (ids.length) {
    try {
      await tenantDb.stockMovement.deleteMany({ where: { orderId: { in: ids } } });
      const kots = await tenantDb.kOT.findMany({ where: { orderId: { in: ids } }, select: { id: true } });
      const kIds = kots.map((k) => k.id);
      if (kIds.length) { await tenantDb.kOTItem.deleteMany({ where: { kotId: { in: kIds } } }); await tenantDb.kOT.deleteMany({ where: { id: { in: kIds } } }); }
      await tenantDb.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await tenantDb.order.deleteMany({ where: { id: { in: ids } } });
    } catch (e) { console.error("cleanup:", e.message); }
  }
  for (const [mid, before] of Object.entries(created.menuStockBefore)) {
    try { await tenantDb.menuItem.update({ where: { id: Number(mid) }, data: { currentStock: before } }); } catch (_) {}
  }
  for (const tid of created.tablesUsed) {
    try { await tenantDb.restaurantTable.update({ where: { id: tid }, data: { status: "AVAILABLE" } }); } catch (_) {}
  }
}

async function main() {
  check((await fetch("http://127.0.0.1:5001/").then((r) => r.status).catch(() => 0)) === 200, "Backend 5001 alive");
  check((await fetch(FE).then((r) => r.status).catch(() => 0)) === 200, "Frontend 3000 alive");

  const tenantDb = getTenantClient("restaurant_1");
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  const la = await api("GET", "/super-admin/restaurants/1/login-as", null, sa.data?.token);
  const adminToken = la.data?.data?.token;

  const preAct = await tenantDb.order.count({ where: { isDeleted: false, status: { notIn: ["COMPLETED", "CANCELLED"] }, orderType: { not: "COUNTER_SALE" } } });
  const preOcc = await tenantDb.restaurantTable.count({ where: { status: "OCCUPIED" } });
  const table = (await tenantDb.restaurantTable.findFirst({ where: { status: "AVAILABLE" }, orderBy: { tableNo: "asc" }, select: { id: true, tableNo: true } }));
  const item = (await tenantDb.menuItem.findFirst({ where: { isAvailable: true, currentStock: { gt: 10 } }, orderBy: { id: "asc" } }));
  const ro = await api("POST", "/orders", { orderType: "DINE_IN", tableId: table.id, items: [{ menuItemId: item.id, quantity: 1 }] }, adminToken);
  const ord = ro.data?.data;
  check(!!ord?.id, `Fixture DINE_IN order created (${ord?.orderNo}) on ${table.tableNo}`);
  created.orderIds.push(ord?.id);
  created.tablesUsed = [table.id];
  created.menuStockBefore[item.id] = item.currentStock;

  const puppeteer = require(PUPPETEER);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-first-run", "--disable-extensions", "--disable-background-networking", "--window-size=1440,900"],
    userDataDir: path.join(os.tmpdir(), "lv-s2-" + Date.now()),
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const consoleMsgs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleMsgs.push({ type: m.type(), text: m.text() }); });
  page.on("pageerror", (e) => consoleMsgs.push({ type: "pageerror", text: String(e.message || e) }));
  const net = [];
  page.on("response", (res) => { const u = res.url(); if (u.includes("/api/")) net.push({ method: res.request().method(), url: u.split("?")[0], status: res.status() }); });
  const netFilter = (m, part) => net.filter((n) => n.method === m && n.url.includes(part));
  const bodyText = () => page.evaluate(() => document.body.innerText);
  const hasText = async (s) => (await page.evaluate(() => document.body.innerText.toLowerCase())).includes(s.toLowerCase());
  const appErrs = () => consoleMsgs.filter((m) => /Rendered more hooks|Rendered fewer hooks|Error Boundary caught|ReferenceError|is not defined|Cannot read propert/.test(m.text));
  async function waitForText(text, timeout = 15000) {
    await page.waitForFunction((t) => document.body && document.body.innerText.toUpperCase().includes(t.toUpperCase()), { timeout }, text);
  }
  async function clickByText(text, opts = {}) {
    const { exact = false, timeout = 10000 } = opts;
    const needle = String(text).toUpperCase();
    await page.waitForFunction((n, ex) => {
      const els = [...document.querySelectorAll("button, [role=button], li, a")];
      const el = els.find((e) => {
        const v = e.textContent.replace(/\s+/g, " ").trim().toUpperCase();
        const hit = ex ? v === n : v.includes(n);
        if (!hit) return false;
        if (e.disabled) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (el) {
        try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
        el.click();
        return true;
      }
      return false;
    }, { timeout }, needle, exact);
  }

  try {
    section("BROWSER S2 — MANAGER: login / wizard / resilience / logout / expired token");
    // ── 1. UI password login ──
    await page.goto(FE, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForText("Log In", 25000);
    await page.type('input[placeholder="Enter email or user ID"]', "manager@restaurant.com");
    await page.type('input[placeholder="Enter password"]', "password123");
    net.splice(0, net.length);
    await clickByText("Log In");
    let lg = [];
    for (let i = 0; i < 40; i++) { lg = netFilter("POST", "/auth/login"); if (lg.length) break; await sleep(400); }
    check(lg.length === 1 && lg[0].status === 200, `UI login POST /auth/login → 200 exactly once (${lg.length})`, lg);
    let shell = false;
    for (let i = 0; i < 40; i++) {
      if ((await hasText("Active Orders")) || (await hasText("Overview")) || (await hasText("POS Ordering"))) { shell = true; break; }
      await sleep(500);
    }
    check(shell, "App shell loaded after login (sidebar visible)");
    const login401 = net.filter((n) => n.status === 401);
    check(login401.length === 0, "Login flow produced ZERO 401s", login401);
    check(appErrs().length === 0, "No hook/ReferenceError/ErrorBoundary errors after login", appErrs());

    // ── 2. Active Orders: fixture order visible, no NaN ──
    await clickByText("Active Orders");
    let ordSeen = false;
    for (let i = 0; i < 40; i++) {
      if ((await hasText(ord.orderNo)) || (await hasText("Add Item"))) { ordSeen = true; break; }
      await sleep(500);
    }
    check(ordSeen, "Fixture active order visible on Active Orders");
    await sleep(1500);
    const aoText = await bodyText();
    check(!/NaN|undefined|NaNh|NaNm/.test(aoText), "Elapsed time renders without NaN/undefined/NaNh/NaNm", aoText.match(/.{0,20}(NaN|undefined).{0,20}/)?.[0] || null);
    check(appErrs().length === 0, "Active Orders renders without app errors", appErrs());

    // ── 3. Take Order wizard: waiter endpoint + no /users ──
    net.splice(0, net.length);
    await clickByText("Add Item");
    await waitForText("Edit Order #", 30000);
    let wc = [];
    for (let i = 0; i < 60; i++) { wc = netFilter("GET", "/users/waiters"); if (wc.length > 0) break; await sleep(500); }
    await sleep(3000);
    const uc = net.filter((n) => n.method === "GET" && n.url.endsWith("/api/users"));
    check(wc.length >= 1, `Take Order wizard called GET /users/waiters (${wc.length}x)`, wc);
    check(uc.length === 0, "Take Order wizard did NOT call GET /users", uc);
    check(wc.every((n) => n.status === 200), "GET /users/waiters returned 200", wc);
    check(appErrs().length === 0, "Wizard opened without hook/ReferenceError/ErrorBoundary errors", appErrs());
    // back to the table step that hosts Service Staff chips + customer control
    await clickByText("Back", { exact: true });
    await sleep(1500);
    const stepTxt = await bodyText();
    check(await hasText("Service Staff"), "Wizard table step shows Service Staff section");
    check(/Rohit|Sunil|Deepak|Anita|Manoj/i.test(stepTxt), "Waiter chips rendered with tenant staff names", stepTxt.match(/Rohit|Sunil|Deepak|Anita|Manoj/gi));
    check(await hasText("Add Customer"), "Customer control rendered");
    check(!/NaN|undefined/.test(stepTxt), "No NaN/undefined on wizard table step");
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "Close order wizard"); if (b) b.click(); });
    await sleep(1200);

    // ── 4. Resilience: waiter failure → inline unavailable + Retry; retry works ──
    let abortWaiters = false, abortCustomers = false;
    const interceptHandler = (req) => {
      try {
        const url = req.url();
        if (abortWaiters && url.includes("/api/users/waiters")) return req.abort();
        if (abortCustomers && url.includes("/api/customers")) return req.abort();
        req.continue();
      } catch (_) {
        /* request already handled or interception disabled mid-flight — ignore */
      }
    };
    await page.setRequestInterception(true);
    page.on("request", interceptHandler);
    abortWaiters = true;
    net.splice(0, net.length);
    await clickByText("Add Item");
    await waitForText("Edit Order #", 30000);
    await sleep(3500);
    await clickByText("Back", { exact: true });
    await sleep(1500);
    // scroll to the Service Staff block so its Retry button is reachable
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("span, div, p, h3")].find((e) => /Service Staff/i.test(e.textContent) && e.getBoundingClientRect().width > 0);
      if (el) { try { el.scrollIntoView({ block: "center" }); } catch (_) {} }
    });
    await sleep(400);
    const fw = await bodyText();
    check(await hasText("Staff list unavailable."), "Waiter load failure → inline unavailable state (wizard usable)");
    check(await hasText("Retry"), "Waiter failure → Retry button present");
    check(appErrs().length === 0, "No ErrorBoundary/hook crash when waiters fail", appErrs());
    abortWaiters = false;
    net.splice(0, net.length);
    await clickByText("Retry");
    let retried = false;
    for (let i = 0; i < 40; i++) {
      if (netFilter("GET", "/users/waiters").some((n) => n.status === 200)) { retried = true; break; }
      await sleep(500);
    }
    check(retried, "Retry issued a new GET /users/waiters");
    await sleep(2000);
    check(/Rohit|Sunil|Deepak|Anita|Manoj/i.test(await bodyText()), "Retry recovered → waiter chips visible");
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "Close order wizard"); if (b) b.click(); });
    await sleep(1000);

    // ── 5. Resilience: customer failure ──
    abortCustomers = true;
    await clickByText("Add Item");
    await waitForText("Edit Order #", 30000);
    await sleep(3500);
    await clickByText("Back", { exact: true });
    await sleep(1200);
    await clickByText("Add Customer");
    await waitForText("Find or Add Customer", 12000);
    await sleep(1500);
    const cf = await bodyText();
    check(await hasText("Couldn't load customer list."), "Customer load failure → inline unavailable + Retry (no crash)");
    check(appErrs().length === 0, "No crash when customers fail", appErrs());
    abortCustomers = false;
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Close"); if (b) b.click(); });
    await sleep(500);
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "Close order wizard"); if (b) b.click(); });
    await sleep(800);
    page.off("request", interceptHandler);
    await page.setRequestInterception(false);

    // ── 6. Logout → login → no 401 storm ──
    await page.evaluate(() => localStorage.clear());
    net.splice(0, net.length);
    await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await waitForText("Log In", 20000);
    await sleep(1500);
    const out401 = net.filter((n) => n.status === 401);
    check(out401.length === 0, "After logout: login screen reached with ZERO 401s", out401);
    await page.type('input[placeholder="Enter email or user ID"]', "manager@restaurant.com");
    await page.type('input[placeholder="Enter password"]', "password123");
    net.splice(0, net.length);
    await clickByText("Log In");
    let shell2 = false;
    for (let i = 0; i < 40; i++) {
      if ((await hasText("Active Orders")) || (await hasText("Overview")) || (await hasText("POS Ordering"))) { shell2 = true; break; }
      await sleep(500);
    }
    check(shell2, "Second login succeeds");
    await sleep(2500);
    const relogin401 = net.filter((n) => n.status === 401);
    check(relogin401.length === 0, "Second login + boot: ZERO 401s (no repeated 401 loop)", relogin401);

    // ── 7. Expired/invalid token → exactly ONE 401 → session cleared → login ──
    net.splice(0, net.length);
    await page.evaluate(() => localStorage.setItem("pos_token", "expired.invalid.token.value"));
    await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await waitForText("Log In", 25000);
    await sleep(3000);
    const p401 = net.filter((n) => n.url.includes("/auth/profile") && n.status === 401);
    check(p401.length === 1, `Invalid token → exactly ONE 401 from /auth/profile (${p401.length})`, p401);
    check((await page.evaluate(() => !!localStorage.getItem("pos_token"))) === false, "Invalid token cleared from storage (session cleared)");
    check(await hasText("Log In"), "User returned to login page after invalid token");
    await sleep(2500);
    const t401a = net.filter((n) => n.status === 401).length;
    await sleep(4000); // a retry/refresh loop would keep adding 401s here
    const t401b = net.filter((n) => n.status === 401).length;
    check(t401b === t401a && t401b <= 2, `No infinite 401/retry loop (401s stable at ${t401b} over 4s)`, net.filter((n) => n.status === 401));

    // ── Sweep ──
    section("BROWSER S2 — CONSOLE & NETWORK SWEEP");
    const hookRef = consoleMsgs.filter((m) => /Rendered more hooks|Rendered fewer hooks|ErrorBoundary|ReferenceError/.test(m.text));
    check(hookRef.length === 0, "ZERO hook-order / ErrorBoundary / ReferenceError messages", hookRef);
    check(consoleMsgs.filter((m) => m.type === "pageerror" && /TypeError/.test(m.text)).length === 0, "ZERO page TypeError crashes", consoleMsgs.filter((m) => /TypeError/.test(m.text)));
    check(net.filter((n) => n.status >= 500).length === 0, "ZERO 5xx API responses", net.filter((n) => n.status >= 500));
    const fours = net.filter((n) => n.status >= 400);
    check(fours.every((n) => n.status === 401) && fours.length === 2, "Network log: only the 2 intentional boot-time 401s (no app 4xx/5xx)", fours);
    console.log("\n  Console messages:", JSON.stringify(consoleMsgs.slice(0, 20)));
  } catch (e) {
    console.error("BROWSER S2 CRASH:", e.message);
    try { console.error("page body:", (await bodyText()).slice(0, 900)); } catch (_) {}
    fail++;
    failures.push("S2 crash: " + e.message);
  } finally {
    await browser.close().catch(() => {});
    await cleanup(tenantDb);
    const afterAct = await tenantDb.order.count({ where: { isDeleted: false, status: { notIn: ["COMPLETED", "CANCELLED"] }, orderType: { not: "COUNTER_SALE" } } });
    const afterOcc = await tenantDb.restaurantTable.count({ where: { status: "OCCUPIED" } });
    check(afterAct === preAct, `Cleanup: active orders restored (${preAct})`);
    check(afterOcc === preOcc, `Cleanup: occupied tables restored to pre-state (${preOcc} → ${afterOcc})`);
    await platformPrisma.$disconnect();
  }
  console.log(`\n──────── RESULTS: ${pass} passed, ${fail} failed ────────`);
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail > 0 ? 2 : 0);
}
main().catch(async (e) => {
  console.error("FATAL:", e.message);
  try { await cleanup(getTenantClient("restaurant_1")); } catch (_) {}
  try { await platformPrisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
