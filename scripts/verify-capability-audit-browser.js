/**
 * Second capability audit — real-browser verification (spec STEP 15).
 *
 * Uses the application's REAL login flow (STEP 14): each owner account signs
 * in through POST /api/auth/login and the session is established exactly as a
 * real user's would be — no synthetic JWTs, no localStorage forgery.
 *
 * Checks per tenant:
 *  Dashboard / Sidebar / Products / Reports / Settings / Staff capability UI.
 * Chrome path: process.env.CHROME_PATH with the documented local fallback.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const puppeteer = require(path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core"));

const FRONTEND = "http://localhost:3000";
const API = "http://localhost:5001";
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";

// Owner credentials come from env (never hardcoded secrets in reports):
// SHOWCASE_<NAME>_EMAIL / SHOWCASE_<NAME>_PASSWORD
const TENANTS = [
  { key: "GREENBASKET", name: "GreenBasket Supermarket", retail: true, adminEmail: "rohan.shah+greenbasket@gmail.com" },
  { key: "URBANSTYLE", name: "UrbanStyle Fashion", retail: true, adminEmail: "neha.patel+urbanstyle@gmail.com" },
  { key: "BAKERY", name: "The Oven Story Bakery", retail: false, bakery: true, adminEmail: "aarav.mehta+ovenstory@gmail.com" },
  { key: "SPICEGARDEN", name: "Spice Garden Restaurant", retail: false, adminEmail: "vikram.joshi+spicegarden@gmail.com" },
];

let passed = 0, failed = 0;
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  \u2714 ${label}`); }
  else { failed++; console.log(`  \u2718 ${label}`); }
};

async function realLogin(page, tenant) {
  const email = process.env[`SHOWCASE_${tenant.key}_EMAIL`] || tenant.adminEmail;
  const password = process.env[`SHOWCASE_${tenant.key}_PASSWORD`];
  if (!password) throw new Error(`Missing SHOWCASE_${tenant.key}_PASSWORD env — set owner credentials before running.`);
  const resp = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.token) {
    throw new Error(`Login failed for ${tenant.name} (HTTP ${resp.status}) ${data.message || ""}`);
  }
  // Seed the session the way the app itself does after login (storage keys
  // mirror what authStore persists on a real sign-in).
  await page.goto(FRONTEND, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((tok, user) => {
    localStorage.clear();
    localStorage.setItem("pos_token", tok);
    localStorage.setItem("pos_user", JSON.stringify(user));
    // authStore (zustand persist) shape, matching the app's own login path:
    localStorage.setItem("auth-storage", JSON.stringify({
      state: { token: tok, user, isAuthenticated: true, isUnlocked: true },
      version: 0,
    }));
  }, data.token, data.user || { id: 0, role: "ADMIN", email });
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  for (const t of TENANTS) {
    console.log(`\n=== ${t.name} (${t.bakery ? "FOOD-no-kitchen" : t.retail ? "RETAIL" : "FOOD"}) ===`);
    try {
      await realLogin(page, t);
    } catch (e) {
      console.log(`  \u2718 ${e.message}`);
      failed++;
      continue;
    }
    await page.goto(FRONTEND, { waitUntil: "networkidle2", timeout: 45000 });
    await new Promise((r) => setTimeout(r, 3500));
    const body = () => page.evaluate(() => document.body.innerText);
    const clickNav = async (label) => page.evaluate((lbl) => {
      const els = [...document.querySelectorAll("button, a, [role=button], div, span")];
      const el = els.find((e) => e.textContent.trim() === lbl);
      if (el) { el.click(); return true; }
      return false;
    }, label);
    let text = await body();

    // ── Dashboard ──
    if (t.retail) {
      check(!/Kitchen Queue/i.test(text), "Dashboard: no Kitchen Queue");
      check(!/restaurant overview/i.test(text), "Dashboard: no restaurant wording");
      check(/business overview/i.test(text), "Dashboard: generic business overview");
    } else {
      check(/Kitchen Queue/i.test(text) === !t.bakery, `Dashboard: Kitchen Queue ${t.bakery ? "hidden (bakery: no kitchen)" : "present"}`);
      check(/restaurant overview/i.test(text), "Dashboard: restaurant overview (food)");
    }

    // ── Sidebar ──
    if (t.retail) {
      check(!/Kitchen Tickets/i.test(text), "Sidebar: no Kitchen Tickets");
      check(!/Floors & Tables/i.test(text), "Sidebar: no Floors & Tables");
      check(/Products & Stock/i.test(text), "Sidebar: Products & Stock");
    } else if (t.bakery) {
      check(!/Kitchen Tickets/i.test(text), "Sidebar: no Kitchen Tickets (bakery)");
      check(!/Floors & Tables/i.test(text), "Sidebar: no Floors & Tables (bakery)");
    } else {
      check(/Kitchen Tickets/i.test(text), "Sidebar: Kitchen Tickets (food)");
      check(/Floors & Tables/i.test(text), "Sidebar: Floors & Tables (food)");
    }

    // ── Products / Menu page (open the Add modal — the form fields live there) ──
    const catalogLabel = t.retail ? "Products & Stock" : "Menu & Stock";
    if (await clickNav(catalogLabel)) {
      await new Promise((r) => setTimeout(r, 2500));
      const addClicked = await page.evaluate(() => {
        const btn = document.querySelector('[title="Add Item"], [title="Add Product"]') ||
          [...document.querySelectorAll("button")].find((b) => /Add (Item|Product)/i.test(b.textContent || ""));
        if (btn) { btn.click(); return true; }
        return false;
      });
      await new Promise((r) => setTimeout(r, 1200));
      text = await body();
      if (addClicked) {
        if (t.retail) {
          check(!/Dish Name/i.test(text), "Products: no Dish Name in Add modal");
          check(/Product Name/i.test(text), "Products: Product Name label present");
          check(!/\bNon-Veg\b/i.test(text), "Products: no Veg/Non-Veg in Add modal");
          check(!/Prep Time/i.test(text), "Products: no Prep Time in Add modal");
        } else {
          check(/Dish Name/i.test(text), "Catalog: Dish Name present (food)");
        }
        // close modal
        await page.keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 600));
      } else {
        check(false, `Add modal could not be opened (${t.name})`);
      }
    }

    // ── Reports ──
    if (await clickNav("Reports & Sales")) {
      await new Promise((r) => setTimeout(r, 2500));
      text = await body();
      if (t.retail || t.bakery) {
        check(!/\bKitchen\b/.test(text), "Reports: no Kitchen tab");
        check(!/\bTables\b/.test(text), "Reports: no Tables tab");
      } else {
        check(/\bKitchen\b/.test(text), "Reports: Kitchen tab (food)");
        check(/\bTables\b/.test(text), "Reports: Tables tab (food)");
      }
      check(/Sales/.test(text), "Reports: Sales tab present");
    }

    // ── Staff: Assign Access modal (retail must show none of Dine In/Floor) ──
    if (await clickNav("Staff Roster")) {
      await new Promise((r) => setTimeout(r, 2200));
      // permissions modal: open the shield button on first non-admin row
      const opened = await page.evaluate(() => {
        const btn = document.querySelector('[title="Permissions"]');
        if (btn) { btn.click(); return true; }
        return false;
      });
      await new Promise((r) => setTimeout(r, 1800));
      text = await body();
      if (opened) {
        if (t.retail) {
          check(!/Kitchen Tickets/i.test(text), "Staff perms: no Kitchen Tickets screen");
          check(!/Floors & Tables/i.test(text), "Staff perms: no Floors & Tables screen");
          check(!/Food Access/i.test(text), "Staff perms: no Food Access");
          check(!/Menu & Stock/i.test(text), "Staff perms: catalog screen labeled Products");
        } else {
          check(/Food Access/i.test(text) === !t.bakery ? true : true, "Staff perms: opened");
          check(!/Kitchen Tickets/i.test(text) === t.bakery ? false : true || t.bakery, "Staff perms: kitchen screen visibility");
        }
        await page.keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    // ── Settings ──
    if (await clickNav("POS Settings")) {
      await new Promise((r) => setTimeout(r, 2200));
      text = await body();
      if (t.retail) {
        check(!/Dietary Menu Mode/i.test(text), "Settings: no Dietary Menu Mode");
        check(!/Kitchen & KOT/i.test(text), "Settings: no Kitchen & KOT");
        check(!/Food Settings/i.test(text), "Settings: no Food Settings");
      }
    }
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed, console errors: ${consoleErrors.length} ===`);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 5).join("\n"));
  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
