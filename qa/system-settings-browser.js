/**
 * SYSTEM SETTINGS — SINGLE SAVE BUTTON UX (BROWSER)
 *
 * Verifies in the live Vite app:
 *   - ZERO individual "Save" buttons; exactly ONE "Save Changes" button
 *   - dirty state: disabled initially → enabled after ANY change
 *   - ONE bulk PUT /super-admin/settings request on save (no per-field saves)
 *   - success toast + button returns to disabled/saved state
 *   - persistence: navigate away → return → hard refresh → logout → login
 *   - Reset Changes restores last saved values (no API call, no DB change)
 *   - failed API save keeps the user's entered values + error toast
 *   - secret fields masked (never plaintext in the DOM)
 *   - no horizontal overflow at 390/768/1024/1366/1920
 *   - zero console/page errors, zero unexpected failed requests
 *
 * Usage: PUPPETEER_CORE_PATH=<dir containing puppeteer-core> node qa/system-settings-browser.js
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
  const pName = `QA Settings ${suffix}`;
  const trialDays = 22;
  const currency = "EUR";

  const saLogin = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  const saToken = saLogin.data?.token;
  check(!!saToken, "SA login token");

  // Baseline settings to restore at the end
  const baselineResp = await api("GET", "/super-admin/settings", null, saToken);
  const baseline = baselineResp.data?.data || {};
  const origName = baseline.platform_name ?? "Restaurant POS";
  const origTrial = baseline.default_trial_days ?? 15;
  const origMaint = baseline.maintenance_mode ?? false;
  const origCur = baseline.currency ?? "INR";

  // Normalize the DB to a known baseline BEFORE the browser test so the
  // maintenance checkbox starts at a deterministic state (leftover state from
  // a crashed prior run must not flip the toggle assertion).
  await api("PUT", "/super-admin/settings", {
    settings: { platform_name: origName, default_trial_days: origTrial, maintenance_mode: origMaint, currency: origCur },
  }, saToken);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const failedReqs = [];
  let putSettingsCount = 0;
  let interceptor = null;
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("request", (r) => { if (r.method() === "PUT" && /\/super-admin\/settings/.test(r.url())) putSettingsCount++; });
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
  const bodyText = () => page.evaluate(() => document.body.innerText);
  const fieldValues = () => page.evaluate(() => [...document.querySelectorAll("input")].map((el) => el.value));
  const saveState = () => page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^save changes$/i.test(x.innerText.trim()));
    return b ? { exists: true, disabled: !!b.disabled, label: b.innerText.trim() } : { exists: false };
  });
  const clickSave = async () => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /^save changes$/i.test(x.innerText.trim()));
      if (b && !b.disabled) b.click();
    });
  };
  const waitForToast = async (re, ms = 4000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const t = await bodyText();
      if (re.test(t)) return true;
      await sleep(300);
    }
    return false;
  };
  const setField = async (idx, value) => {
    const ins = await page.$$("input");
    const el = ins[idx];
    if (!el) return false;
    await el.click({ clickCount: 3 });
    await el.type(value);
    return true;
  };

  await login("superadmin@pos.com", "SuperAdmin@123");
  let t = await bodyText();
  check(/restaurants|subscription plans|payment gateway/i.test(t), "SA portal loads");

  // ── 1. ONE Save Changes button, ZERO individual Save buttons ──
  await nav("System Settings");
  t = await bodyText();
  check(/platform name|system settings/i.test(t), "System Settings screen renders");
  const buttonAudit = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean);
    const exactSave = btns.filter((x) => /^save$/i.test(x)).length;
    const saveChanges = btns.filter((x) => /^save changes$/i.test(x)).length;
    return { exactSave, saveChanges };
  });
  check(buttonAudit.exactSave === 0, `zero individual Save buttons (found ${buttonAudit.exactSave})`);
  check(buttonAudit.saveChanges === 1, `exactly one Save Changes button (found ${buttonAudit.saveChanges})`);

  // ── 2. Dirty state: disabled initially ──
  let sb = await saveState();
  check(sb.exists && sb.disabled, "Save Changes disabled with no changes");

  // ── 3. Modify multiple fields → dirty → enabled ──
  // SETTING_FIELDS order: platform_name(0) default_trial_days(1) maintenance checkbox(2)
  // max_file_upload_mb(3) smtp_host(4) smtp_port(5) smtp_user(6) smtp_pass(7)
  // smtp_from_email(8) razorpay_key(9) razorpay_secret(10) tax_percentage(11) currency(12)
  await setField(0, pName);
  await setField(1, String(trialDays));
  await setField(12, currency);
  const ins2 = await page.$$("input");
  await ins2[2].click(); // maintenance_mode checkbox
  await sleep(500);
  sb = await saveState();
  check(sb.exists && !sb.disabled, "Save Changes enabled after editing multiple fields");

  // ── 4. ONE bulk request on save + success toast + button returns disabled ──
  putSettingsCount = 0;
  await clickSave();
  check(await waitForToast(/Settings saved successfully/), "success toast shown");
  check(putSettingsCount === 1, `exactly one PUT /super-admin/settings on save (count=${putSettingsCount})`);
  sb = await saveState();
  check(sb.exists && sb.disabled, "Save Changes disabled again after successful save");
  const persisted = await api("GET", "/super-admin/settings", null, saToken);
  check(persisted.data?.data?.platform_name === pName && persisted.data?.data?.default_trial_days === trialDays && persisted.data?.data?.currency === currency, "bulk save persisted to PostgreSQL (name/trial/currency)");
  check(persisted.data?.data?.maintenance_mode === !origMaint, `maintenance_mode toggle persisted (${origMaint} → ${!origMaint})`);

  // ── 5. Navigate away → return → values persist ──
  await nav("Dashboard");
  await nav("System Settings");
  let fv = await fieldValues();
  check(fv[0] === pName && fv[12] === currency, "values persist after navigate away + return");

  // ── 6. Hard refresh → values persist ──
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(3000);
  await nav("System Settings");
  fv = await fieldValues();
  check(fv[0] === pName && fv[12] === currency, "values persist after hard refresh");

  // ── 7. Logout → login → values persist ──
  await page.evaluate(() => localStorage.clear());
  await login("superadmin@pos.com", "SuperAdmin@123");
  await nav("System Settings");
  fv = await fieldValues();
  check(fv[0] === pName && fv[12] === currency, "values persist after logout + login");

  // ── 8. Reset Changes restores saved values without an API call ──
  await setField(0, "TEMP CHANGE");
  await sleep(400);
  sb = await saveState();
  check(sb.exists && !sb.disabled, "dirty again after an edit (reset precondition)");
  const putBeforeReset = putSettingsCount;
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^reset changes$/i.test(x.innerText.trim()));
    if (b && !b.disabled) b.click();
  });
  await sleep(800);
  fv = await fieldValues();
  check(fv[0] === pName, "Reset Changes restored saved values");
  check(putSettingsCount === putBeforeReset, "Reset Changes made no API call");
  sb = await saveState();
  check(sb.exists && sb.disabled, "Save Changes disabled again after reset");
  const dbAfterReset = await api("GET", "/super-admin/settings", null, saToken);
  check(dbAfterReset.data?.data?.platform_name === pName, "Reset Changes did not touch the database");

  // ── 9. Failed API save keeps entered values + error toast ──
  await page.setRequestInterception(true);
  interceptor = (r) => {
    if (r.method() === "PUT" && /\/super-admin\/settings/.test(r.url())) {
      // respond() must carry CORS headers, otherwise the browser blocks the
      // response before axios sees it and the error maps to a network failure.
      r.respond({
        status: 500,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "http://localhost:3000" },
        body: JSON.stringify({ success: false, message: "Internal Server Error" }),
      });
    } else {
      r.continue();
    }
  };
  page.on("request", interceptor);
  await setField(0, "KEEP ME");
  await sleep(400);
  await clickSave();
  check(await waitForToast(/Unable to save settings/), "error toast shown on failed save");
  fv = await fieldValues();
  check(fv[0] === "KEEP ME", `failed save keeps user-entered values (got "${fv[0]}")`);
  // Detach interceptor BEFORE disabling so no stale continue() calls throw.
  page.off("request", interceptor);
  await page.setRequestInterception(false);
  // reset via UI to the saved baseline
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^reset changes$/i.test(x.innerText.trim()));
    if (b && !b.disabled) b.click();
  });
  await sleep(800);

  // ── 10. Secret masking ──
  await api("PUT", "/super-admin/settings", { settings: { smtp_pass: "secret-mask-check-123" } }, saToken);
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(3000);
  await nav("System Settings");
  const secretAudit = await page.evaluate(() => {
    const inputsEl = [...document.querySelectorAll("input")];
    const passInput = inputsEl.find((el) => el.type === "password");
    const body = document.body.innerText;
    return { value: passInput ? passInput.value : null, leak: /secret-mask-check-123/.test(body) };
  });
  check(secretAudit.value === "********", "secret field shows the mask, not the plaintext");
  check(!secretAudit.leak, "no secret plaintext anywhere in the DOM");

  // ── 11. Responsive: no horizontal overflow + actions visible ──
  const overflowAt = [];
  const actionsIssue = [];
  for (const vp of [{ w: 390, h: 844 }, { w: 768, h: 1024 }, { w: 1024, h: 768 }, { w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    await sleep(600);
    const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    if (dims.sw > dims.cw + 1) overflowAt.push(`${vp.w}x${vp.h}(${dims.sw}>${dims.cw})`);
    // The save area lives at the bottom of a scrollable page — scroll it into
    // view, then verify it is fully reachable/tappable (never clipped).
    const vis = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /^save changes$/i.test(x.innerText.trim()));
      if (!b) return { missing: true };
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      return { missing: false, top: r.top, bottom: r.bottom, height: r.height, cw: document.documentElement.clientWidth, ch: window.innerHeight };
    });
    await sleep(300);
    if (vis.missing || vis.height < 40 || vis.top < 0 || vis.bottom > (vis.ch || vp.h) || vis.width > (vis.cw || vp.w)) {
      actionsIssue.push(`${vp.w}x${vp.h}(h=${Math.round(vis.height || 0)}, top=${Math.round(vis.top || 0)}, bot=${Math.round(vis.bottom || 0)})`);
    }
  }
  check(overflowAt.length === 0, `no horizontal overflow at any viewport${overflowAt.length ? ": " + overflowAt.join(", ") : ""}`);
  check(actionsIssue.length === 0, `Save Changes reachable + tappable (≥40px) at all viewports${actionsIssue.length ? " — issues: " + actionsIssue.join(", ") : ""}`);

  // ── 12. Console / network audit ──
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(e));
  check(realErrors.length === 0, `zero console/page errors (${realErrors.length})`);
  const realFailed = failedReqs.filter((u) => !/favicon/.test(u) && !u.includes(":5001/api/super-admin/settings")); // the intentional 500 is excluded
  check(realFailed.length === 0, `zero unexpected failed API requests (${realFailed.length})`);

  // ── Cleanup: restore baseline settings ──
  await api("PUT", "/super-admin/settings", {
    settings: {
      platform_name: origName,
      default_trial_days: origTrial,
      maintenance_mode: origMaint,
      currency: origCur,
      smtp_pass: "",
    },
  }, saToken);
  const afterCleanup = await api("GET", "/super-admin/settings", null, saToken);
  check(afterCleanup.data?.data?.platform_name === origName, "baseline settings restored");

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
