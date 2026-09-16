/** DEBUG: dump live UI text at each stage to diagnose PHASE 22 failures. */
const os = require("os");
const path = require("path");
const CHROME = "C:\\Users\\Divyang\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const PUPPETEER = path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core");
const FE = "http://localhost:3000";
const BASE = "http://127.0.0.1:5001/api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

(async () => {
  const puppeteer = require(PUPPETEER);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    userDataDir: path.join(os.tmpdir(), `qa-dbg-${Date.now()}`),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on("pageerror", (e) => console.log("PAGEERROR:", String(e?.message || e).slice(0, 200)));

    const loginAs = async (rid) => {
      await page.goto(FE + "/login", { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(1000);
      return page.evaluate(async (BASE, rid) => {
        const r = await fetch(BASE + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "superadmin@pos.com", password: "SuperAdmin@123" }) });
        const j = await r.json(); if (!j.token) return null;
        const la = await fetch(BASE + `/super-admin/restaurants/${rid}/login-as`, { headers: { Authorization: "Bearer " + j.token } });
        const lj = await la.json(); const t = lj.token || lj.data?.token; const u = lj.user || lj.data?.user;
        if (!t || !u) return null;
        localStorage.setItem("pos_token", t); localStorage.setItem("pos_user", JSON.stringify(u));
        return true;
      }, BASE, rid);
    };

    // ── Tenant 1: home + wizard open ──
    console.log("=== T1 login:", await loginAs(1));
    await sleep(800);
    await page.goto(FE + "/", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);
    let txt = await page.evaluate(() => document.body.innerText);
    console.log("=== T1 home text (first 800):\n", txt.slice(0, 800));
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const b = btns.find((el) => /new order|take order|takeaway|start order/i.test(el.innerText || ""));
      if (b) { const t = el_inner(b); b.click(); return t; }
      function el_inner(e) { return (e.innerText || "").slice(0, 40); }
      return null;
    });
    console.log("=== clicked:", clicked);
    await sleep(3000);
    txt = await page.evaluate(() => document.body.innerText);
    console.log("=== T1 after click (first 1500):\n", txt.slice(0, 1500));
    console.log("=== barcodeInput present:", !!(await page.$('input[name="barcodeInput"]')));
    const inputs = await page.evaluate(() => [...document.querySelectorAll("input")].map((i) => ({ name: i.name, ph: i.placeholder, type: i.type })).slice(0, 12));
    console.log("=== inputs:", JSON.stringify(inputs));

    // ── Tenant 2: home (Quick Billing) ──
    console.log("\n=== T2 login:", await loginAs(2));
    await sleep(800);
    await page.goto(FE + "/", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(3000);
    txt = await page.evaluate(() => document.body.innerText);
    console.log("=== T2 home text (first 1800):\n", txt.slice(0, 1800));
    console.log("=== T2 barcodeInput present:", !!(await page.$('input[name="barcodeInput"]')));
    const inputs2 = await page.evaluate(() => [...document.querySelectorAll("input")].map((i) => ({ name: i.name, ph: i.placeholder })).slice(0, 12));
    console.log("=== T2 inputs:", JSON.stringify(inputs2));

    // ── Tenant 1 settings tabs ──
    console.log("\n=== T1 login:", await loginAs(1));
    await sleep(600);
    await page.goto(FE + "/settings", { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
    await sleep(2500);
    txt = await page.evaluate(() => document.body.innerText);
    console.log("=== T1 settings (first 1200):\n", txt.slice(0, 1200));
    // try clicking the POS tab if tabs exist
    const tabClick = await page.evaluate(() => {
      const els = [...document.querySelectorAll("button, [role=tab], a")];
      const b = els.find((el) => /^(pos|pos settings|ordering|general)$/i.test((el.innerText || "").trim()));
      if (b) { b.click(); return (el.innerText || "").trim(); }
      return null;
    });
    console.log("=== settings tab clicked:", tabClick);
    await sleep(2000);
    txt = await page.evaluate(() => document.body.innerText);
    console.log("=== T1 settings after tab (first 1600):\n", txt.slice(0, 1600));
    console.log("=== 'Always enabled' present:", /always enabled/i.test(txt));
    console.log("=== 'Barcode Scanner' present:", /barcode scanner/i.test(txt));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });
