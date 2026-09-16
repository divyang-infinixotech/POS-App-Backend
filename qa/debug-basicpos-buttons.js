/** Debug: dump tenant 9 Basic POS button texts (category cards). */
const os = require("os");
const path = require("path");
const CHROME = "C:\\Users\\Divyang\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const PUPPETEER = path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core");
const FE = "http://localhost:3000";
const BASE = "http://127.0.0.1:5001/api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const puppeteer = require(PUPPETEER);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", userDataDir: path.join(os.tmpdir(), "qa-dbg-" + Date.now()), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(FE + "/login", { waitUntil: "networkidle2" });
  await page.evaluate(async (BASE) => {
    const r = await fetch(BASE + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "superadmin@pos.com", password: "SuperAdmin@123" }) });
    const j = await r.json();
    const la = await fetch(BASE + "/super-admin/restaurants/9/login-as", { headers: { Authorization: "Bearer " + j.token } });
    const lj = await la.json();
    localStorage.setItem("pos_token", lj.token || lj.data?.token);
    localStorage.setItem("pos_user", JSON.stringify(lj.user || lj.data?.user));
  }, BASE);
  await page.goto(FE + "/", { waitUntil: "networkidle2" });
  await sleep(2500);
  await page.evaluate(() => { const el = [...document.querySelectorAll("button, a")].find((b) => (b.innerText || "").trim().toLowerCase() === "pos ordering"); if (el) el.click(); });
  await sleep(3000);
  const dump = await page.evaluate(() => ({
    title: document.body.innerText.slice(0, 400),
    buttons: [...document.querySelectorAll("button")].map((el) => (el.innerText || "").trim().replace(/\n/g, " | ")).filter((t) => t && t.length < 70).slice(0, 45),
  }));
  console.log(JSON.stringify(dump, null, 1));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
