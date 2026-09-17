/**
 * One-off: re-enable barcodeScannerEnabled for the Basic POS showcase tenants
 * (512 Bakery, 513 Supermarket, 514 Fashion). A partial settings PUT resets
 * unspecified booleans to Joi defaults, so we GET the full settings object,
 * flip only the flag, and PUT everything back.
 * Run: node scripts/enable-showcase-barcode.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const http = require("http");

const BASE = "http://localhost:5001";
const TENANTS = [
  { name: "Bakery", email: "aarav.mehta+ovenstory@gmail.com", password: "OvenStory#2026" },
  { name: "Supermarket", email: "rohan.shah+greenbasket@gmail.com", password: "GreenBasket#2026" },
  { name: "Fashion", email: "neha.patel+urbanstyle@gmail.com", password: "UrbanStyle#2026" },
];

function req(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, json: null, raw: buf }); }
        });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  try {
  for (const t of TENANTS) {
    const login = await req("POST", `${BASE}/api/auth/login`, { body: { email: t.email, password: t.password } });
    if (!login.json || !login.json.token) { console.log(`${t.name}: LOGIN FAIL ${login.status}`); continue; }
    const token = login.json.token;

    const get = await req("GET", `${BASE}/api/settings`, { token });
    const settings = get.json && (get.json.setting || get.json.data || get.json.settings);
    if (!settings) { console.log(`${t.name}: GET settings FAIL ${get.status}`); continue; }

    settings.barcodeScannerEnabled = true;
    // Joi requires arrays/objects; tenants saved with null must be coerced.
    if (settings.taxesAndCharges == null) settings.taxesAndCharges = [];
    if (settings.uiSettings == null) settings.uiSettings = {};
    if (settings.printers == null) settings.printers = [];
    const put = await req("POST", `${BASE}/api/settings`, { token, body: settings });
    const ok = put.json && put.json.success;
    console.log(`${t.name}: barcodeScannerEnabled -> ${ok ? "ON" : `FAIL ${put.status} ${JSON.stringify(put.json).slice(0, 150)}`}`);
  }
  } catch (e) {
    console.error("FATAL:", e && e.stack ? e.stack : e);
    process.exitCode = 1;
    return;
  }
  process.exit(0);
})().catch((e) => { console.error("UNHANDLED:", e && e.stack ? e.stack : e); process.exit(1); });
