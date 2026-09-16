/**
 * Live verification (Parts 7/8/16) against the running dev server:
 *   1. GET /api/menu/subcategories → 200 handled by getSubcategories (not getMenuItemById)
 *   2. Staff Roster toggle persists OFF → GET returns false → restore ON
 * Run: node qa/live-verify-subcategories-staff-roster.js
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
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, data };
}

const results = { pass: 0, fail: 0 };
function check(cond, label, extra) {
  process.stdout.write(cond ? "  ✅ " : "  ❌ ");
  console.log(label + (extra ? ` — ${extra}` : ""));
  cond ? results.pass++ : results.fail++;
}

(async () => {
  console.log("── LIVE 1: /api/menu/subcategories is handled by the subcategory controller ──");

  // 1. Super Admin login → login-as restaurant 1 ADMIN (established QA pattern:
  //    admin@restaurant.com's stored password was changed on this DB).
  const sa = await api("POST", "/auth/login", { email: "superadmin@pos.com", password: "SuperAdmin@123" });
  check(sa.status === 200, "Super Admin login", `status=${sa.status}`);
  const saToken = sa.data?.token || sa.data?.data?.token;
  if (!saToken) { console.log("Cannot proceed without a token."); process.exit(1); }

  const la = await api("GET", "/super-admin/restaurants/1/login-as", null, saToken);
  check(la.status === 200, "login-as Golden Grill ADMIN (restaurant 1)", `status=${la.status}`);
  const adminToken = la.data?.token || la.data?.data?.token;
  if (!adminToken) { console.log("Cannot proceed without an admin token."); process.exit(1); }

  // 2. The previously-500 endpoint.
  const subs = await api("GET", "/menu/subcategories", null, adminToken);
  check(subs.status === 200, "GET /api/menu/subcategories → 200", `status=${subs.status}`);
  check(!/id.*missing|Argument/i.test(JSON.stringify(subs.data)), "response is NOT the Prisma `id is missing` error");
  check(Array.isArray(subs.data?.data?.subcategories), "response shape: { data: { subcategories: [...] } }", `count=${subs.data?.data?.subcategories?.length}`);

  // 3. Optional categoryId filter narrows correctly (Part 9).
  const cats = await api("GET", "/categories", null, adminToken);
  const firstCat = cats.data?.data?.categories?.[0] || cats.data?.categories?.[0];
  if (firstCat) {
    const filtered = await api("GET", `/menu/subcategories?categoryId=${firstCat.id}`, null, adminToken);
    check(filtered.status === 200, `GET /menu/subcategories?categoryId=${firstCat.id} → 200`, `status=${filtered.status}`);
    const rows = filtered.data?.data?.subcategories || [];
    check(rows.every((s) => s.categoryId === firstCat.id), "all rows belong to the requested category");
  } else {
    check(true, "no categories on this tenant — categoryId filter skipped");
  }

  console.log("\n── LIVE 2: Staff Roster toggle persistence + restore (Part 7) ──");

  // 4. Baseline: current toggle value.
  const before = await api("GET", "/settings", null, adminToken);
  const baseline = before.data?.setting?.enableStaffRoster;
  check(typeof baseline === "boolean", "GET /settings exposes enableStaffRoster", `value=${baseline}`);

  // 5. Turn OFF → verify persisted → verify staff list blocked.
  const saveOff = await api("POST", "/settings", { restaurantName: before.data?.setting?.restaurantName || "QA Restaurant", enableStaffRoster: false }, adminToken);
  check(saveOff.status === 200, "POST /settings enableStaffRoster=false → 200", `status=${saveOff.status}`);

  const afterOff = await api("GET", "/settings", null, adminToken);
  check(afterOff.data?.setting?.enableStaffRoster === false, "GET after save returns enableStaffRoster=false (DB authoritative)");

  const usersBlocked = await api("GET", "/users", null, adminToken);
  check(usersBlocked.status === 403, "GET /users blocked with toggle OFF (restaurant toggle)", `status=${usersBlocked.status}`);
  check(/disabled in POS Settings/i.test(usersBlocked.data?.message || ""), "403 message names the disabled module");

  // 6. Restore original value (true unless it was explicitly false before this run).
  const restoreTo = baseline === false ? false : true;
  const saveRestore = await api("POST", "/settings", { restaurantName: before.data?.setting?.restaurantName || "QA Restaurant", enableStaffRoster: restoreTo }, adminToken);
  check(saveRestore.status === 200, `POST /settings enableStaffRoster=${restoreTo} (restore) → 200`, `status=${saveRestore.status}`);

  const afterRestore = await api("GET", "/settings", null, adminToken);
  check(afterRestore.data?.setting?.enableStaffRoster === restoreTo, "GET after restore returns original value");
  const usersOk = await api("GET", "/users", null, adminToken);
  check(usersOk.status === 200, "GET /users allowed again after restore", `status=${usersOk.status}`);

  console.log(`\n──────── LIVE RESULTS: ${results.pass} passed, ${results.fail} failed ────────`);
  process.exit(results.fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Live verification crashed:", err.message);
  process.exit(1);
});
