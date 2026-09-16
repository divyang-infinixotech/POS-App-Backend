/**
 * Live verification of Parts 24/25/27 + dietary/subcategory backend enforcement,
 * all against restaurant_1 (Golden Grill) on the running dev server.
 *
 *   1. GET /api/settings → 200 (was 500 before the tenant enum repair)
 *   2. PUT /api/settings dietaryMode round-trip (DB authoritative)
 *   3. Category → Subcategory → Item creation + edit (no 42704)
 *   4. Cross-category subcategory assignment rejected (HTTP 400)
 *   5. VEG_ONLY restaurant rejects NON_VEG item creation (HTTP 400, canonical msg)
 *   6. Cleanup: restores original settings, removes QA data.
 *
 * Run: node qa/live-verify-settings-menu-hierarchy.js
 */
const BASE = "http://127.0.0.1:5001/api";

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  // ── Login: Super Admin → login-as restaurant_1 ADMIN (established QA pattern) ──
  const sa = await api("POST", "/auth/login", {
    email: process.env.QA_SUPER_ADMIN_EMAIL || "superadmin@pos.com",
    password: process.env.QA_SUPER_ADMIN_PASSWORD || "SuperAdmin@123",
  });
  check("Super Admin login", sa.status === 200, `status=${sa.status}`);
  const saToken = sa.json?.token || sa.json?.data?.token || sa.json?.data?.data?.token;
  check("Super Admin token", !!saToken);

  const la = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
  check("login-as restaurant 1", la.status === 200, `status=${la.status} ${JSON.stringify(la.json?.message || "")}`);
  const token = la.json?.token || la.json?.data?.token || la.json?.data?.data?.token;
  check("restaurant-1 token", !!token);

  // ── LIVE A: GET /api/settings → 200 (Part 24) ──
  const s0 = await api("GET", "/settings", null, token);
  check("GET /settings → 200", s0.status === 200, `status=${s0.status} ${JSON.stringify(s0.json?.message || "").slice(0, 120)}`);
  const setting = s0.json?.setting || s0.json?.data?.setting || s0.json?.data || {};
  const origMode = setting.dietaryMode || "VEG_AND_NON_VEG";
  const origRoster = setting.enableStaffRoster !== false;
  check("settings expose dietaryMode + enableStaffRoster", "dietaryMode" in setting);

  // ── LIVE B: POST /api/settings dietaryMode round-trip (Part 27) ──
  const targetMode = origMode === "VEG_ONLY" ? "VEG_AND_NON_VEG" : "VEG_ONLY";
  const putMode = await api("POST", "/settings", { restaurantName: setting.restaurantName || "QA Restaurant", dietaryMode: targetMode }, token);
  check(`POST /settings dietaryMode=${targetMode} → 200`, putMode.status === 200, `status=${putMode.status} ${JSON.stringify(putMode.json?.message || "").slice(0, 120)}`);
  const s1 = await api("GET", "/settings", null, token);
  check("dietaryMode persisted after save", (s1.json?.setting || s1.json?.data?.setting || {}).dietaryMode === targetMode, `got ${(s1.json?.setting || s1.json?.data?.setting || {}).dietaryMode}`);

  // ── LIVE C: hierarchy setup — category → subcategory → item (Part 25) ──
  const cat = await api("POST", "/categories", { name: `QA Pizza ${Date.now()}` }, token);
  check("POST /categories → created", cat.status === 200 || cat.status === 201, `status=${cat.status}`);
  const catId = cat.json?.category?.id || cat.json?.data?.id || cat.json?.data?.category?.id;
  check("category id returned", !!catId);

  const sub = await api("POST", "/menu/subcategories", { name: `QA Veg Pizza ${Date.now()}`, categoryId: catId }, token);
  check("POST /menu/subcategories → created", sub.status === 200 || sub.status === 201, `status=${sub.status} ${JSON.stringify(sub.json?.message || "").slice(0, 120)}`);
  const subId = sub.json?.data?.subcategory?.id || sub.json?.subcategory?.id || sub.json?.data?.id;
  check("subcategory id returned", !!subId);

  // second category + subcategory for the cross-category rejection test
  const cat2 = await api("POST", "/categories", { name: `QA Burger ${Date.now()}` }, token);
  const cat2Id = cat2.json?.category?.id || cat2.json?.data?.id || cat2.json?.data?.category?.id;
  const sub2 = await api("POST", "/menu/subcategories", { name: `QA Burger Sub ${Date.now()}`, categoryId: cat2Id }, token);
  const sub2Id = sub2.json?.data?.subcategory?.id || sub2.json?.subcategory?.id || sub2.json?.data?.id;
  check("second category/subcategory created", !!cat2Id && !!sub2Id);

  const item = await api("POST", "/menu", {
    name: `QA Margherita ${Date.now()}`,
    price: 250,
    categoryId: catId,
    subcategoryId: subId,
    dietaryType: "VEG",
  }, token);
  check("POST /menu (was 500 42704) → created", item.status === 200 || item.status === 201, `status=${item.status} ${JSON.stringify(item.json?.message || "").slice(0, 160)}`);
  const itemId = item.json?.item?.id || item.json?.data?.id || item.json?.data?.menuItem?.id || item.json?.data?.item?.id;
  check("menu item id returned", !!itemId);

  // ── LIVE D: PUT /api/menu/:id (was 500 42704) (Part 24) ──
  if (itemId) {
    const edit = await api("PUT", `/menu/${itemId}`, { price: 280, dietaryType: "VEG" }, token);
    check(`PUT /menu/${itemId} → 200`, edit.status === 200, `status=${edit.status} ${JSON.stringify(edit.json?.message || "").slice(0, 160)}`);

    // ── LIVE E: cross-category subcategory rejected (Part 12) ──
    const cross = await api("PUT", `/menu/${itemId}`, { subcategoryId: sub2Id }, token);
    check("cross-category subcategoryId rejected (400)", cross.status === 400, `status=${cross.status} msg=${JSON.stringify(cross.json?.message || "").slice(0, 120)}`);
  }

  // ── LIVE F: VEG_ONLY restaurant rejects NON_VEG (Part 14) ──
  // restaurant_1 is now VEG_ONLY (set in LIVE B).
  const nonVeg = await api("POST", "/menu", {
    name: `QA Chicken ${Date.now()}`,
    price: 320,
    categoryId: catId,
    dietaryType: "NON_VEG",
  }, token);
  check("VEG_ONLY: NON_VEG item creation rejected (400)", nonVeg.status === 400, `status=${nonVeg.status} msg=${JSON.stringify(nonVeg.json?.message || "").slice(0, 120)}`);

  // ── LIVE G: restore dietaryMode ──
  const restoreMode = await api("POST", "/settings", { restaurantName: setting.restaurantName || "QA Restaurant", dietaryMode: origMode }, token);
  const s2 = await api("GET", "/settings", null, token);
  check("dietaryMode restored to original", restoreMode.status === 200 && (s2.json?.setting || s2.json?.data?.setting || {}).dietaryMode === origMode, `got ${(s2.json?.setting || s2.json?.data?.setting || {}).dietaryMode}`);

  // ── LIVE H: cleanup QA data ──
  if (itemId) await api("DELETE", `/menu/${itemId}`, null, token);
  if (subId) await api("DELETE", `/menu/subcategories/${subId}`, null, token);
  if (sub2Id) await api("DELETE", `/menu/subcategories/${sub2Id}`, null, token);
  if (catId) await api("DELETE", `/categories/${catId}`, null, token);
  if (cat2Id) await api("DELETE", `/categories/${cat2Id}`, null, token);
  console.log("  🧹 QA category/subcategory/item cleanup attempted");

  console.log(`\n──────── LIVE RESULTS: ${passed} passed, ${failed} failed ────────`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("Script error:", e.message); process.exit(1); });
