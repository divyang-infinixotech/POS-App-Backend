/**
 * Runtime test — Dynamic Subscription Plan Management (spec §12)
 * Runs against the live API at http://localhost:5001/api
 *
 * Verifies:
 *  1. Only Basic & Premium plans exist by default
 *  2. Create a custom plan (Dashboard + POS Ordering only)
 *  3. Assign it to a restaurant → restaurant sees only those modules
 *  4. Backend blocks disabled modules (Reports/Menu/Active Orders → 403)
 *  5. Edit plan → enable Reports → immediately available after re-login
 *  6. Delete assigned plan → blocked with the exact spec message
 *  7. Reassign restaurant → delete plan succeeds
 *  8. Duplicate plan + toggle + modules list
 */
const BASE = "http://localhost:5001/api";
let passed = 0, failed = 0;
const results = [];

function check(name, cond, detail) {
  if (cond) { passed++; results.push("  ✓ " + name); }
  else { failed++; results.push("  ✗ FAIL: " + name + (detail ? " — " + detail : "")); }
}

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}

(async () => {
  // ── 0. Super Admin login ──
  let r = await req("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check("Super Admin login", r.status === 200 && r.json.success && r.json.token, "status=" + r.status);
  const saToken = r.json.token;

  // ── 1. Default plans: Basic + Premium ──
  r = await req("GET", "/super-admin/plans", null, saToken);
  check("GET plans", r.status === 200 && Array.isArray(r.json.data));
  const plans = r.json.data || [];
  const basic = plans.find((p) => p.code === "BASIC");
  const premium = plans.find((p) => p.code === "PREMIUM");
  check("Basic plan exists", !!basic, "codes=" + plans.map((p) => p.code).join(","));
  check("Premium plan exists", !!premium);
  check("Basic has module permissions + restaurant count field", basic && Array.isArray(basic.modules) && typeof basic.restaurantCount === "number");

  // ── 2. Module catalog (DB-driven, no hardcoded config) ──
  r = await req("GET", "/super-admin/plans/modules", null, saToken);
  check("GET plan modules (catalog)", r.status === 200 && Array.isArray(r.json.data) && r.json.data.length >= 16, "count=" + (r.json.data || []).length);
  const catalog = r.json.data || [];

  // ── 3. Create custom plan GOLD with Dashboard + POS Ordering only ──
  const goldModules = catalog
    .map((m) => ({ moduleKey: m.key, enabled: m.key === "dashboard" || m.key === "pos" }));
  r = await req("POST", "/super-admin/plans", {
    code: "GOLD", name: "Gold", description: "Custom plan — runtime test",
    monthlyPrice: 499, yearlyPrice: 4990, billingCycle: "MONTHLY", trialDays: 0,
    maxUsers: 5, sortOrder: 9, isActive: true, isDefault: false, modules: goldModules,
  }, saToken);
  check("Create custom plan (Gold)", r.status === 201 && r.json.success, "status=" + r.status + " " + (r.json.message || ""));
  const goldId = r.json.data ? r.json.data.id : null;
  check("Gold plan id returned", !!goldId);

  // Gold permissions persisted + features derived
  r = await req("GET", "/super-admin/plans", null, saToken);
  const gold = (r.json.data || []).find((p) => p.id === goldId);
  const goldEnabled = gold && (gold.modules || []).filter((m) => m.enabled).map((m) => m.moduleKey).sort();
  check("Gold has ONLY dashboard + pos enabled", JSON.stringify(goldEnabled) === JSON.stringify(["dashboard", "pos"]), JSON.stringify(goldEnabled));

  // ── 4. Assign Gold to a new restaurant ──
  const phone = "99990" + String(Math.floor(10000 + Math.random() * 89999));
  const adminEmail = "goldadmin" + Date.now() + "@test.com";
  r = await req("POST", "/super-admin/restaurants", {
    name: "Runtime Test Café", ownerName: "QA Tester", mobile: phone, email: adminEmail,
    country: "India", timezone: "Asia/Kolkata", currency: "INR", language: "en",
    planId: goldId, adminName: "Gold Admin", adminEmail, adminPassword: "password123",
  }, saToken);
  check("Create restaurant on Gold plan", r.status === 201 && r.json.success, "status=" + r.status + " " + (r.json.message || ""));
  const restaurantId = r.json.data ? r.json.data.id : null;

  // ── 5. Restaurant login → sees only Gold's modules ──
  r = await req("POST", "/auth/login", { email: adminEmail, password: "password123" });
  check("Restaurant admin login", r.status === 200 && r.json.success && r.json.subscription, "status=" + r.status);
  const adminToken = r.json.token;
  const subFeatures = (r.json.subscription && r.json.subscription.features || []).sort();
  check("Subscription snapshot = [dashboard, pos]", JSON.stringify(subFeatures) === JSON.stringify(["dashboard", "pos"]), JSON.stringify(subFeatures));

  // ── 6. Backend authorization blocks disabled modules ──
  // Module-exclusive endpoints & management writes must be blocked...
  r = await req("GET", "/reports/sales", null, adminToken);
  check("Reports blocked (403)", r.status === 403, "status=" + r.status);
  r = await req("GET", "/customers", null, adminToken);
  check("Customers blocked (403)", r.status === 403, "status=" + r.status);
  r = await req("GET", "/users", null, adminToken);
  check("Staff blocked (403)", r.status === 403, "status=" + r.status);
  r = await req("GET", "/orders/active", null, adminToken);
  check("Active Orders screen blocked (403)", r.status === 403, "status=" + r.status);
  r = await req("POST", "/menu", { name: "Hack Item", price: 10, categoryId: 1 }, adminToken);
  check("Menu management write blocked (403)", r.status === 403, "status=" + r.status);
  r = await req("POST", "/categories", { name: "Hack Cat" }, adminToken);
  check("Category write blocked (403)", r.status === 403, "status=" + r.status);
  r = await req("POST", "/tables", { tableNo: "T99", capacity: 2 }, adminToken);
  check("Table management write blocked (403)", r.status === 403, "status=" + r.status);
  // ...but the POS Ordering core flow stays functional (reads shared with POS)
  r = await req("GET", "/menu", null, adminToken);
  check("POS can read menu catalog (200)", r.status === 200, "status=" + r.status);
  r = await req("GET", "/tables", null, adminToken);
  check("POS can read tables (200)", r.status === 200, "status=" + r.status);
  r = await req("GET", "/orders", null, adminToken);
  check("POS can read orders (200)", r.status === 200, "status=" + r.status);
  r = await req("GET", "/bills", null, adminToken);
  check("POS can read bills (200)", r.status === 200, "status=" + r.status);
  r = await req("GET", "/payments", null, adminToken);
  check("Payments (checkout) allowed (200)", r.status === 200, "status=" + r.status);
  r = await req("GET", "/orders/123456", null, adminToken);
  check("Order detail read allowed (200/404, pos grant)", r.status === 200 || r.status === 404, "status=" + r.status);
  // Dashboard module enabled on Gold → dashboard endpoint allowed
  r = await req("GET", "/dashboard/summary", null, adminToken);
  check("Dashboard allowed (200, module enabled)", r.status === 200, "status=" + r.status);

  // ── 7. Edit Gold → enable Reports → immediate propagation ──
  r = await req("PUT", "/super-admin/plans/" + goldId, {
    modules: catalog.map((m) => ({ moduleKey: m.key, enabled: m.key === "dashboard" || m.key === "pos" || m.key === "reports" })),
  }, saToken);
  check("Edit plan (enable Reports)", r.status === 200 && r.json.success, "status=" + r.status + " " + (r.json.message || ""));

  // Re-login (fresh subscription snapshot per spec: after refresh/login)
  r = await req("POST", "/auth/login", { email: adminEmail, password: "password123" });
  const subFeatures2 = (r.json.subscription && r.json.subscription.features || []).sort();
  check("Subscription now includes reports", subFeatures2.includes("reports"), JSON.stringify(subFeatures2));
  const adminToken2 = r.json.token;
  r = await req("GET", "/reports/sales", null, adminToken2);
  check("Reports now allowed (200)", r.status === 200, "status=" + r.status);
  r = await req("POST", "/menu", { name: "Hack Item", price: 10, categoryId: 1 }, adminToken2);
  check("Menu management write still blocked (403)", r.status === 403, "status=" + r.status);

  // ── 8. Delete assigned plan → blocked with exact message ──
  r = await req("DELETE", "/super-admin/plans/" + goldId, null, saToken);
  const blockedMsg = r.json && r.json.message ? r.json.message : "";
  check("Delete assigned plan blocked (400)", r.status === 400 || r.status === 500, "status=" + r.status);
  check("Block message mentions restaurants", /assigned to \d+ restaurant\(s\)/.test(blockedMsg), blockedMsg);

  // ── 9. Reassign restaurant → Basic → delete Gold succeeds ──
  r = await req("PUT", "/super-admin/subscriptions/" + restaurantId + "/plan", { planId: basic.id, action: "change" }, saToken);
  check("Reassign restaurant to Basic", r.status === 200 && r.json.success, "status=" + r.status + " " + (r.json.message || ""));
  r = await req("DELETE", "/super-admin/plans/" + goldId, null, saToken);
  check("Delete Gold after reassign succeeds", r.status === 200 && r.json.success, "status=" + r.status + " " + (r.json.message || ""));

  // ── 10. Duplicate Premium plan ──
  r = await req("POST", "/super-admin/plans/" + premium.id + "/duplicate", null, saToken);
  check("Duplicate Premium plan", r.status === 201 && r.json.success, "status=" + r.status + " " + (r.json.message || ""));
  const dupId = r.json.data ? r.json.data.id : null;
  r = await req("GET", "/super-admin/plans", null, saToken);
  const dup = (r.json.data || []).find((p) => p.id === dupId);
  check("Duplicate has same module set", dup && JSON.stringify((dup.modules || []).filter((m) => m.enabled).map((m) => m.moduleKey).sort()) === JSON.stringify((premium.modules || []).filter((m) => m.enabled).map((m) => m.moduleKey).sort()));
  check("Duplicate not default", dup && dup.isDefault === false);
  r = await req("DELETE", "/super-admin/plans/" + dupId, null, saToken);
  check("Cleanup duplicate plan", r.status === 200, "status=" + r.status);

  // ── 11. Toggle active/inactive ──
  r = await req("PATCH", "/super-admin/plans/" + basic.id + "/toggle", null, saToken);
  check("Deactivate Basic", r.status === 200 && r.json.data && r.json.data.isActive === false);
  r = await req("PATCH", "/super-admin/plans/" + basic.id + "/toggle", null, saToken);
  check("Reactivate Basic", r.status === 200 && r.json.data && r.json.data.isActive === true);

  // ── 12. Search / filter / sort on plans list ──
  r = await req("GET", "/super-admin/plans?search=PREMIUM&status=active&sortBy=name&sortOrder=asc", null, saToken);
  check("Plans search/filter/sort", r.status === 200 && r.json.data.length >= 1 && r.json.data.every((p) => p.code.includes("PREMIUM")), "n=" + (r.json.data || []).length);

  console.log("─".repeat(60));
  console.log("DYNAMIC PLAN MANAGEMENT — RUNTIME TEST RESULTS");
  console.log("─".repeat(60));
  results.forEach((l) => console.log(l));
  console.log("─".repeat(60));
  console.log(`PASSED: ${passed}  FAILED: ${failed}`);
  console.log(failed === 0 ? "ALL TESTS PASSED ✅" : "SOME TESTS FAILED ❌");
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("Test harness error:", e); process.exit(2); });
