/**
 * TEST-ONLY (§15): verify every business type receives the compatible active
 * plans that actually exist in the database. READ-ONLY — GET requests and
 * SELECT queries only. Expected counts come from the DB, never hardcoded.
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const BASE = "http://localhost:5001/api";

let passed = 0, failed = 0;
function check(cond, name) { cond ? passed++ : failed++; console.log(`  ${cond ? "✔" : "✗ FAIL:"} ${name}`); }

(async () => {
  // DB truth (SELECT-only)
  const activePlans = await prisma.plan.findMany({
    where: { isActive: true },
    select: { id: true, name: true, code: true, businessMode: true, yearlyPrice: true },
    orderBy: { id: "asc" },
  });
  console.log("DB ACTIVE PLANS:");
  for (const p of activePlans) console.log(`  ${p.name} | mode=${p.businessMode} | yearly=${p.yearlyPrice}`);
  const countByMode = {};
  for (const p of activePlans) countByMode[p.businessMode] = (countByMode[p.businessMode] || 0) + 1;

  const { resolveBusinessMode, BUSINESS_TYPES } = require("../src/utils/businessMode");
  const types = BUSINESS_TYPES.filter((t) => t !== "HOTEL");

  console.log("\nBUSINESS TYPE → MODE → API PLANS (live API):");
  for (const bt of types) {
    const mode = resolveBusinessMode(bt);
    const res = await fetch(`${BASE}/onboarding/plans?businessType=${bt}`);
    const j = await res.json().catch(() => null);
    const list = Array.isArray(j && j.data) ? j.data : [];
    const expected = countByMode[mode] || 0;

    console.log(`\n${bt} → ${mode}`);
    check(res.status === 200, `${bt}: API 200`);
    check(list.length === expected, `${bt}: plan count matches DB (${list.length} === ${expected})`);
    check(list.every((p) => (p.businessMode || "").toUpperCase() === mode), `${bt}: every plan is ${mode}-mode`);
    check(list.every((p) => typeof p.yearlyPrice === "number" && p.yearlyPrice > 0), `${bt}: yearly price present from DB`);
    const names = list.map((p) => `${p.name}(₹${p.yearlyPrice}/yr)`).join(", ") || "(none)";
    console.log(`    plans: ${names}`);
  }

  // Subscription-side (admin) filtering: real tenant tokens, GET-only
  console.log("\nADMIN SUBSCRIPTION FILTERING (real tenants, GET-only):");
  const creds = [
    { email: "rohan.shah+greenbasket@gmail.com", password: "GreenBasket#2026", label: "GreenBasket (OTHER→BASIC_POS)", wantMode: "BASIC_POS" },
    { email: "vikram.joshi+spicegarden@gmail.com", password: "SpiceGarden#2026", label: "Spice Garden (RESTAURANT)", wantMode: "RESTAURANT" },
  ];
  for (const c of creds) {
    const login = await fetch(`${BASE}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: c.email, password: c.password }),
    }).then((r) => r.json()).catch(() => null);
    if (!login || !login.token) { check(false, `${c.label}: login`); continue; }
    const me = await fetch(`${BASE}/subscriptions/me`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json()).catch(() => null);
    const myMode = me && me.data && (me.data.businessMode || (me.data.plan && me.data.plan.businessMode));
    check(myMode === c.wantMode, `${c.label}: server-resolved mode = ${myMode}`);
    const plans = await fetch(`${BASE}/subscriptions/plans`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json()).catch(() => null);
    const plist = Array.isArray(plans && plans.data) ? plans.data : [];
    check(plist.length === countByMode[c.wantMode], `${c.label}: plans match DB count (${plist.length} === ${countByMode[c.wantMode]})`);
    check(plist.every((p) => (p.businessMode || "").toUpperCase() === c.wantMode), `${c.label}: no cross-mode plans offered`);
    const meta = await fetch(`${BASE}/subscriptions/plans/meta`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json()).catch(() => null);
    check(meta && meta.data && meta.data.businessMode === c.wantMode, `${c.label}: /plans/meta agrees`);
  }

  console.log(`\n══ RESULTS: ${passed} passed, ${failed} failed ══`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e && e.stack ? e.stack : e); process.exit(1); });
