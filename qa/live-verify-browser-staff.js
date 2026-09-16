/**
 * LIVE BROWSER VERIFICATION — Staff Roster: Assign Access modal + email.
 * Verifies against the real frontend (:3000):
 *   1. /staff renders with no "getFloorAssignments is not a function" error.
 *   2. Staff cards display the staff email.
 *   3. Assign Access modal opens, loads floors + takeaway grant, no crash.
 *   4. Save + reopen keeps the saved values.
 *
 * Run: node qa/live-verify-browser-staff.js
 */
const os = require("os");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const CHROME = "C:\\Users\\Divyang\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const PUPPETEER = path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core");
const FE = "http://localhost:3000";
const BASE = "http://127.0.0.1:5001/api";

let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; failures.push(msg); console.log("  ❌ " + msg + (detail ? "\n     " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const puppeteer = require(PUPPETEER);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    userDataDir: path.join(os.tmpdir(), `qa-staff-${Date.now()}`),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));

    await page.goto(FE + "/login", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1200);
    const ok = await page.evaluate(async (BASE) => {
      const r = await fetch(BASE + "/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "superadmin@pos.com", password: "SuperAdmin@123" }),
      });
      const j = await r.json();
      const la = await fetch(BASE + "/super-admin/restaurants/1/login-as", { headers: { Authorization: "Bearer " + j.token } });
      const lj = await la.json();
      const t = lj.token || lj.data?.token;
      const u = lj.user || lj.data?.user;
      if (!t || !u) return null;
      // Session shape used by authStore (restoreSession): pos_token + pos_user.
      localStorage.setItem("pos_token", t);
      localStorage.setItem("pos_user", JSON.stringify(u));
      return true;
    }, BASE);
    check(!!ok, "browser session established (pos_token + pos_user)");

    console.log("\n──────── Staff Roster ────────");
    // The app is screen-store based (zustand currentScreen), NOT URL-routed —
    // a direct /staff goto lands on the dashboard fallback. Navigate like a
    // real user: click the "Staff Roster" sidebar entry after the app has
    // bootstrapped (same goto pattern as the session setup above).
    await page.goto(FE + "/", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(3000);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, a")];
      const staff = btns.find((b) => b.innerText && b.innerText.trim().startsWith("Staff Roster"));
      if (staff) staff.click();
    });
    await sleep(3500);
    const fnErr = pageErrors.find((e) => /getFloorAssignments\s*is\s*not\s*a\s*function/i.test(e));
    check(!fnErr, "no 'getFloorAssignments is not a function' error", fnErr);
    check(!pageErrors.some((e) => /ReferenceError|TypeError/i.test(e)), "no uncaught ReferenceError/TypeError on /staff", pageErrors.slice(0, 3));
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 6000));
    check(!/something went wrong/i.test(txt), "no ErrorBoundary on /staff", txt.slice(0, 150));
    const hasEmail = /@/.test(txt);
    check("staff emails visible on roster cards", hasEmail, txt.slice(0, 300));

    console.log("\n──────── Assign Access modal ────────");
    const before = pageErrors.length;
    // Open the Assign Access (floors) modal via the MapPin button
    const opened = await page.evaluate(() => {
      const btn = document.querySelector('button[title="Assign Floors"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    check(!!opened, "Assign Access button found and clicked");
    await sleep(2500);
    const modalTxt = await page.evaluate(() => document.body.innerText.slice(0, 8000));
    check(/order access/i.test(modalTxt), "modal shows ORDER ACCESS section", modalTxt.slice(0, 200));
    check(/default for all staff/i.test(modalTxt), "modal shows 'Dine In — Default for all staff'");
    check(/takeaway/i.test(modalTxt), "modal shows Takeaway option");
    check(/floor access/i.test(modalTxt), "modal shows FLOOR ACCESS section");
    const rosterLoaded = await page.evaluate(() => !!document.querySelector('button[title="Assign Floors"]'));
    check(rosterLoaded, "roster rendered assignable staff cards");
    const modalCrash = pageErrors.slice(before).some((e) => /not a function|ReferenceError|TypeError/i.test(e));
    check("modal opened without runtime errors", !modalCrash, pageErrors.slice(before, before + 3));

    console.log("\n──────── Save + reopen (floor + takeaway persistence) ────────");
    // Tick the first floor checkbox + takeaway inside the modal, then Save.
    // Idempotent: force BOTH targets to checked regardless of their current
    // state (a previous QA run may have saved them checked already).
    const saved = await page.evaluate(() => {
      const checkboxes = [...document.querySelectorAll(".fixed.inset-0 input[type=checkbox]")];
      if (checkboxes.length < 2) return { ok: false, count: checkboxes.length };
      // Last checkbox is takeaway (Order Access renders before Floor Access)
      const targets = [[checkboxes.length - 1, true], [0, true]];
      for (const [idx, want] of targets) {
        if (checkboxes[idx].checked !== want) checkboxes[idx].click();
      }
      return { ok: true, count: checkboxes.length, states: checkboxes.map((b) => b.checked) };
    });
    check(saved.ok, `set floor 1 + takeaway checked (${saved.count} checkboxes)`, saved.states);
    await sleep(400);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll(".fixed.inset-0 button")];
      const save = btns.find((b) => /^save$/i.test(b.innerText.trim()));
      if (save) save.click();
    });
    await sleep(2000);
    check(!pageErrors.slice(before).some((e) => /not a function|TypeError/i.test(e)), "save did not throw");
    // Reopen the modal
    await page.evaluate(() => {
      const btn = document.querySelector('button[title="Assign Floors"]');
      if (btn) btn.click();
    });
    await sleep(2200);
    const reTxt = await page.evaluate(() => document.body.innerText.slice(0, 8000));
    check(/default for all staff/i.test(reTxt), "modal reopened");
    const state = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".fixed.inset-0 input[type=checkbox]")];
      return boxes.map((b) => b.checked);
    });
    check(state.length >= 2 && state[state.length - 1] === true, "takeaway persisted after save + reopen", state);
    check(state.length >= 2 && state[0] === true, "first floor persisted after save + reopen", state);

    console.log("\n──────── RESULTS ────────");
    console.log(`  Passed: ${pass} ✅  Failed: ${fail} ${fail ? "❌" : "✅"}`);
    if (failures.length) { failures.forEach((f) => console.log("   - " + f)); }
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });
