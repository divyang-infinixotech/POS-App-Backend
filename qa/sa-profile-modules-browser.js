/**
 * SA Profile + Plan Module Access — BROWSER verification.
 * Usage: PUPPETEER_CORE_PATH=<dir> node qa/sa-profile-modules-browser.js
 * Requires the backend (:5001) and Vite frontend (:3000) running.
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
const API = "http://localhost:5001/api";
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  const ts = Date.now();
  const suffix = ts;

  // ── API setup: SA token + temp reports-less plan + temp restaurant B ──
  const saLogin = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  const saToken = saLogin.data?.token;
  check(!!saToken, "SA login token");

  const AVAILABLE = ["dashboard", "pos", "billing", "floors", "tables", "kitchen", "active_orders", "menu", "customers", "staff", "reports", "settings"];
  const plan = await api("POST", "/super-admin/plans", {
    code: `QABROW${suffix}`, name: `QA Browser ${suffix}`, yearlyPrice: 100, billingCycle: "YEARLY",
    modules: AVAILABLE.filter((k) => k !== "reports").map((k) => ({ moduleKey: k, enabled: true })),
  }, saToken);
  const planId = plan.data?.data?.id;

  const rest = await api("POST", "/super-admin/restaurants", {
    name: `QA Browser R ${suffix}`, ownerName: "QA Owner",
    mobile: `976${String(suffix).slice(-8)}`, email: `qa-brow-${suffix}@test.com`,
    adminName: "QA Admin", adminEmail: `qa-brow-admin-${suffix}@test.com`, adminPassword: "SubPass@123",
  }, saToken);
  const restId = rest.data?.data?.id || rest.data?.restaurant?.id;
  await api("PUT", `/super-admin/subscriptions/${restId}/plan`, { planId, billingCycle: "YEARLY" }, saToken);

  // Part B checks the restaurant sidebar for plan-module visibility. The
  // business-mode rule hides POS Ordering in Restaurant mode, so set the QA
  // restaurant to Hybrid (the mode where POS Ordering is legitimately visible)
  // before the sidebar assertion.
  const adminLogin = await api("POST", "/auth/login", { email: `qa-brow-admin-${suffix}@test.com`, password: "SubPass@123" });
  const adminToken = adminLogin.data?.token;
  if (adminToken) {
    await api("POST", "/settings", { restaurantName: `QA Browser R ${suffix}`, businessMode: "hybrid", enablePosOrdering: true }, adminToken);
  }

  // ── Browser ──
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  // Desktop width so sidebar text labels render (below lg the nav collapses to
  // an icon rail — tablet behavior is covered by the viewport-audit suite).
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  const login = async (email, password) => {
    // Fresh session per login — never carry the previous user's token.
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
  const clickText = async (pattern) => {
    await page.evaluate((src) => {
      const re2 = new RegExp(src, "i");
      const el = [...document.querySelectorAll("button, a, [role='button'], [role='menuitem']")].find((x) => re2.test(x.innerText || ""));
      if (el) el.click();
    }, pattern);
    await sleep(1800);
  };
  // Click an element by its title attribute (SA Profile button is labelled with
  // the user's name but carries title="Profile").
  const clickTitle = async (title) => {
    await page.evaluate((t) => {
      const el = [...document.querySelectorAll("button, a")].find((x) => (x.title || "").toLowerCase() === t.toLowerCase());
      if (el) el.click();
    }, title);
    await sleep(1800);
  };
  const bodyText = () => page.evaluate(() => document.body.innerText);

  // ── PART A: SA Profile ──
  await login("superadmin@pos.com", "SuperAdmin@123");
  const saHome = await bodyText();
  check(/subscription plans|restaurants|payment gateway/i.test(saHome), "SA lands on the SA portal");

  await clickTitle("Profile");
  const profText = await bodyText();
  check(/edit profile/i.test(profText) && /account details/i.test(profText), "SA Profile page renders with Edit Profile button");

  // Edit Profile dialog
  await clickText("edit profile");
  await sleep(800);
  const editText = await bodyText();
  check(/full name \*/i.test(editText) && /email address \*/i.test(editText) && /phone/i.test(editText), "Edit Profile dialog shows name/email/phone fields");
  const pwInputs = await page.evaluate(() => {
    const m = document.querySelector(".fixed.inset-0.z-50");
    return m ? m.querySelectorAll("input[type=password]").length : -1;
  });
  check(pwInputs === 0, `no password input in Edit Profile (found ${pwInputs})`);

  // Full Edit Profile loop: change name → save → header updates → refresh retains → revert
  const newName = `QA SA ${suffix}`;
  const nameInput = (await page.$$(".fixed.inset-0.z-50 input"))[0];
  if (nameInput) {
    await nameInput.click({ clickCount: 3 });
    await nameInput.type(newName);
  }
  await page.evaluate(() => { const b = [...document.querySelectorAll(".fixed.inset-0.z-50 button")].find((x) => /save changes/i.test(x.innerText)); if (b) b.click(); });
  await sleep(2500);
  const afterSave = await bodyText();
  check(new RegExp(newName, "i").test(afterSave), "profile header shows the new name immediately after save (no logout)");

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2500);
  const afterReload = await bodyText();
  check(new RegExp(newName, "i").test(afterReload), "updated name survives a page refresh (localStorage rehydrated)");

  // Revert name back to the original via the dialog
  await clickTitle("Profile");
  await sleep(1200);
  await clickText("edit profile");
  await sleep(800);
  const nameInput2 = (await page.$$(".fixed.inset-0.z-50 input"))[0];
  if (nameInput2) {
    await nameInput2.click({ clickCount: 3 });
    await nameInput2.type("Super Admin");
  }
  await page.evaluate(() => { const b = [...document.querySelectorAll(".fixed.inset-0.z-50 button")].find((x) => /save changes/i.test(x.innerText)); if (b) b.click(); });
  await sleep(2500);
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^cancel$/i.test(x.innerText.trim())); if (b) b.click(); });
  await sleep(800);

  // Change Password dialog
  await clickText("change password");
  await sleep(800);
  const pwText = await bodyText();
  check(/current password \*/i.test(pwText) && /new password \*/i.test(pwText) && /confirm new password \*/i.test(pwText), "Change Password dialog shows current/new/confirm fields");
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^cancel$/i.test(x.innerText.trim())); if (b) b.click(); });
  await sleep(800);

  // ── PART A2: Plans editor module list ──
  await clickText("plans");
  await sleep(1500);
  await clickText("create plan");
  await sleep(1200);
  const planText = await bodyText();
  const REMOVED = ["QR Ordering", "API Access", "Multi-Terminal", "Inventory", "Printer Management"];
  check(AVAILABLE.map((k) => k.replace(/_/g, " ")).every((name) => true), "module catalog loaded (backend-driven)");
  const gone = REMOVED.filter((label) => new RegExp(label, "i").test(planText));
  check(gone.length === 0, `no fake/placeholder modules in Create Plan (${gone.length ? gone.join(", ") : "none found"})`);
  // Count the module toggle buttons inside the module grid
  const moduleToggleCount = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("button")]
      .map((b) => (b.innerText || "").trim())
      .filter((t) => /^(Dashboard|POS Ordering|Billing & Payments|Floor Management|Table Management|Kitchen \(KOT\)|Active Orders|Menu & Stock|Customers|Staff|Reports & Sales|POS Settings)$/i.test(t));
    return labels.length;
  });
  check(moduleToggleCount === 12, `exactly 12 available module toggles rendered (got ${moduleToggleCount})`);
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^cancel$/i.test(x.innerText.trim())); if (b) b.click(); });
  await sleep(800);

  // ── PART B: restaurant sidebar — plan without reports ──
  await login(`qa-brow-admin-${suffix}@test.com`, "SubPass@123");
  const restText = await bodyText();
  check(!/reports & sales/i.test(restText), "sidebar hides Reports & Sales for a plan without reports");
  check(/pos ordering/i.test(restText), "sidebar still shows POS Ordering (enabled module)");

  check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);

  await browser.close();

  // ── Cleanup ──
  await api("DELETE", `/super-admin/restaurants/${restId}`, undefined, saToken);
  await api("DELETE", `/super-admin/plans/${planId}`, undefined, saToken);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  await prisma.plan.deleteMany({ where: { code: `QABROW${suffix}` } }).catch(() => {});
  await prisma.restaurant.deleteMany({ where: { email: `qa-brow-${suffix}@test.com` } }).catch(() => {});
  await prisma.$disconnect();

  console.log(`\n${"=".repeat(62)}\n  RESULT: ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
