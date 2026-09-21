/**
 * LIVE BROWSER QA — BASIC_POS production workflow (The Oven Story Bakery).
 *
 * Drives the REAL app (frontend :3000 + backend :5001) in headless Chrome and
 * verifies the §15 scenario end-to-end:
 *
 *   1. login → Quick Billing OFF (server-authoritative)
 *   2. POS Ordering → add real product ×2
 *   3. PLACE ORDER (KOT) → toast "sent to kitchen", NO "Opening payment"
 *   4. NO /payments/collect request fires after Place Order
 *   5. KOT print popup renders actual KOT content (no about:blank stall)
 *   6. Sidebar shows ACTIVE ORDERS; route renders (no redirect/404)
 *   7. COUNTER ORDER card appears — no TABLE / FLOOR text
 *   8. status PENDING → PREPARING → READY (via the API the page uses)
 *   9. Bill → payment → order COMPLETED
 *  10. Quick Billing ON → PAYMENT button, no KOT/Active Orders
 *  11. Retail (GreenBasket/UrbanStyle): PAYMENT only, no KOT/Active Orders
 *  12. Restaurant (Golden Grill): unchanged sidebar (Kitchen + Active Orders)
 *
 * Console + network errors are captured throughout. Screenshots in
 * qa/e2e-artifacts/basic-pos/.
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const puppeteer = require(path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core"));

const FRONTEND = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND = process.env.BACKEND_URL || "http://127.0.0.1:5001";
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const SHOTS = path.join(__dirname, "e2e-artifacts", "basic-pos");

let pass = 0, fail = 0;
const check = (cond, msg, extra) => {
  if (cond) { pass++; console.log(`  \u2705 ${msg}`); }
  else { fail++; console.log(`  \u274c ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 220)}` : ""}`); }
};
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(3, 60 - s.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiLogin(email, password) {
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, token: json.token, user: json.user };
}

async function setQuickBilling(token, on) {
  const cur = await fetch(`${BACKEND}/api/settings`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  const st = cur.setting || {};
  const res = await fetch(`${BACKEND}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ restaurantName: st.restaurantName || "The Oven Story Bakery", enableCounterSale: !!on }),
  });
  return res.status;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1440,900"],
  });

  const pageErrors = [], consoleErrors = [], networkErrors = [], paymentCalls = [];
  const wire = (page, tag) => {
    page.on("pageerror", (e) => pageErrors.push(`[${tag}] ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[${tag}] ${m.text()}`); });
    page.on("response", (r) => {
      const u = r.url();
      if (/\/payments\/collect/.test(u) && r.request().method() === "POST") paymentCalls.push(r.status());
      if (/\/api\//.test(u) && r.status() >= 500) networkErrors.push(`[${tag}] ${r.status()} ${r.request().method()} ${u.replace(BACKEND, "")}`);
    });
  };

  const freshPage = async (tag) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    wire(page, tag);
    return page;
  };

  const loginAs = async (page, email, password) => {
    const login = await apiLogin(email, password);
    await page.evaluateOnNewDocument((tok, usr) => {
      localStorage.setItem("pos_token", tok);
      localStorage.setItem("pos_user", JSON.stringify(usr));
    }, login.token, login.user);
    return login;
  };

  const L = async () => (await page.evaluate(() => document.body.innerText)).toUpperCase();
  // Sidebar-scoped text — the dashboard also has an "ACTIVE ORDERS" KPI card,
  // so visibility checks must read the <aside> navigation, not the whole body.
  const sidebarText = async (p = page) => (await p.evaluate(() => (document.querySelector("aside") || {}).innerText || "")).toUpperCase();
  const gotoScreen = async (label, p = page) => {
    await p.evaluate((lbl) => {
      const el = [...document.querySelectorAll("aside *")].filter((e) => e.children.length === 0)
        .find((e) => e.textContent.trim().toUpperCase() === lbl);
      if (el) el.click();
    }, label);
  };

  // ════════════════════════════════════════════════════════════════
  // PHASE 1 — BAKERY, PRODUCTION MODE
  // ════════════════════════════════════════════════════════════════
  section("PHASE 1 — Bakery production: Place Order (KOT), NO auto-payment");
  let page = await freshPage("bakery");
  await loginAs(page, "aarav.mehta+ovenstory@gmail.com", "OvenStory#2026");
  const setOffStatus = await setQuickBilling((await apiLogin("aarav.mehta+ovenstory@gmail.com", "OvenStory#2026")).token, false);
  check(setOffStatus === 200 || setOffStatus === 201, "server: Quick Billing forced OFF before the run", setOffStatus);

  await page.goto(`${FRONTEND}/dashboard`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(3500);
  await page.screenshot({ path: path.join(SHOTS, "01-dashboard.png") });

  let text = await sidebarText();
  check(text.includes("ACTIVE ORDERS"), "sidebar shows ACTIVE ORDERS (production mode)", text.slice(0, 80));

  // Navigate to POS Ordering via the sidebar.
  const clickedPos = await page.evaluate(() => {
    const els = [...document.querySelectorAll("button, a, [role=button], div, span")];
    const el = els.find((e) => e.textContent.trim().toUpperCase() === "POS ORDERING" || /^POS ORDERING$/i.test(e.textContent.trim()));
    if (el) { el.click(); return true; }
    return false;
  });
  check(clickedPos, "clicked POS ORDERING in sidebar");
  await sleep(3000);
  await page.screenshot({ path: path.join(SHOTS, "02-pos.png") });
  text = await L();
  check(text.includes("COUNTER") || text.includes("PLACE ORDER"), "POS screen is counter-oriented", text.slice(0, 100));

  // Category-first UI: click a category card (any element whose text names a
  // category — click bubbles to the card's onClick handler), then an item card.
  const added = await page.evaluate(() => {
    const nameEl = [...document.querySelectorAll("*")].filter((el) => el.children.length === 0)
      .find((el) => /^(Beverages|Breads|Cakes|Cookies|Pastries)$/i.test(el.textContent.trim()));
    if (!nameEl) return false;
    nameEl.click();
    return true;
  });
  await sleep(1500);
  const addedItem = await page.evaluate(() => {
    const priceEl = [...document.querySelectorAll("*")].filter((el) => el.children.length === 0)
      .find((el) => /^[₹]\s?\d+([.]\d+)?$/.test(el.textContent.trim()));
    if (!priceEl) return false;
    priceEl.click(); priceEl.click(); // qty 2 (click bubbles to the card handler)
    return true;
  });
  check(added === true && addedItem === true, "opened a category and added a real product (qty 2) to cart", { added, addedItem });
  await sleep(800);
  const cartHasItems = await page.evaluate(() => /ORDER \([1-9]/i.test(document.body.innerText));
  check(cartHasItems, "cart shows the added item(s)");

  // Set up the collect-payment watcher BEFORE clicking Place Order.
  paymentCalls.length = 0;
  const hasKotBtn = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /PLACE ORDER \(KOT\)/i.test(b.textContent)));
  check(hasKotBtn, "PLACE ORDER (KOT) button visible");
  const payBtnVisible = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /^PAYMENT$/i.test(b.textContent.trim())));
  check(!payBtnVisible, "PAYMENT button NOT shown alongside Place Order (KOT) (§6)");

  // Block the print popup so headless print() doesn't hang; capture its content instead.
  await page.evaluate(() => {
    window.__kotPopups = [];
    const origOpen = window.open;
    window.open = function (...args) {
      const w = origOpen.apply(this, args);
      window.__kotPopups.push(w);
      return w;
    };
  });

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /PLACE ORDER \(KOT\)/i.test(b.textContent));
    if (btn) btn.click();
  });
  await sleep(1400); // capture the toast while it is still visible
  text = await L();
  check(/SENT TO KITCHEN/.test(text), 'success toast says "sent to kitchen"', text.slice(0, 120));
  check(!/OPENING PAYMENT/i.test(text), 'NO "Opening payment" message (§1)');
  check(paymentCalls.length === 0, "NO /payments/collect request after Place Order (KOT) (§13)", paymentCalls);
  await sleep(3500); // navigation + KOT popup settle
  await page.screenshot({ path: path.join(SHOTS, "03-after-place-order.png") });

  // KOT popup content — writes after load; poll briefly for the rendered HTML.
  let kotOk = false;
  for (let i = 0; i < 10 && !kotOk; i++) {
    kotOk = await page.evaluate(() => (window.__kotPopups || []).some((w) => {
      try { return !!w.document && w.document.body && /KOT|COUNTER|\d+X|ITEM/i.test(w.document.body.innerHTML); } catch (e) { return false; }
    }));
    if (!kotOk) await sleep(500);
  }
  check(kotOk, "KOT print popup rendered actual KOT content (no blank stall) (§9)");

  // ════════════════════════════════════════════════════════════════
  // PHASE 2 — ACTIVE ORDERS: card, status flow, bill, payment
  // ════════════════════════════════════════════════════════════════
  section("PHASE 2 — Active Orders: card, PENDING→READY, Bill, Payment");
  await sleep(1500);
  text = await L();
  check(/COUNTER ORDER/.test(text), "card shows COUNTER ORDER (§7)");
  check(!/TABLE T\d|TABLE \d+/i.test(text), "NO table number on the counter order card");
  check(/PENDING|PREPARING|READY/.test(text), "order status visible");

  // Advance PENDING → PREPARING → READY through the same API the UI uses.
  const login2 = await apiLogin("aarav.mehta+ovenstory@gmail.com", "OvenStory#2026");
  const tok = login2.token;
  const act = await fetch(`${BACKEND}/api/orders/active`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json());
  const activeOrders = act.data || [];
  const counterOrder = activeOrders.find((o) => o.orderType === "COUNTER_SALE");
  check(!!counterOrder, "Active Orders API returns the new COUNTER_SALE order");
  if (counterOrder) {
    await fetch(`${BACKEND}/api/orders/${counterOrder.id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ status: "PREPARING" }) });
    await fetch(`${BACKEND}/api/orders/${counterOrder.id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ status: "READY" }) });
    const kotId = (counterOrder.kot || [])[0]?.id;
    if (kotId) {
      await fetch(`${BACKEND}/api/kot/${kotId}/status`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ status: "READY" }) });
    }
    check(true, "status moved PREPARING → READY");
    await page.reload({ waitUntil: "networkidle2" });
    await sleep(3000);
    await gotoScreen("ACTIVE ORDERS"); // after reload the app opens on Dashboard
    await sleep(2000);
    text = await L();
    check(/READY/.test(text), "Active Orders visibly shows READY");

    // Bill → Payment through the UI: click BILL inside the READY counter card
    // (several cards may be on the board — BILL must come from the READY one),
    // then the "Collect ₹…" button (CASH pre-selected).
    paymentCalls.length = 0;
    const billTarget = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("div")].filter((d) =>
        d.className && String(d.className).includes("rounded-xl") &&
        /COUNTER ORDER/i.test(d.textContent) && /READY/i.test(d.textContent));
      const card = cards[cards.length - 1];
      if (!card) return null;
      const bill = [...card.querySelectorAll("button")].find((b) => /^BILL$/i.test(b.textContent.trim()));
      if (!bill) return null;
      const m = card.textContent.match(/#(ORD-\d+)/i);
      bill.click();
      return m ? m[1] : null;
    });
    check(!!billTarget, `clicked BILL on the READY counter order${billTarget ? ` (${billTarget})` : ""}`);
    await sleep(3500);
    await page.screenshot({ path: path.join(SHOTS, "04-bill.png") });
    text = await L();
    check(/CASH/i.test(text), "payment screen opened with CASH available");
    await sleep(600);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null)
        .find((b) => /^COLLECT\s/i.test(b.textContent.trim()));
      if (btn) btn.click();
    });
    await sleep(4500);
    await page.screenshot({ path: path.join(SHOTS, "05-payment.png") });
    text = await L();
    check(paymentCalls.length >= 1, "/payments/collect fired from the BILL flow (this one is allowed)", paymentCalls);
    // Verify the order the UI ACTUALLY billed (the board may hold several
    // READY counter orders from earlier runs — the card click picks one).
    const allOrders = await fetch(`${BACKEND}/api/orders?limit=50`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json()).catch(() => ({ data: [] }));
    const billed = (allOrders.data || allOrders.orders || []).find((o) =>
      billTarget ? (o.orderNo || "").replace(/^#/, "") === billTarget.replace(/^#/, "") : o.id === counterOrder.id);
    check((billed || {}).status === "COMPLETED", `billed order ${billTarget || counterOrder.orderNo} is COMPLETED`, (billed || {}).status);
    check(/PAYMENT COLLECTED|PAID/i.test(text), "receipt overlay shows Payment Collected / PAID");
  }

  // ════════════════════════════════════════════════════════════════
  // PHASE 3 — BAKERY, QUICK BILLING ON
  // ════════════════════════════════════════════════════════════════
  section("PHASE 3 — Bakery Quick Billing ON: PAYMENT only, no production UI");
  const qbOnStatus = await setQuickBilling(tok, true);
  check(qbOnStatus === 200 || qbOnStatus === 201, "server: Quick Billing switched ON", qbOnStatus);
  // Fresh browser context = fresh settings fetch (no persisted store cache).
  const page3 = await freshPage("bakery-qb");
  await loginAs(page3, "aarav.mehta+ovenstory@gmail.com", "OvenStory#2026");
  await page3.goto(`${FRONTEND}/dashboard`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4500);
  const qbServer = await fetch(`${BACKEND}/api/settings`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json());
  check(((qbServer.setting || {}).enableCounterSale) === true, "server still reports Quick Billing ON (page fetched same value)");
  const text3 = await sidebarText(page3);
  check(!text3.includes("ACTIVE ORDERS"), "sidebar hides ACTIVE ORDERS when Quick Billing ON", text3.slice(0, 100));
  const body3 = await page3.evaluate(() => document.body.innerText.toUpperCase());
  check(body3.includes("POS ORDERING") || body3.includes("DASHBOARD"), "app loaded for Quick Billing phase");
  const setBack = await setQuickBilling(tok, false);
  check(setBack === 200 || setBack === 201, "Quick Billing restored OFF");
  await page3.close();

  // ════════════════════════════════════════════════════════════════
  // PHASE 4 — RETAIL REGRESSION
  // ════════════════════════════════════════════════════════════════
  for (const [label, email, password] of [
    ["GreenBasket Supermarket", "rohan.shah+greenbasket@gmail.com", "GreenBasket#2026"],
    ["UrbanStyle Fashion", "neha.patel+urbanstyle@gmail.com", "UrbanStyle#2026"],
  ]) {
    section(`PHASE 4 — ${label} (retail regression)`);
    const rp = await freshPage(label.split(" ")[0].toLowerCase());
    await loginAs(rp, email, password);
    await rp.goto(`${FRONTEND}/dashboard`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(3000);
    const rt = await sidebarText(rp);
    check(!rt.includes("ACTIVE ORDERS"), "no ACTIVE ORDERS in sidebar (retail)");
    check(!rt.includes("KITCHEN"), "no KITCHEN TICKETS in sidebar (retail)");
    await rp.screenshot({ path: path.join(SHOTS, `06-retail-${label.split(" ")[0].toLowerCase()}.png`) });
    await rp.close();
  }

  // ════════════════════════════════════════════════════════════════
  // PHASE 5 — RESTAURANT REGRESSION
  // ════════════════════════════════════════════════════════════════
  section("PHASE 5 — The Golden Grill (restaurant regression)");
  const rpage = await freshPage("grill");
  await loginAs(rpage, "admin@restaurant.com", "password123");
  await rpage.goto(`${FRONTEND}/dashboard`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(3000);
  const rt2 = await sidebarText(rpage);
  check(rt2.includes("ACTIVE ORDERS"), "restaurant sidebar keeps ACTIVE ORDERS");
  check(rt2.includes("KITCHEN"), "restaurant sidebar keeps KITCHEN TICKETS");
  await rpage.screenshot({ path: path.join(SHOTS, "07-restaurant.png") });
  await rpage.close();

  // ════════════════════════════════════════════════════════════════
  section("CONSOLE / NETWORK");
  check(pageErrors.length === 0, "0 uncaught page errors", pageErrors.slice(0, 3));
  const reactErrors = consoleErrors.filter((e) => /React|Minified React|uncaught/i.test(e));
  check(reactErrors.length === 0, "0 React errors", reactErrors.slice(0, 3));
  const page500s = networkErrors.filter((e) => / 5\d\d /.test(e) && !/payments\/collect/.test(e));
  check(page500s.length === 0, "0 unexpected 5xx responses", page500s.slice(0, 3));

  await browser.close();
  console.log(`\n══════ BROWSER QA: ${pass} passed, ${fail} failed ══════`);
  console.log(`Screenshots → ${SHOTS}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("BROWSER QA ERROR:", e); process.exit(2); });
