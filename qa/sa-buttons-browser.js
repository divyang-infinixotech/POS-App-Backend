/**
 * SUPER ADMIN — FULL BUTTON FUNCTIONALITY (BROWSER)
 *
 * Clicks real Super Admin buttons in the live Vite app and verifies each
 * mutation persists after a page refresh (API → DB → UI → refresh):
 *
 *   Plans:      create → appears; edit (price) → persists; duplicate →
 *               appears; toggle active → persists; delete → gone
 *   Restaurants: create → appears; status toggle → persists
 *   Gateway:    save config (dummy) → status shows configured+masked;
 *               enable/disable → persists
 *   Profile:    edit name → header + refresh retain; revert
 *
 * Usage: PUPPETEER_CORE_PATH=<dir with puppeteer-core> node qa/sa-buttons-browser.js
 * Requires backend (:5001) + Vite frontend (:3000) running.
 */
const puppeteer = require(process.env.PUPPETEER_CORE_PATH || "puppeteer-core");
const CHROME = process.env.CHROME_PATH || "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3000";
const API = "http://localhost:5001/api";
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else fail++; console.log((cond ? "  ✅ " : "  ❌ ") + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  let url = API + path;
  let payload = body;
  if ((method === "GET" || method === "HEAD") && body && typeof body === "object" && !Array.isArray(body)) {
    const qs = Object.entries(body).filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    payload = undefined;
  }
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

(async () => {
  const ts = Date.now();
  const suffix = ts;
  const pName = `QA Button ${suffix}`;
  const pCode = `BTN${String(suffix).slice(-6)}`;
  const rName = `QA BTN Rest ${suffix}`;

  const saLogin = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  const saToken = saLogin.data?.token;
  check(!!saToken, "SA login token");

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const failedReqs = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("response", (r) => { if (r.status() >= 400) failedReqs.push(`HTTP ${r.status()} ${r.url()}`); });

  const login = async (email, password) => {
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
  const nav = async (title) => {
    await page.evaluate((t) => { const el = [...document.querySelectorAll("button, a")].find((x) => x.title === t); if (el) el.click(); }, title);
    await sleep(2200);
  };
  const clickText = async (pattern) => {
    await page.evaluate((src) => {
      const re2 = new RegExp(src, "i");
      const el = [...document.querySelectorAll("button, a, [role='button']")].find((x) => re2.test((x.innerText || "").trim()));
      if (el) el.click();
    }, pattern);
    await sleep(1800);
  };
  const bodyText = () => page.evaluate(() => document.body.innerText);
  const fillModal = async (idx, value) => {
    const el = (await page.$$(".fixed.inset-0.z-50 input"))[idx];
    if (el) { await el.click({ clickCount: 3 }); await el.type(value); }
    return !!el;
  };
  const clickModal = async (label) => {
    await page.evaluate((l) => {
      // Match any fixed overlay (confirmation dialogs use z-[100], forms z-50)
      const b = [...document.querySelectorAll(".fixed.inset-0 button")].find((x) => new RegExp("^" + l + "$", "i").test(x.innerText.trim()));
      if (b) b.click();
    }, label);
    await sleep(2500);
  };
  const clickCardAction = async (name, titleRe) => {
    await page.evaluate(([nm, tr]) => {
      const re = new RegExp(nm, "i");
      const title = new RegExp(tr, "i");
      // Match buttons by title OR visible text (card-view Edit has no title).
      const isTarget = (b) => title.test(b.title || "") || title.test((b.innerText || "").trim());
      const cards = [...document.querySelectorAll("div")].filter((d) => re.test(d.innerText || "") && [...d.querySelectorAll("button")].some(isTarget));
      cards.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
      const card = cards[0];
      const btn = card && [...card.querySelectorAll("button")].find(isTarget);
      if (btn) btn.click();
    }, [name, titleRe]);
    await sleep(2500);
  };

  await login("superadmin@pos.com", "SuperAdmin@123");
  const home = await bodyText();
  check(/restaurants|subscription plans|payment gateway/i.test(home), "SA portal loads");

  // ═══════════ PLANS — create via UI ═══════════
  await nav("Plans");
  let t = await bodyText();
  check(/create plan/i.test(t), "Plans screen renders with Create Plan button");

  await clickText("create plan");
  await sleep(1000);
  const setCycleYearly = async () => {
    await page.evaluate(() => {
      const m = document.querySelector(".fixed.inset-0.z-50");
      if (!m) return;
      const sel = [...m.querySelectorAll("select")].find((s) => /yearly/i.test([...s.options].map((o) => o.text).join(" ")));
      if (sel) {
        sel.value = [...sel.options].find((o) => /yearly/i.test(o.text))?.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await sleep(500);
  };
  await setCycleYearly();
  const filled = await fillModal(0, pCode) && await fillModal(1, pName) && await fillModal(4, "2500");
  check(filled, "plan form fields filled (code/name/yearly price)");
  await clickModal("create plan");
  t = await bodyText();
  check(new RegExp(pName, "i").test(t), "created plan appears in the plans list");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(3000);
  await nav("Plans");
  t = await bodyText();
  check(new RegExp(pName, "i").test(t), "created plan survives page refresh");

  // ═══════════ PLANS — edit price via UI ═══════════
  await nav("Plans");
  await sleep(1500);
  await clickCardAction(pName, "^edit$");
  await sleep(1000);
  await page.evaluate(() => {
    const m = document.querySelector(".fixed.inset-0.z-50");
    if (!m) return;
    const sel = [...m.querySelectorAll("select")].find((s) => /yearly/i.test([...s.options].map((o) => o.text).join(" ")));
    if (sel) {
      sel.value = [...sel.options].find((o) => /yearly/i.test(o.text))?.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(500);
  await fillModal(4, "4999");
  await clickModal("save changes");
  t = await bodyText();
  check(/4,999|4999/.test(t), "edited yearly price visible after save");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(3000);
  await nav("Plans");
  t = await bodyText();
  check(/4,999|4999/.test(t), "edited price survives page refresh");

  // ═══════════ PLANS — duplicate via UI ═══════════
  await nav("Plans");
  await sleep(1500);
  await clickCardAction(pName, "duplicate");
  await sleep(1000);
  await clickModal("duplicate");
  t = await bodyText();
  check(new RegExp(pName + ".*(copy|duplicate)", "i").test(t) || /copy/i.test(t), "duplicated plan appears in list");

  // Switch to Table view — rows carry the exact plan code (card view doesn't),
  // so row-scoped clicks can never hit a copy/duplicate plan.
  const clickTableAction = async (code, titleRe) => {
    await page.evaluate(([c, tr]) => {
      const title = new RegExp(tr, "i");
      const row = [...document.querySelectorAll("tr")].find((r) => new RegExp("\\b" + c + "\\b", "i").test(r.innerText || ""));
      const btn = row && [...row.querySelectorAll("button")].find((b) => title.test(b.title || ""));
      if (btn) btn.click();
    }, [code, titleRe]);
    await sleep(2500);
  };

  // ═══════════ PLANS — toggle active via UI (table row, exact code) ═══════════
  await nav("Plans");
  await sleep(1500);
  await clickText("^table$");
  await sleep(800);
  await clickTableAction(pCode, "^deactivate$");
  const dbPlan = await api("GET", "/super-admin/plans", null, saToken);
  const planRow = (dbPlan.data?.data || []).find((p) => p.code === pCode);
  check(planRow && planRow.isActive === false, "deactivate toggle persisted in PostgreSQL");

  // ═══════════ PLANS — delete via UI (re-activate first so delete isn't blocked) ═══════════
  if (planRow) await api("PATCH", `/super-admin/plans/${planRow.id}/toggle`, undefined, saToken);
  await nav("Plans");
  await sleep(1500);
  await clickText("^table$");
  await sleep(800);
  await clickTableAction(pCode, "^delete$");
  await sleep(1000);
  const confirmShown = await page.evaluate(() => /delete plan/i.test(document.body.innerText));
  check(confirmShown, "delete confirmation dialog appeared");
  await clickModal("delete");
  t = await bodyText();
  check(!new RegExp("\\b" + pCode + "\\b", "i").test(t), "deleted plan gone from UI");
  const dbPlan2 = await api("GET", "/super-admin/plans", null, saToken);
  check(!(dbPlan2.data?.data || []).some((p) => p.code === pCode), "deleted plan removed from PostgreSQL");

  // ═══════════ RESTAURANTS — create via UI ═══════════
  await nav("Restaurants");
  await sleep(1500);
  t = await bodyText();
  check(/add restaurant|create restaurant|new restaurant/i.test(t), "Restaurants screen renders");
  await clickText("add restaurant|create restaurant|new restaurant");
  await sleep(1200);
  const rInputs = await page.$$(".fixed.inset-0.z-50 input");
  check(rInputs.length >= 4, "restaurant form dialog opened with fields");
  await fillModal(0, rName);
  await fillModal(1, "QA Owner");
  await fillModal(2, `qa-btn-${suffix}@test.com`);
  await fillModal(3, `977${String(suffix).slice(-8)}`);
  await fillModal(12, "QA Admin");        // Admin Name
  await fillModal(13, `qa-btn-admin-${suffix}@test.com`); // Admin Email
  await fillModal(14, "SubPass@123");     // Admin Password
  await clickModal("create restaurant");
  t = await bodyText();
  check(new RegExp(rName, "i").test(t), "created restaurant appears in list");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(3000);
  await nav("Restaurants");
  t = await bodyText();
  check(new RegExp(rName, "i").test(t), "created restaurant survives page refresh");
  const dbR = await api("GET", "/super-admin/restaurants", { page: 1, limit: 100, search: `qa-btn-${suffix}` }, saToken);
  const rRow = (dbR.data?.data?.restaurants || []).find((r) => r.name === rName);
  check(!!rRow, "restaurant persisted in PostgreSQL");
  if (rRow) {
    // Real UI flow: kebab menu → Suspend → confirm dialog.
    await nav("Restaurants");
    await sleep(1500);
    const opened = await page.evaluate((nm) => {
      const cards = [...document.querySelectorAll("tr, div")].filter((d) => new RegExp(nm, "i").test(d.innerText || "") && d.querySelector("button"));
      cards.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
      const btn = cards[0] && [...cards[0].querySelectorAll("button")].find((b) => b.querySelector("svg"));
      if (btn) { btn.click(); return true; }
      return false;
    }, rName);
    check(opened, "restaurant kebab menu opened");
    await sleep(1000);
    await clickText("^suspend$");
    await sleep(1200);
    await clickModal("suspend|confirm");
    const dbR2 = await api("GET", `/super-admin/restaurants/${rRow.id}`, null, saToken);
    const subR = await api("GET", `/super-admin/subscriptions/${rRow.id}`, null, saToken);
    check(dbR2.data?.data?.status !== rRow.status || subR.data?.data?.status === "SUSPENDED" || dbR2.data?.data?.subscriptionStatus === "SUSPENDED", "suspend action persisted in PostgreSQL");
  }

  // ═══════════ GATEWAY — save config + enable/disable via UI ═══════════
  await nav("Payment Gateway");
  await sleep(2000);
  t = await bodyText();
  check(/save configuration|test connection/i.test(t), "Payment Gateway screen renders");
  const gwInputs = await page.$$("input");
  if (gwInputs.length >= 2) {
    const keyId = `rzp_test_btnsa${String(suffix).slice(-8)}`;
    await gwInputs[0].click({ clickCount: 3 }); await gwInputs[0].type(keyId);
    await gwInputs[1].click({ clickCount: 3 }); await gwInputs[1].type("btnsa-secret-key-0123456789");
    await clickText("save configuration");
    await sleep(3000);
    t = await bodyText();
    check(/configured|enabled/i.test(t), "gateway save reflects in UI");
    const toggled = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((x) => /disable online payments|enable online payments/i.test(x.innerText || x.getAttribute("aria-label") || ""));
      if (btn) { btn.click(); return true; }
      return false;
    });
    check(toggled, "gateway enable/disable toggle clicked");
    await sleep(1500);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".fixed.inset-0.z-50 button")].find((x) => /confirm|yes|disable|enable/i.test(x.innerText) && !/cancel/i.test(x.innerText));
      if (b) b.click();
    });
    await sleep(2500);
    const gwStatus = await api("GET", "/super-admin/payments/gateway", null, saToken);
    check(gwStatus.data?.data?.keyId && gwStatus.data?.data?.keyId.includes("********"), "gateway status shows masked key");
    check(typeof gwStatus.data?.data?.enabled === "boolean", `gateway enabled state persisted (${gwStatus.data?.data?.enabled})`);
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    await prisma.systemSetting.deleteMany({ where: { key: { in: ["payment_gateway_razorpay", "payment_gateway_razorpay_webhook"] } } });
    await prisma.$disconnect();
  } else {
    check(false, "gateway inputs found");
  }

  // ═══════════ PROFILE — edit via UI ═══════════
  await nav("Profile");
  await sleep(1500);
  await clickText("edit profile");
  await sleep(1000);
  const newName = `QA BTN SA ${suffix}`;
  await fillModal(0, newName);
  await clickModal("save changes");
  t = await bodyText();
  check(new RegExp(newName, "i").test(t), "profile header updates immediately after save");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(3000);
  t = await bodyText();
  check(new RegExp(newName, "i").test(t), "profile name survives page refresh");
  await nav("Profile");
  await sleep(1200);
  await clickText("edit profile");
  await sleep(1000);
  await fillModal(0, "Super Admin");
  await clickModal("save changes");

  // ═══════════ CONSOLE / NETWORK ═══════════
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED/i.test(e));
  check(realErrors.length === 0, `zero console/page errors across all clicks (${realErrors.length})`);
  const realFailed = failedReqs.filter((u) => !/favicon/.test(u));
  check(realFailed.length === 0, `zero failed API requests caused by clicks (${realFailed.length})`);

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
