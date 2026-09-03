/**
 * LIVE BROWSER VERIFICATION — S1 (ADMIN merge/split UI flows).
 * Frontend :3000, real backend :5001 + DB, real Chrome.
 *
 * Fixture: two DINE_IN orders on two tables created via the backend API before
 * the run and fully removed afterwards (tables/stock restored).
 *
 * Usage: node qa/live-verify-browser.js
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

const created = { orderIds: [], groupIds: [], tablesUsed: [], menuStockBefore: {} };
async function cleanup(tenantDb) {
  for (const gid of created.groupIds) {
    try { await tenantDb.mergeGroupTable.deleteMany({ where: { mergeGroupId: gid } }); await tenantDb.mergeGroup.deleteMany({ where: { id: gid } }); } catch (_) {}
  }
  const ids = created.orderIds;
  if (ids.length) {
    try {
      await tenantDb.stockMovement.deleteMany({ where: { orderId: { in: ids } } });
      const kots = await tenantDb.kOT.findMany({ where: { orderId: { in: ids } }, select: { id: true } });
      const kIds = kots.map((k) => k.id);
      if (kIds.length) { await tenantDb.kOTItem.deleteMany({ where: { kotId: { in: kIds } } }); await tenantDb.kOT.deleteMany({ where: { id: { in: kIds } } }); }
      await tenantDb.mergeGroupTable.deleteMany({ where: { originalOrderId: { in: ids } } });
      await tenantDb.bill.deleteMany({ where: { orderId: { in: ids } } });
      await tenantDb.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await tenantDb.order.deleteMany({ where: { id: { in: ids } } });
    } catch (e) { console.error("cleanup orders:", e.message); }
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
  check(!!adminToken, "Golden Grill ADMIN login-as token obtained");

  const preAct = await tenantDb.order.count({ where: { isDeleted: false, status: { notIn: ["COMPLETED", "CANCELLED"] }, orderType: { not: "COUNTER_SALE" } } });
  const preOcc = await tenantDb.restaurantTable.count({ where: { status: "OCCUPIED" } });
  const tables = await tenantDb.restaurantTable.findMany({ where: { status: "AVAILABLE" }, orderBy: { tableNo: "asc" }, take: 2, select: { id: true, tableNo: true } });
  const items = await tenantDb.menuItem.findMany({ where: { isAvailable: true, currentStock: { gt: 10 } }, orderBy: { id: "asc" }, take: 2 });
  check(tables.length === 2 && items.length === 2, `Fixture source: ${tables.map((t) => t.tableNo).join(",")} / items ${items.map((i) => i.id).join(",")}`);
  created.tablesUsed = tables.map((t) => t.id);
  items.forEach((i) => { created.menuStockBefore[i.id] = i.currentStock; });
  const [t1, t2] = tables.map((t) => t.id);
  const [m1, m2] = items;
  const r1 = await api("POST", "/orders", { orderType: "DINE_IN", tableId: t1, items: [{ menuItemId: m1.id, quantity: 1 }] }, adminToken);
  const r2 = await api("POST", "/orders", { orderType: "DINE_IN", tableId: t2, items: [{ menuItemId: m2.id, quantity: 1 }] }, adminToken);
  const o1 = r1.data?.data, o2 = r2.data?.data;
  check(!!o1?.id && !!o2?.id, `Fixture orders created (${o1?.orderNo}, ${o2?.orderNo})`);
  created.orderIds.push(o1.id, o2.id);

  const puppeteer = require(PUPPETEER);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--disable-extensions", "--disable-background-networking", "--window-size=1440,900"],
    userDataDir: path.join(os.tmpdir(), "lv-s1-" + Date.now()),
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
  const appErrs = () => consoleMsgs.filter((m) => /Rendered more hooks|Rendered fewer hooks|Error Boundary caught|ReferenceError|is not defined|Cannot read propert|splitLoading/.test(m.text));
  async function waitForText(text, timeout = 15000) { await page.waitForFunction((t) => document.body && document.body.innerText.includes(t), { timeout }, text); }
  async function clickByText(text, opts = {}) {
    const { exact = false, timeout = 10000 } = opts;
    await page.waitForFunction((t, ex) => {
      const els = [...document.querySelectorAll("button, [role=button], li, a")];
      const el = els.find((e) => {
        const v = e.textContent.replace(/\s+/g, " ").trim();
        const hit = ex ? v === t : v.includes(t);
        if (!hit) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < innerHeight && r.left < innerWidth;
      });
      if (el) { el.click(); return true; }
      return false;
    }, { timeout }, text, exact);
  }

  try {
    section("BROWSER S1 — ADMIN merge/split UI flows (live)");
    await page.goto(FE, { waitUntil: "networkidle2", timeout: 45000 });
    await page.evaluate((t) => { localStorage.setItem("pos_token", t); }, adminToken);
    await page.reload({ waitUntil: "networkidle2", timeout: 45000 });
    await sleep(4000);
    const bootTxt = await bodyText();
    check(bootTxt.includes("Overview") || bootTxt.includes("Dashboard") || netFilter("GET", "/auth/profile").length > 0, "Admin session booted (restoreSession/profile OK)");
    check(appErrs().length === 0, "No hook/ReferenceError/ErrorBoundary errors during admin boot", appErrs());

    await clickByText("Floors & Tables");
    await waitForText("Restaurant Floors & Tables", 20000);
    await sleep(1500);
    check(appErrs().length === 0, "Floors & Tables screen loads without app errors", appErrs());

    await clickByText("Merge Tables");
    await waitForText("Combine occupied tables into one group", 15000);
    await sleep(1500);
    check(appErrs().length === 0, "TableMergeModal opens with ZERO hook/ReferenceError/ErrorBoundary errors", appErrs());

    const pickTable = async (no) => {
      await page.evaluate((n) => {
        const btns = [...document.querySelectorAll("button")].filter((b) => b.textContent.includes(`Table ${n}`) && b.getBoundingClientRect().width > 0);
        if (btns[0]) btns[0].click();
      }, no);
      await sleep(350);
    };
    await pickTable(tables[0].tableNo);
    await pickTable(tables[1].tableNo);
    await sleep(600);
    // The confirm button is disabled until 2+ tables are selected — wait for it
    // to become enabled, which is the authoritative check that both were picked.
    let mergeBtnReady = false;
    for (let i = 0; i < 20; i++) {
      mergeBtnReady = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.replace(/\s+/g, " ").trim() === "Merge 2 Tables");
        return !!b && !b.disabled;
      });
      if (mergeBtnReady) break;
      await sleep(500);
    }
    check(mergeBtnReady, "Both candidate tables selected in merge modal (Merge 2 Tables enabled)");

    let mergePostTotal = 0, splitPostTotal = 0;
    net.splice(0, net.length);
    await clickByText("Merge 2 Tables", { exact: true });
    let merged = false;
    for (let i = 0; i < 30; i++) { if (netFilter("POST", "/merge").length > 0) { merged = true; break; } await sleep(500); }
    const mp = netFilter("POST", "/merge");
    check(merged && mp.length === 1, `UI merge → exactly ONE POST /orders/:id/merge (${mp.length})`, mp);
    mergePostTotal += mp.length;
    check(mp.every((n) => n.status === 200), "Merge POST returned 200", mp);
    await sleep(2200);
    check(appErrs().length === 0, "No app errors during merge execution", appErrs());

    const tblChk = (await api("GET", "/tables", null, adminToken)).data?.tables || [];
    const tt1 = tblChk.find((t) => t.id === t1);
    const tt2 = tblChk.find((t) => t.id === t2);
    check(tt1?.isMerged === true && tt2?.isMerged === true && tt1?.mergeGroupId === tt2?.mergeGroupId, "Both tables merged in backend (UI merge persisted)");
    if (tt1?.mergeGroupId) created.groupIds.push(tt1.mergeGroupId);

    // Reload page — merged state must survive
    await page.reload({ waitUntil: "networkidle2", timeout: 45000 });
    await sleep(3000);
    await clickByText("Floors & Tables");
    await waitForText("Restaurant Floors & Tables", 20000);
    await sleep(1500);
    await clickByText("Split Tables");
    let noGroups = false, hasUnmerge = false;
    for (let i = 0; i < 20; i++) {
      const t = await bodyText();
      if (t.includes("Split / Unmerge")) hasUnmerge = true;
      if (t.includes("No active merged groups")) noGroups = true;
      await sleep(300);
    }
    check(hasUnmerge && !noGroups, "Merged group still present after FULL PAGE RELOAD (Split Tables modal lists it)");
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Close"); if (b) b.click(); });
    await sleep(500);

    // Active Orders split (TEST 5)
    await clickByText("Active Orders");
    await waitForText("(Merged:", 20000);
    await sleep(1500);
    const aoText = await bodyText();
    check(!/NaN|undefined|NaNh|NaNm/.test(aoText), "No NaN/undefined/NaNh/NaNm text in Active Orders");
    check(aoText.includes("(Merged:"), "Active order card shows merged tables");
    net.splice(0, net.length);
    await clickByText("Split", { exact: true });
    let sd = false;
    for (let i = 0; i < 30; i++) { if (netFilter("POST", "/orders/split").length > 0) { sd = true; break; } await sleep(500); }
    const sp1 = netFilter("POST", "/orders/split");
    check(sd && sp1.length === 1, `Active Orders Split → exactly ONE POST /orders/split (${sp1.length})`, sp1);
    splitPostTotal += sp1.length;
    check(sp1.every((n) => n.status === 200), "Split POST returned 200", sp1);
    check(appErrs().length === 0, "NO ReferenceError (splitLoading) / ErrorBoundary on Active Orders split", appErrs());
    await sleep(3000);
    const tblChk2 = (await api("GET", "/tables", null, adminToken)).data?.tables || [];
    check(tblChk2.find((t) => t.id === t1)?.isMerged === false && tblChk2.find((t) => t.id === t2)?.isMerged === false, "Split from Active Orders un-merged both tables (backend)");

    // Re-merge via UI then split via Split Tables modal + explicit confirmation (TEST 6/8)
    await clickByText("Floors & Tables");
    await waitForText("Restaurant Floors & Tables", 20000);
    await sleep(1500);
    await clickByText("Merge Tables");
    await waitForText("Combine occupied tables into one group", 15000);
    await sleep(1200);
    await pickTable(tables[0].tableNo);
    await pickTable(tables[1].tableNo);
    await sleep(600);
    net.splice(0, net.length);
    await clickByText("Merge 2 Tables");
    let merged2 = false;
    for (let i = 0; i < 30; i++) { if (netFilter("POST", "/merge").length > 0) { merged2 = true; break; } await sleep(500); }
    const mp2 = netFilter("POST", "/merge");
    check(merged2 && mp2.length === 1, `Second UI merge → one POST /orders/:id/merge (${mp2.length})`, mp2);
    mergePostTotal += mp2.length;
    await sleep(2500);
    const tblChk3 = (await api("GET", "/tables", null, adminToken)).data?.tables || [];
    const g2 = tblChk3.find((t) => t.id === t1)?.mergeGroupId;
    check(!!g2, "Second merge created a group (backend)");
    if (g2) created.groupIds.push(g2);

    await page.reload({ waitUntil: "networkidle2", timeout: 45000 });
    await sleep(3000);
    await clickByText("Floors & Tables");
    await waitForText("Restaurant Floors & Tables", 20000);
    await sleep(1500);
    await clickByText("Split Tables");
    let hasSplitBtn = false;
    for (let i = 0; i < 20; i++) { if ((await bodyText()).includes("Split / Unmerge")) { hasSplitBtn = true; break; } await sleep(300); }
    check(hasSplitBtn, "Merge state survives second full reload");
    net.splice(0, net.length);
    await clickByText("Split / Unmerge");
    await waitForText("Split Tables?", 10000);
    await sleep(500);
    await clickByText("Split", { exact: true });
    let sd2 = false;
    for (let i = 0; i < 30; i++) { if (netFilter("POST", "/orders/split").length > 0) { sd2 = true; break; } await sleep(500); }
    const sp2 = netFilter("POST", "/orders/split");
    check(sd2 && sp2.length === 1, `Split Tables modal → exactly ONE POST /orders/split (${sp2.length})`, sp2);
    splitPostTotal += sp2.length;
    check(sp2.every((n) => n.status === 200), "Split POST returned 200", sp2);
    await sleep(3000);
    const tblChk4 = (await api("GET", "/tables", null, adminToken)).data?.tables || [];
    const f1 = tblChk4.find((t) => t.id === t1);
    const f2b = tblChk4.find((t) => t.id === t2);
    check(f1?.isMerged === false && f2b?.isMerged === false && f1?.mergeGroupId === null, "Tables split again after modal split (backend)");
    check(appErrs().length === 0, "No app errors in the Split Tables UI flow", appErrs());
    check(mergePostTotal === 2, `Exactly two merge POSTs total across flows (${mergePostTotal})`);
    check(splitPostTotal === 2, `Exactly two split POSTs total across flows (${splitPostTotal})`);

    const allBad = net.filter((n) => n.status >= 400 && !n.url.includes("/auth/login"));
    check(allBad.length === 0, "No failed API requests during admin UI flows", allBad);
    section("BROWSER S1 — CONSOLE SWEEP");
    const hookRef = consoleMsgs.filter((m) => /Rendered more hooks|Rendered fewer hooks|ErrorBoundary|ReferenceError/.test(m.text));
    check(hookRef.length === 0, "ZERO hook-order / ErrorBoundary / ReferenceError messages", hookRef);
    check(consoleMsgs.filter((m) => m.type === "pageerror" && /TypeError/.test(m.text)).length === 0, "ZERO page TypeError crashes", consoleMsgs.filter((m) => /TypeError/.test(m.text)));
    console.log("\n  Console messages:", JSON.stringify(consoleMsgs.slice(0, 15)));
  } catch (e) {
    console.error("BROWSER S1 CRASH:", e.message);
    try { console.error("page body:", (await bodyText()).slice(0, 800)); } catch (_) {}
    fail++;
    failures.push("S1 crash: " + e.message);
  } finally {
    await browser.close().catch(() => {});
    await cleanup(tenantDb);
    const afterAct = await tenantDb.order.count({ where: { isDeleted: false, status: { notIn: ["COMPLETED", "CANCELLED"] }, orderType: { not: "COUNTER_SALE" } } });
    const afterOcc = await tenantDb.restaurantTable.count({ where: { status: "OCCUPIED" } });
    check(afterAct === preAct, `Cleanup: Golden Grill active orders restored (${preAct})`);
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
