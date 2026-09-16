/**
 * Browser verification for the four showcase tenants.
 * For each: restore a real session (JWT via the app's own storage keys),
 * confirm the tenant dashboard shows the right business name + plan, check
 * sidebar navigation matches the business mode, and open the POS screen.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const puppeteer = require(path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core"));
const jwt = require("jsonwebtoken");

const FRONTEND_URL = "http://localhost:3000";
const CHROME = "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TENANTS = [
  { userId: 22, restaurantId: 512, name: "The Oven Story Bakery", email: "aarav.mehta+ovenstory@gmail.com", mode: "BASIC_POS", plan: "Basic POS", posLabel: "POS Ordering", banned: ["Floors & Tables", "Kitchen Tickets"] },
  { userId: 23, restaurantId: 513, name: "GreenBasket Supermarket", email: "rohan.shah+greenbasket@gmail.com", mode: "BASIC_POS", plan: "Basic POS", posLabel: "POS Ordering", banned: ["Floors & Tables", "Kitchen Tickets"] },
  { userId: 24, restaurantId: 514, name: "UrbanStyle Fashion", email: "neha.patel+urbanstyle@gmail.com", mode: "BASIC_POS", plan: "Basic POS", posLabel: "POS Ordering", banned: ["Floors & Tables", "Kitchen Tickets"] },
  { userId: 25, restaurantId: 515, name: "Spice Garden Restaurant", email: "vikram.joshi+spicegarden@gmail.com", mode: "RESTAURANT", plan: "Premium", posLabel: "POS Ordering", banned: [] },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
    defaultViewport: { width: 1440, height: 900 },
  });

  let allOk = true;
  for (const t of TENANTS) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

    const results = [];
    const check = (ok, name) => { results.push(ok); console.log(`  ${ok ? "✔" : "✘"} ${name}`); };

    // Load app, seed real session
    await page.goto(FRONTEND_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1200);
    await page.evaluate((payload) => {
      localStorage.setItem("pos_token", payload.token);
      localStorage.setItem("pos_user", JSON.stringify(payload.user));
    }, {
      // JWT payload mirrors a real login: platform ADMIN id + restaurantId claim.
      token: jwt.sign({ id: t.userId, role: "ADMIN", email: t.email, restaurantId: t.restaurantId }, process.env.JWT_SECRET, { expiresIn: "15m" }),
      user: { id: t.userId, name: t.name, email: t.email, role: "ADMIN", restaurantId: t.restaurantId },
    });
    await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await sleep(7000);

    console.log(`\n══ ${t.name} (${t.mode}) ══`);

    const text = await page.evaluate(() => document.body.innerText);

    // Dashboard identity (sidebar may render the name uppercase via CSS)
    check(text.toLowerCase().includes(t.name.toLowerCase()), `dashboard shows "${t.name}"`);
    check(/Good (Morning|Afternoon|Evening)/i.test(text) || /DASHBOARD|Overview/i.test(text), "dashboard rendered");

    // Plan badge (sidebar footer shows plan name + days)
    check(text.includes(t.plan), `plan visible: ${t.plan}`);

    // Navigation per mode
    check(text.includes(t.posLabel), `sidebar shows "${t.posLabel}"`);
    for (const banned of t.banned) {
      check(!text.includes(banned), `sidebar hides "${banned}"`);
    }
    if (t.mode === "RESTAURANT") {
      check(text.includes("Floors & Tables"), "restaurant: Floors & Tables visible");
      check(text.includes("Kitchen Tickets"), "restaurant: Kitchen Tickets visible");
    }

    // Open POS
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, a")];
      const el = btns.find((b) => b.textContent.trim().includes("POS Ordering"));
      if (el) { el.click(); return true; }
      return false;
    });
    await sleep(4000);
    const posText = await page.evaluate(() => document.body.innerText);
    check(clicked, "POS Ordering opened");
    const posLooksRight = t.mode === "BASIC_POS"
      ? /Counter Sale|SCAN BARCODE/i.test(posText)
      : /Table|Floor|Select a category|Dine In/i.test(posText);
    check(posLooksRight, t.mode === "BASIC_POS" ? "POS shows Counter Sale / scan UI" : "POS shows restaurant table/category UI");

    const appErrors = consoleErrors.filter((e) => !/favicon|net::ERR_FAILED|manifest|Failed to load resource.*(404|403|400)/i.test(e));
    check(appErrors.length === 0, `zero console errors (${appErrors.length})`);
    appErrors.slice(0, 3).forEach((e) => console.log("     · " + e.slice(0, 140)));

    await page.screenshot({ path: path.join(__dirname, `showcase-${t.restaurantId}.png`) });
    await page.close();
    if (results.some((r) => !r)) allOk = false;
  }

  await browser.close();
  console.log(`\n${allOk ? "✅ ALL TENANTS VERIFIED" : "❌ SOME CHECKS FAILED"}`);
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("browser verification crashed:", e.message, "\n", e.stack); process.exit(1); });
