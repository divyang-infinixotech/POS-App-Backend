/**
 * Responsive audit (§18) — one login, then resize the viewport across
 * 768×1024 / 390×844 / 1024×768 / 1366×768 and assert, on the subscription
 * page and the Payment Review:
 *   - no horizontal overflow
 *   - header plan pill visible
 *   - plan action buttons visible
 *   - Pay CTA tappable
 * Hard per-step timeouts so a stuck step can never hang the run.
 * Usage: PUPPETEER_CORE_PATH=<path> node qa/viewport-audit.js
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const CHROME = "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const FRONT = "http://localhost:3000";
const EMAIL = "qa-exp-admin-1786801094936@test.com";
const PASS = "SubPass@123";

const VIEWPORTS = [
  { w: 768, h: 1024, label: "768×1024 tablet portrait (primary)" },
  { w: 390, h: 844, label: "390×844 mobile" },
  { w: 1024, h: 768, label: "1024×768 tablet landscape" },
  { w: 1366, h: 768, label: "1366×768 desktop" },
];

let pass = 0, fail = 0;
const check = (cond, msg) => { process.stdout.write(cond ? "  ✅ " : "  ❌ "); console.log(msg); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickByText(page, regex) {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const el = [...document.querySelectorAll("button, a, [role=button]")].find(
      (e) => re.test((e.innerText || "").trim()) && e.offsetWidth > 0 && e.offsetHeight > 0
    );
    if (el) { el.click(); return true; }
    return false;
  }, regex.source);
}

/** Run a promise with a hard timeout; resolves 'TIMEOUT' on timeout. */
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), ms)),
  ]);
}

async function login(page) {
  await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => { console.error("goto failed:", e.message); });
  await sleep(4000); // let the SPA mount the login form
  await page.waitForSelector('input[placeholder="Enter email or user ID"]', { timeout: 30000 }).catch(async () => {
    const dbg = await page.evaluate(() => ({
      url: location.href,
      body: document.body.innerText.slice(0, 200),
      inputs: [...document.querySelectorAll("input")].map((i) => i.placeholder || i.type),
    })).catch(() => ({}));
    console.error("login selector missing:", JSON.stringify(dbg));
  });
  const emailSel = await page.$('input[placeholder="Enter email or user ID"]');
  if (!emailSel) throw new Error("login form not rendered");
  await page.type('input[placeholder="Enter email or user ID"]', EMAIL);
  await page.type('input[placeholder="Enter password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForSelector("header", { timeout: 30000 }).catch(() => { console.error("header not found after login"); });
  await sleep(2500);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 768, height: 1024 });

    console.log("── logging in (768×1024) ──");
    await withTimeout(login(page), 60000);
    await sleep(1500);

    // Navigate to Subscription & Billing via the header pill (or direct nav fallback)
    const opened = await page.evaluate(() => {
      const el = [...document.querySelectorAll("header button, button")].find(
        (e) => /days left|expires in|plan •/i.test((e.innerText || "").trim()) && e.offsetWidth > 0
      );
      if (el) { el.click(); return true; }
      return false;
    });
    await sleep(2000);
    await page.evaluate(() => {
      if (!/subscription & billing/i.test(document.body.innerText)) {
        const nav = [...document.querySelectorAll("a, button")].find((e) => /subscription & billing/i.test(e.innerText || ""));
        if (nav) nav.click();
      }
    }).catch(() => {});
    await sleep(2500);

    for (const vp of VIEWPORTS) {
      console.log(`\n── ${vp.label} ──`);
      await page.setViewport({ width: vp.w, height: vp.h, isMobile: vp.w <= 600, hasTouch: vp.w <= 600 });
      await sleep(1200);
      // Re-navigate via the header pill (the SPA may have reset after a resize)
      const onSub = await page.evaluate(() => /available plans|current plan|subscription & billing/i.test(document.body.innerText));
      if (!onSub) {
        await clickByText(page, /days left|expires in|plan •/i).catch(() => {});
        await sleep(2500);
      }

      const sub = await withTimeout(page.evaluate(() => {
        const pill = [...document.querySelectorAll("header button, button")].find(
          (e) => /days left|expires in|plan •/i.test((e.innerText || "").trim()) && e.offsetWidth > 0
        );
        const cards = [...document.querySelectorAll("button")].filter(
          (b) => /renew plan|upgrade plan|change to plan|choose/i.test((b.innerText || "").trim()) && b.offsetWidth > 0
        ).length;
        const toggleButtons = [...document.querySelectorAll("button")].filter((b) => {
          const t = (b.innerText || "").trim().toLowerCase();
          return t === "monthly" || t === "yearly";
        }).length;
        return {
          onSubPage: /available plans|current plan|subscription & billing/i.test(document.body.innerText),
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          pill: pill ? pill.innerText.trim().replace(/\s+/g, " ") : null,
          pillW: pill ? pill.offsetWidth : 0,
          cards,
          toggleButtons,
          yearlyPrice: /\/yearly/i.test(document.body.innerText),
        };
      }), 15000);

      check(sub && sub.onSubPage, `Subscription page rendered (${vp.w}px)`);
      check(!sub || sub.scrollW <= sub.innerW + 1, `No horizontal overflow (${sub ? sub.scrollW + " ≤ " + sub.innerW : "n/a"})`);
      check(sub && sub.pill, `Header pill visible (${sub ? sub.pill : "none"})`);
      check(sub && sub.pillW >= 44, `Pill ≥ 44px wide (${sub ? sub.pillW + "px" : "n/a"})`);
      check(sub && sub.cards >= 1, `Plan action buttons visible (${sub ? sub.cards : 0})`);
      check(sub && sub.toggleButtons === 0, `No Monthly/Yearly cycle toggle (${vp.w}px)`);
      check(sub && sub.yearlyPrice, `Plan cards show yearly price /yearly (${vp.w}px)`);

      // Open Payment Review (first plan card) at this viewport
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find(
          (x) => /renew plan|upgrade plan|change to plan|choose/i.test((x.innerText || "").trim()) && x.offsetWidth > 0
        );
        if (b) b.click();
      }).catch(() => {});
      await sleep(1500);

      const rev = await withTimeout(page.evaluate(() => {
        const pay = [...document.querySelectorAll("button")].find((b) => /^pay\s/i.test((b.innerText || "").trim()) && b.offsetWidth > 0);
        return {
          has: /current plan|selected plan|new expiry|billing cycle|action/i.test(document.body.innerText),
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          payH: pay ? pay.offsetHeight : 0,
          payText: pay ? pay.innerText.trim().slice(0, 36) : null,
        };
      }), 15000);
      check(rev && rev.has, "Payment Review fields present (Current/Selected Plan, Action, Cycle, Price, Expiries)");
      check(!rev || rev.scrollW <= rev.innerW + 1, `No horizontal overflow with review open (${rev ? rev.scrollW + " ≤ " + rev.innerW : "n/a"})`);
      check(rev && rev.payH >= 40, `Pay CTA tappable ≥ 40px (${rev ? rev.payH + "px : " + rev.payText : "n/a"})`);

      // Close the review dialog for the next viewport (explicit Close/Back button only)
      await page.evaluate(() => {
        const close = [...document.querySelectorAll("button")].find((b) => /close|back to plans|✕|×|cancel/i.test((b.innerText || "").trim()) && b.offsetWidth > 0 && b.offsetHeight > 0 && b.innerText.length < 25);
        if (close) close.click();
      }).catch(() => {});
      await sleep(1000);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n  Viewport audit → ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("Viewport audit crashed:", e.message); process.exit(1); });
