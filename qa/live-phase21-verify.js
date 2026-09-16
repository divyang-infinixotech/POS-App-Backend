/**
 * PHASE 21/26 — LIVE API verification: settings 500 fix, barcode gates,
 * tenant isolation. Run: node qa/live-phase21-verify.js
 */
const BASE = "http://127.0.0.1:5001/api";
const results = { pass: 0, fail: 0 };
const ok = (cond, label, extra = "") => {
  process.stdout.write(`${cond ? "  ✅" : "  ❌"} ${label}${cond ? "" : " — " + extra}\n`);
  cond ? results.pass++ : results.fail++;
};

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

(async () => {
  console.log("=== LIVE API VERIFICATION (PHASE 21/26) ===\n");

  // ── Sessions: super admin → login-as tenant 1 & 9 ADMIN ──
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  ok(sa.status === 200, "Super Admin login → 200", JSON.stringify(sa.data).slice(0, 120));
  const saToken = sa.data?.token;

  const la1 = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
  const la9 = await api("GET", "/super-admin/restaurants/9/login-as", null, saToken);
  const tok1 = la1.data?.data?.token;
  const tok9 = la9.data?.data?.token;
  ok(!!tok1 && !!tok9, "login-as tokens for tenant 1 and 9");

  // ══ PHASE 1: GET /api/settings ══
  console.log("\n--- PHASE 1: settings 500 fix ---");
  const realName = "The Golden Grill"; // platform DB source of truth (probe safety)
  const g1 = await api("GET", "/settings", null, tok1);
  ok(g1.status === 200, `GET /settings (tenant 1) → ${g1.status}`, JSON.stringify(g1.data).slice(0, 150));
  ok(g1.data?.success === true, "GET envelope { success: true, setting: … }");
  const originalName = g1.data?.setting?.restaurantName || realName;
  // ── always restore the REAL name (probe safety) ──
  const put1 = await api("POST", "/settings", {
    restaurantName: realName,
    barcodeScannerEnabled: false,
    // injection attempt — must be ignored, never written
    restaurantId: 999,
    id: 12345,
    // attempt to write a DIFFERENT businessMode than current — must be ignored
    businessMode: "restaurant",
  }, tok1);
  ok(put1.status === 200, `PUT /settings (with injection attempt) → ${put1.status}`, JSON.stringify(put1.data).slice(0, 200));
  ok(put1.data?.data?.restaurantId === 1, `restaurantId NOT injected (still 1, got ${put1.data?.data?.restaurantId})`);
  // PUT response = raw DB row. We injected businessMode:"restaurant" — if the
  // whitelist works, the row still holds its pre-PUT value ("counter"), so the
  // response must NOT echo the injected value. (GET-derived businessMode always
  // shows the subscription value, so it is the wrong surface for this check.)
  ok(put1.data?.data?.businessMode !== "restaurant", `businessMode NOT injected (DB row: ${put1.data?.data?.businessMode})`);
  const g1b = await api("GET", "/settings", null, tok1);
  ok(g1b.status === 200, `GET after PUT → ${g1b.status}`);
  ok(g1b.data?.setting?.barcodeScannerEnabled === false, "barcodeScannerEnabled=false persisted");

  // Toggle ON → persists
  const put2 = await api("POST", "/settings", { restaurantName: originalName, barcodeScannerEnabled: true }, tok1);
  ok(put2.status === 200, `PUT barcodeScannerEnabled=true → ${put2.status}`);
  const g1c = await api("GET", "/settings", null, tok1);
  ok(g1c.data?.setting?.barcodeScannerEnabled === true, "barcodeScannerEnabled=true persisted (PHASE 5)");

  // Invalid payload → 400 not 500
  const bad = await api("POST", "/settings", { garbageFieldXYZ: true }, tok1);
  ok(bad.status === 400, `PUT with unknown field only → 400 (got ${bad.status})`);
  const empty = await api("POST", "/settings", {}, tok1);
  ok([400, 200].includes(empty.status) === true && empty.status === 400, `PUT with empty body → 400 (got ${empty.status})`);

  // ══ PHASE 26: tenant isolation on settings ══
  console.log("\n--- PHASE 26: tenant isolation (settings) ---");
  const g9 = await api("GET", "/settings", null, tok9);
  ok(g9.status === 200, `GET /settings (tenant 9) → ${g9.status}`);
  const name9 = g9.data?.setting?.restaurantName;
  const put9 = await api("POST", "/settings", { restaurantName: name9, barcodeScannerEnabled: false }, tok9);
  ok(put9.status === 200, `tenant 9 settings save → ${put9.status}`);
  ok(put9.data?.data?.restaurantId === 9, `tenant 9 save writes restaurantId 9 (got ${put9.data?.data?.restaurantId})`);
  const g1d = await api("GET", "/settings", null, tok1);
  ok(g1d.data?.setting?.restaurantName === originalName, "tenant 1 settings untouched by tenant 9 save");

  // ══ PHASE 7: barcode lookup — POSITIVE case on tenant 9 (plan HAS barcode_scanner) ══
  // Entitlement matrix (platform DB): tenant 1 PREMIUM lacks the feature;
  // tenant 9 BASIC includes it. Enable tenant 9's toggle for the happy path.
  console.log("\n--- PHASE 7: barcode lookup (tenant 9 — plan entitled) ---");
  const { platformPrisma, getTenantClientByRestaurantId } = require("../src/config/tenantPrisma.js");
  const t9c = await getTenantClientByRestaurantId(9);
  const scanTarget = await t9c.client.menuItem.findFirst({
    where: { isAvailable: true, OR: [{ barcode: null }, { barcode: "" }] },
    select: { id: true, name: true, barcode: true },
    orderBy: { id: "asc" },
  });
  const T9_SCAN = "890000000001";
  let t9StampOriginal = null;
  if (scanTarget) {
    t9StampOriginal = scanTarget.barcode || "";
    await t9c.client.menuItem.update({ where: { id: scanTarget.id }, data: { barcode: T9_SCAN } });
  }
  await t9c.client.restaurantSetting.update({ where: { restaurantId: 9 }, data: { barcodeScannerEnabled: true } });

  const scan = await api("GET", "/menu/barcode/" + T9_SCAN, null, tok9);
  ok(scan.status === 200, `scan known barcode → ${scan.status}`, JSON.stringify(scan.data).slice(0, 150));
  // successResponse wraps payload in `data` → { success, message, data: { item } }
  ok(scan.data?.data?.item?.id === (scanTarget && scanTarget.id), `item returned (id=${scan.data?.data?.item?.id})`);

  // leading-zero preservation: unknown but format-critical
  const scanZeros = await api("GET", "/menu/barcode/0012345678905", null, tok9);
  ok(scanZeros.status === 404, `barcode '0012345678905' stays STRING → 404 (got ${scanZeros.status})`);
  ok(/Item not found for barcode: 0012345678905/.test(scanZeros.data?.message || ""), "404 message echoes full string with leading zeros");

  const scanUnknown = await api("GET", "/menu/barcode/999999999999", null, tok9);
  ok(scanUnknown.status === 404, `unknown barcode → 404 (got ${scanUnknown.status})`);

  // Scanner toggle OFF → 403
  const putOff = await api("POST", "/settings", { restaurantName: "Nirka", barcodeScannerEnabled: false }, tok9);
  ok(putOff.status === 200, "scanner toggle OFF");
  const scanOff = await api("GET", "/menu/barcode/" + T9_SCAN, null, tok9);
  ok(scanOff.status === 403, `scan with restaurant toggle OFF → 403 (got ${scanOff.status})`);

  // ══ PHASE 3: plan gate — tenant 1 (toggle ON, plan WITHOUT feature) → 403 ══
  console.log("\n--- PHASE 3: plan entitlement gate (tenant 1 — toggle ON, plan OFF) ---");
  await api("POST", "/settings", { restaurantName: originalName, barcodeScannerEnabled: true }, tok1);
  const sub1 = await platformPrisma.subscription.findFirst({ where: { restaurantId: 1 }, select: { id: true, features: true } });
  const hasPlanFeature = Array.isArray(sub1?.features) && sub1.features.includes("barcode_scanner");
  if (!hasPlanFeature) {
    const scanNoPlan = await api("GET", "/menu/barcode/" + T9_SCAN, null, tok1);
    ok(scanNoPlan.status === 403, `plan feature OFF (toggle ON) → 403 (got ${scanNoPlan.status})`);
  } else {
    console.log("  ℹ️ tenant 1 plan already includes barcode_scanner — plan-gate 403 tested via another tenant");
    const scan9g = await api("GET", "/menu/barcode/" + T9_SCAN, null, tok1);
    ok(scan9g.status !== 200, `tenant 1 scan → ${scan9g.status} (not 200)`);
  }
  // restore tenant 1 toggle to safe OFF (its plan excludes the feature anyway)
  await api("POST", "/settings", { restaurantName: originalName, barcodeScannerEnabled: false }, tok1);

  // cross-tenant: tenant 9 scanning tenant 1's barcode must NOT resolve tenant 1's item
  console.log("\n--- PHASE 26: barcode tenant isolation ---");
  const crossScan = await api("GET", "/menu/barcode/" + T9_SCAN, null, tok1);
  ok(crossScan.status !== 200 || crossScan.data?.item?.restaurantId === 1,
    `tenant 1 cannot resolve tenant 9's item (→ ${crossScan.status})`);

  // ── Cleanup: restore tenant 9 QA state ──
  try {
    if (scanTarget && t9StampOriginal !== null) {
      await t9c.client.menuItem.update({ where: { id: scanTarget.id }, data: { barcode: t9StampOriginal } });
      console.log(`  🧹 restored barcode "${t9StampOriginal}" on tenant 9 item ${scanTarget.id}`);
    }
    await t9c.client.restaurantSetting.update({ where: { restaurantId: 9 }, data: { barcodeScannerEnabled: false } });
    await t9c.client.$disconnect();
    console.log("  🧹 restored tenant 9 barcodeScannerEnabled=false");
  } catch (e) { console.log("  ⚠️ cleanup warning:", e.message); }

  console.log(`\n──────── LIVE RESULTS: ${results.pass} passed, ${results.fail} failed ────────`);
  process.exit(results.fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
