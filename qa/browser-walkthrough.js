/**
 * LIVE BROWSER WALKTHROUGH — Subscription lifecycle @ 768×1024 (tablet portrait).
 *
 * Drives the REAL app (frontend dev server + backend + PostgreSQL) in headless
 * Chrome and verifies:
 *
 *   ADMIN (EXPIRING_SOON, 6 days):
 *     - dashboard expiry warning ("expires in 6 days") + [Renew Plan] + dismiss
 *     - header plan pill ("Basic Plan • 6 days left")
 *     - pill → Subscription & Billing
 *     - current plan card (ACTIVE, 6 days), available plans
 *     - Payment Review: RENEWAL (extends from current expiry) and UPGRADE
 *     - gateway-disabled → checkout 503 → subscription unchanged
 *
 *   ADMIN (EXPIRED, expiry set to yesterday):
 *     - dashboard red warning ("has expired") + [Renew / Change Plan]
 *     - pill ("Basic Plan • Expired")
 *     - subscription page: EXPIRED status, Expired On, plans still purchasable
 *     - Payment Review RENEWAL → "Immediately after successful payment"
 *     - gateway-disabled → checkout 503 → still EXPIRED
 *
 *   SUPER ADMIN:
 *     - Subscription Management columns (Billing Cycle, Days Remaining, Auto Renew)
 *     - status filter EXPIRING SOON, expiry filter Next 7 Days / Already Expired
 *
 * Usage (from restaurant-pos-backend):
 *   PUPPETEER_CORE_PATH=<dir with puppeteer-core> node qa/browser-walkthrough.js
 *
 * Requires: backend on :5001, frontend on :3000, a seeded DB with the
 * "QA Expiry *" restaurants (created by qa/expiry-lifecycle-qa.js), and
 * Chrome installed. Screenshots land in $SHOT_DIR (default Windows temp).
 *
 * NOTE: assertions use case-insensitive regexes because innerText reflects CSS
 * text-transform (buttons/labels render uppercase).
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CHROME =
  process.env.CHROME_PATH ||
  "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
const SHOTS = process.env.SHOT_DIR || "C:/Users/Divyang/AppData/Local/Temp/pos-shots";
const BACKEND_DIR = path.join(__dirname, "..");

// ── Restaurants used by this walkthrough (created by expiry-lifecycle-qa.js) ──
const EXPIRING_REST = {
  subId: 110,
  name: "QA Expiry 1786801094936",
  adminEmail: "qa-exp-admin-1786801094936@test.com",
  password: "SubPass@123",
};
const EXPIRED_REST = {
  subId: 106,
  name: "QA Expiry 1786801053575",
  adminEmail: "qa-exp-admin-1786801053575@test.com",
  password: "SubPass@123",
};

const SA = { email: "superadmin@pos.com", password: "SuperAdmin@123" };

let pass = 0;
let fail = 0;
const results = [];
const check = (cond, msg) => {
  results.push({ ok: !!cond, msg });
  if (cond) pass++;
  else fail++;
  process.stdout.write(cond ? "  ✅ " : "  ❌ ");
  console.log(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(SHOTS, name) });
  } catch (e) {
    console.log(`  ⚠ screenshot ${name} failed: ${e.message}`);
  }
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** Node-side API call (for SA fixture setup/teardown, e.g. temp plans). */
async function apiFetch(method, path, body, token) {
  const res = await fetch("http://localhost:5001/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

/** True when body text matches the regex (always case-insensitive). */
async function hasText(page, regex) {
  const t = await bodyText(page);
  return new RegExp(regex.source, "i").test(t);
}

/** Count occurrences of the regex across body text. */
async function countText(page, regex) {
  const t = await bodyText(page);
  const m = t.match(new RegExp(regex.source, "gi"));
  return m ? m.length : 0;
}

/** True when any <button> has exactly this text (trimmed, case-insensitive). */
async function hasButton(page, text) {
  return page.evaluate(
    (t) => Array.from(document.querySelectorAll("button")).some((b) => b.innerText.trim().toLowerCase() === t.toLowerCase()),
    text
  );
}

/** Click the first button/link whose trimmed text matches the regex. */
async function clickByText(page, regex) {
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const els = Array.from(document.querySelectorAll("button, a, [role='button']"));
    const el = els.find((e) => re.test((e.innerText || "").trim()));
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, regex.source);
  if (!ok) throw new Error(`No clickable element matched ${regex}`);
}

/** Click a button inside the plan card whose name contains `cardText`. */
async function clickCardButton(page, cardText, buttonRegex) {
  const ok = await page.evaluate(
    ([ct, bs]) => {
      // Card presence test: unanchored; button test: exact match.
      const btnRe = new RegExp(bs, "i");
      const cardRe = new RegExp(bs.replace(/^\^|\$$/g, ""), "i");
      // Deepest matching card = the plan card itself (smallest innerText)
      const cards = [...document.querySelectorAll("div")]
        .filter((d) => (d.innerText || "").includes(ct) && cardRe.test(d.innerText || ""))
        .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
      const card = cards[0];
      if (!card) return false;
      const btn = [...document.querySelectorAll("button")].find(
        (b) => btnRe.test((b.innerText || "").trim()) && card.contains(b)
      );
      if (btn) { btn.click(); return true; }
      return false;
    },
    [cardText, buttonRegex.source]
  );
  if (!ok) throw new Error(`No ${buttonRegex} button inside the ${cardText} card`);
}

/** Wait until body text matches the regex (case-insensitive). */
async function waitForText(page, regex, timeout = 25000) {
  await page.waitForFunction(
    (src) => new RegExp(src, "i").test(document.body.innerText),
    { timeout },
    regex.source
  );
}

async function waitForNoText(page, regex, timeout = 15000) {
  await page.waitForFunction(
    (src) => !new RegExp(src, "i").test(document.body.innerText),
    { timeout },
    regex.source
  );
}

/** Log in and land on the role's default screen. */
async function login(page, email, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[placeholder="Enter email or user ID"]', { timeout: 30000 });
  await page.type('input[placeholder="Enter email or user ID"]', email);
  await page.type('input[placeholder="Enter password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector("header", { timeout: 30000 });
  await sleep(2500); // let the dashboard + subscription snapshot settle
}

/**
 * Select an option in the <select> whose options include `anchor` (an option
 * value unique to that select — e.g. EXPIRING_SOON identifies the status
 * select, next7 the expiry select). `value` is the option to choose.
 */
async function selectOption(page, value, anchor) {
  const idx = await page.evaluate((anc) => {
    const selects = Array.from(document.querySelectorAll("select"));
    return selects.findIndex((s) =>
      Array.from(s.options).some((o) => o.value === anc)
    );
  }, anchor);
  if (idx < 0) throw new Error(`No select containing option "${anchor}"`);
  const handles = await page.$$("select");
  await handles[idx].select(value);
  await sleep(1200); // let the refetch settle
}

/** Set the SA search box (triple-click to replace existing text). */
async function setSearch(page, text) {
  const input = await page.$('input[placeholder="Search restaurant..."]');
  if (!input) throw new Error("Search input not found");
  await input.click({ clickCount: 3 });
  await input.type(text);
  await sleep(1200);
}

/** Force a subscription into the past (simulates the cron outcome). */
function expireSubscription(subId) {
  const tmp = path.join(BACKEND_DIR, "qa", ".expire-tmp.js");
  fs.writeFileSync(
    tmp,
    `const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const d = new Date(); d.setDate(d.getDate() - 1);
  const r = await p.subscription.update({ where: { id: ${subId} }, data: { expiryDate: d, nextRenewalDate: d } });
  console.log('expired sub', ${subId}, '->', d.toISOString().slice(0,10), 'plan', r.plan);
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
`
  );
  try {
    execSync("node qa/.expire-tmp.js", { cwd: BACKEND_DIR, stdio: "inherit" });
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`\nScreenshots → ${SHOTS}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=768,1024"],
  });

  // Isolated storage per phase (localStorage carries the JWT across pages in
  // the same browser profile otherwise).
  const freshPage = async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.log(`  ⚠ pageerror: ${e.message}`));
    return page;
  };

  // ─────────────────────────────────────────────────────────────
  // PHASE A — ADMIN, EXPIRING_SOON (6 days)
  // ─────────────────────────────────────────────────────────────
  {
    console.log("════ PHASE A — ADMIN EXPIRING_SOON ════");
    const page = await freshPage();
    await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.log(`  ⚠ pageerror: ${e.message}`));

    await login(page, EXPIRING_REST.adminEmail, EXPIRING_REST.password);

    // 0. Fixture: a temp LOW-PRICED plan (below Basic) so the SWITCH rule has a
    //    lower plan to demonstrate the CHANGE TO PLAN button — deleted at the
    //    end of this phase.
    const saAuth = await apiFetch("POST", "/auth/login", { email: SA.email, password: SA.password });
    const saApiToken = saAuth.data?.token;
    const tempLow = await apiFetch("POST", "/super-admin/plans", {
      code: `SWITCH_DEMO_${Date.now()}`, name: "Switch Demo", monthlyPrice: 500, yearlyPrice: 5000,
      billingCycle: "MONTHLY", isActive: true, modules: [{ moduleKey: "dashboard", enabled: true }],
    }, saApiToken);
    const tempLowId = tempLow.data?.data?.id;
    check(!!tempLowId, `Temp low plan created (id=${tempLowId}) for the SWITCH yearly-only demo`);

    // 1. Dashboard warning
    await waitForText(page, /expires in 6 days/);
    check(true, 'Dashboard warning shows backend days: "expires in 6 days"');
    check(await hasText(page, /renew plan/), "Dashboard CTA [Renew Plan] present");
    await shot(page, "a1-dashboard-warning.png");

    // 2. Dismiss the warning for this session
    await page.click('[aria-label="Dismiss warning"]');
    await waitForNoText(page, /expires in 6 days/);
    check(true, "Warning dismissible for the session");
    await shot(page, "a2-warning-dismissed.png");

    // 3. Header plan pill (lifecycle + backend days)
    await waitForText(page, /Basic Plan • 6 days left/);
    check(true, 'Header pill: "Basic Plan • 6 days left"');
    await shot(page, "a3-pill.png");

    // 4. Pill → Subscription & Billing
    await clickByText(page, /days left/);
    await waitForText(page, /Subscription & Billing/);
    check(true, "Pill opens Subscription & Billing");

    // 5. Subscription page state (wait for the data to finish loading)
    await waitForText(page, /Available Plans/);
    check(await hasText(page, /expires in 6 days/), "Subscription page shows backend expiry warning");
    check(await hasText(page, /Basic/) && (await hasText(page, /ACTIVE/)), "Current plan: Basic / ACTIVE");
    check(await hasText(page, /6 days/), "Days Remaining shows 6 days");
    check(await hasText(page, /Available Plans/), "Available plans still visible");
    await shot(page, "a4-subscription-page.png");

    // 5b. Yearly-only billing: no cycle toggle, yearly prices, CHANGE TO PLAN active
    check(!(await hasButton(page, "Monthly")), "No MONTHLY toggle button exists anywhere");
    check(!(await hasButton(page, "Yearly")), "No YEARLY toggle button exists (billing cycle is always Yearly)");
    check(await hasText(page, /\/yearly/i), "Every plan card shows the yearly price (/yearly)");
    check(!(await hasText(page, /yearly only/i)), 'No "YEARLY ONLY" blocked state remains (monthly no longer exists)');
    check(await hasText(page, /change to plan/i), "Lower plan (Switch Demo) shows an active CHANGE TO PLAN button");
    await shot(page, "a4b-yearly-only.png");

    // 6. Payment Review — RENEWAL (same plan)
    await clickByText(page, /^renew plan$/i);
    await waitForText(page, /Extends from current expiry/);
    check(await hasText(page, /action[\s\S]*renew/i), "Payment Review action = Renew");
    check(await hasText(page, /Extends from current expiry/), "RENEWAL effective: extends from current expiry");
    await shot(page, "a5-payment-review-renew.png");

    // 7. Gateway disabled → checkout 503 → subscription unchanged
    await clickByText(page, /pay\s*₹[\d,.]+\s*&\s*renew plan/i);
    await sleep(2500);
    check(
      await hasText(page, /Online payments are not configured/),
      "Gateway disabled → graceful 'not configured' state (503 path)"
    );
    check(
      (await countText(page, /Online payments are not configured/)) >= 2,
      "Blocked-payment error is visible INSIDE the payment modal (not just behind it)"
    );
    await shot(page, "a6-pay-gateway-blocked.png");
    await clickByText(page, /^cancel$/i);
    await sleep(800);
    check(
      (await hasText(page, /ACTIVE/)) && (await hasText(page, /6 days/)),
      "Subscription UNCHANGED after blocked payment (still ACTIVE, 6 days)"
    );
    await shot(page, "a7-subscription-unchanged.png");

    // 8. Payment Review — UPGRADE classification (Professional)
    await clickCardButton(page, "Professional", /^upgrade plan$/i);
    await waitForText(page, /Basic → Professional/);
    check(await hasText(page, /Upgrade/), "Payment Review action = Upgrade");
    check(await hasText(page, /Your plan expires in 6 days/), "≤7-day upgrade note uses backend days");
    await shot(page, "a8-upgrade-review.png");
    await clickByText(page, /^cancel$/i);
    await sleep(600);

    // 9. Remove the temp low plan (cleanup)
    const delLow = await apiFetch("DELETE", `/super-admin/plans/${tempLowId}`, undefined, saApiToken);
    check(delLow.status === 200 || delLow.status === 201, `Temp low plan removed (${delLow.status})`);

    await page.close();
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE B — ADMIN, EXPIRED (mutate sub 106 to yesterday)
  // ─────────────────────────────────────────────────────────────
  {
    console.log("\n════ PHASE B — ADMIN EXPIRED ════");
    console.log("  (mutating sub " + EXPIRED_REST.subId + " expiry to yesterday…)");
    expireSubscription(EXPIRED_REST.subId);

    const page = await freshPage();

    await login(page, EXPIRED_REST.adminEmail, EXPIRED_REST.password);

    // The expired ADMIN is pinned to Subscription & Billing by the route guard
    // (POS is locked server-side), so the landing screen IS the subscription
    // page — the red warning is shown there, not on the dashboard.

    // 1. Lands on Subscription & Billing (guard) with the pill still visible
    await waitForText(page, /Subscription & Billing/);
    await waitForText(page, /Basic Plan • Expired/);
    check(true, 'Header pill: "Basic Plan • Expired" (still visible, still clickable)');
    check(await hasText(page, /has expired/), 'Expiry message: "…has expired"');
    await shot(page, "b1-subscription-landing-expired.png");

    // 2. Current plan state + plans actually purchasable (regression for the
    //    query-string exemption bug: /subscriptions/plans?cycle=MONTHLY)
    await waitForText(page, /Available Plans/);
    await waitForText(page, /Professional/); // plan cards rendered → plans API reachable
    check(await hasText(page, /EXPIRED/), "Current plan status = EXPIRED");
    check(await hasText(page, /expired on/i), '"Expired On" row present');
    check(
      (await hasText(page, /Professional/)) && (await hasText(page, /Premium/)),
      "Plan cards render after expiry (plans API reachable — query-string fix)"
    );
    check(await hasText(page, /renew plan/i), "RENEWAL button available for the current plan");
    await shot(page, "b2-subscription-expired.png");

    // 3. Payment Review — RENEWAL after expiry starts from TODAY
    await clickByText(page, /^renew plan$/i);
    await waitForText(page, /Immediately after successful payment/);
    check(await hasText(page, /action[\s\S]*renew/i), "Payment Review action = Renew");
    check(
      await hasText(page, /Immediately after successful payment/),
      "Expired renewal effective: starts from TODAY"
    );
    await shot(page, "b3-renew-modal-expired.png");

    // 4. Gateway disabled → blocked → subscription unchanged (still EXPIRED)
    await clickByText(page, /pay\s*₹[\d,.]*\s*&\s*renew plan/i);
    await sleep(2500);
    check(await hasText(page, /Online payments are not configured/), "Gateway disabled → blocked (503 path)");
    check(
      (await countText(page, /Online payments are not configured/)) >= 2,
      "Blocked-payment error visible inside the modal (expired flow)"
    );
    await shot(page, "b4-pay-gateway-blocked.png");
    await clickByText(page, /^cancel$/i);
    await sleep(800);
    check(await hasText(page, /EXPIRED/), "Subscription UNCHANGED after blocked payment (still EXPIRED)");
    await shot(page, "b5-still-expired.png");

    await page.close();
  }

  // ─────────────────────────────────────────────────────────────
  // PHASE C — SUPER ADMIN filters
  // ─────────────────────────────────────────────────────────────
  {
    console.log("\n════ PHASE C — SUPER ADMIN ════");
    const page = await freshPage();

    await login(page, SA.email, SA.password);

    // Navigate to Subscriptions (sidebar labels are hidden at 768px — collapsed
    // rail shows icons only, so click the nav button by its title attribute)
    await page.click('[title="Subscriptions"]');
    await waitForText(page, /Subscription Management/);
    check(
      (await hasText(page, /Billing Cycle/i)) &&
        (await hasText(page, /Days Remaining/i)) &&
        (await hasText(page, /Auto Renew/i)),
      "SA columns: Billing Cycle / Days Remaining / Auto Renew"
    );
    await shot(page, "c1-sa-subscriptions.png");

    // Filter: status = EXPIRING SOON + search the 6-day restaurant
    await selectOption(page, "EXPIRING_SOON", "EXPIRING_SOON");
    await setSearch(page, EXPIRING_REST.name);
    check(await hasText(page, /EXPIRING SOON/), "Status filter EXPIRING SOON shows the 6-day restaurant");
    await shot(page, "c2-sa-expiring-soon.png");

    // Filter: expiry = Next 7 Days (reset status to All, keep search)
    await selectOption(page, "", "EXPIRING_SOON"); // status → All
    await selectOption(page, "next7", "next7");
    check(await hasText(page, new RegExp(EXPIRING_REST.name)), "Expiry filter Next 7 Days shows the 6-day restaurant");
    await shot(page, "c3-sa-next7.png");

    // Filter: expiry = Already Expired → the expired restaurant
    await selectOption(page, "", "next7"); // expiry → All
    await setSearch(page, EXPIRED_REST.name);
    await selectOption(page, "expired", "expired");
    check(await hasText(page, new RegExp(EXPIRED_REST.name)), "Expiry filter Already Expired shows the expired restaurant");
    check(await hasText(page, /EXPIRED/), "Expired row badge = EXPIRED");
    check(await hasText(page, /Days Remaining[\s\S]*?Expired/), "Days Remaining column shows Expired");
    await shot(page, "c4-sa-expired.png");

    await page.close();
  }

  await browser.close();

  // ── Summary ──
  console.log(`\n────────────────────────────────────────`);
  console.log(`WALKTHROUGH RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.msg}`));
  }
  console.log(`Screenshots saved to ${SHOTS}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("\nWALKTHROUGH ABORTED:", e.message);
  process.exit(1);
});
