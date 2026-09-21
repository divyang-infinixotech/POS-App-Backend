/**
 * Business-capability tests (spec §2/§3/§11/§15).
 * Standalone node script — same pattern as the other suites in this folder.
 * Pure mapping/validator checks; no database required.
 */
let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log("  ✔ " + name); }
  else { failed++; console.log("  ✗ FAIL: " + name); }
}

const {
  BUSINESS_CAPABILITIES,
  getBusinessCapabilities,
  supportsDietary,
  supportsKitchen,
  catalogNaming,
  getVisibleStaffRoles,
  staffDiscountRoles,
} = require("../utils/businessCapabilities");
const { normalizeBusinessType } = require("../utils/businessMode");

console.log("\n─── 1. Food verticals: full dietary/kitchen capability ───");
for (const t of ["RESTAURANT", "CAFE", "BAR", "FOOD_COURT"]) {
  const c = getBusinessCapabilities(t);
  check(c.food === true && c.dietary === true, `${t}: food + dietary`);
  check(c.kitchen === true && c.kot === true, `${t}: kitchen + KOT`);
  check(c.menu === true && c.products === false, `${t}: "Menu" catalog naming`);
}
check(supportsDietary("RESTAURANT") === true, "supportsDietary(RESTAURANT) = true");

console.log("\n─── 2. Bakery: BASIC_POS food business — kitchen/KOT, NO tables (spec §2/§11) ───");
const b = getBusinessCapabilities("BAKERY");
check(b.food === true && b.dietary === true, "BAKERY: food + dietary");
check(b.kitchen === true && b.kot === true, "BAKERY: kitchen/KOT (production workflow)");
check(b.tables === false && b.floors === false, "BAKERY: no tables/floors");
check(b.menu === true && b.barcode === true, "BAKERY: menu naming + barcode");

console.log("\n─── 3. Non-food verticals: NO food UI capability ───");
const NON_FOOD = ["CLOTHING", "SUPERMARKET", "GROCERY", "ELECTRONICS", "FURNITURE", "HARDWARE", "COSMETICS", "STATIONERY", "JEWELLERY", "OTHER", "HOTEL"];
for (const t of NON_FOOD) {
  const c = getBusinessCapabilities(t);
  check(c.food === false && c.dietary === false, `${t}: no food/dietary`);
  check(c.kitchen === false && c.kot === false, `${t}: no kitchen/KOT`);
  check(c.tables === false && c.floors === false, `${t}: no tables/floors`);
  check(c.products === true, `${t}: "Products" catalog naming`);
  check(c.barcode === true && c.inventory === true && c.customers === true, `${t}: retail basics present`);
}
check(supportsDietary("CLOTHING") === false, "supportsDietary(CLOTHING) = false");
check(supportsKitchen("SUPERMARKET") === false, "supportsKitchen(SUPERMARKET) = false");

console.log("\n─── 4. Variant support (retail verticals that need it) ───");
for (const t of ["CLOTHING", "ELECTRONICS", "FURNITURE", "COSMETICS", "JEWELLERY"]) {
  check(getBusinessCapabilities(t).variants === true, `${t}: variants`);
}
for (const t of ["SUPERMARKET", "GROCERY", "HARDWARE", "STATIONERY", "RESTAURANT"]) {
  check(getBusinessCapabilities(t).variants === false, `${t}: no variants flag`);
}

console.log("\n─── 5. Unknown/missing values fall back to generic retail ───");
check(getBusinessCapabilities("NONEXISTENT_TYPE").dietary === false, "unknown type → non-food defaults");
check(getBusinessCapabilities("").dietary === false, "empty string → non-food defaults");
check(getBusinessCapabilities(null).dietary === false, "null → non-food defaults");
check(getBusinessCapabilities(undefined).kitchen === false, "undefined → no kitchen");

console.log("\n─── 6. Case/whitespace tolerance ───");
check(getBusinessCapabilities("bakery").dietary === true, "lowercase 'bakery' resolves");
check(getBusinessCapabilities("  Clothing  ").dietary === false, "whitespace-padded resolves");

console.log("\n─── 7. Catalog naming helper ───");
check(catalogNaming("RESTAURANT").catalogLabel === "Menu & Stock", "restaurant → 'Menu & Stock'");
check(catalogNaming("CLOTHING").catalogLabel === "Products & Stock", "clothing → 'Products & Stock'");
check(catalogNaming("SUPERMARKET").itemLabel === "Products", "supermarket → 'Products' item label");

console.log("\n─── 8. No duplicate business-type fields / legacy readable ───");
check(BUSINESS_CAPABILITIES.HOTEL !== undefined, "legacy HOTEL stays resolvable (no destructive enum change)");
check(normalizeBusinessType("bakery") === "BAKERY", "normalizeBusinessType still works alongside capabilities");

console.log("\n─── 9. Onboarding validator accepts the retail umbrella + food types ───");
const { businessSchema } = require("../validators/onboarding.validator");
const validateBT = (v) => businessSchema.validate({ businessType: v, name: "Xyz Retail Co", email: "a@b.co", phone: "9999999999" }).error;
// Retail verticals are stored via OTHER today (schema enum not extended); the
// capability map already recognizes them for future enum extension.
check(!validateBT("OTHER"), "onboarding accepts OTHER (retail umbrella)");
check(!validateBT("BAKERY"), "onboarding accepts BAKERY");
check(!!validateBT("HOTEL"), "onboarding still rejects legacy HOTEL");

console.log("\n─── 10. Visible/selectable staff roles per business type (spec §1/§3) ───");
// ONE authoritative mapping: getVisibleStaffRoles. staffDiscountRoles delegates
// to it — the two must never diverge.
const restaurantRoles = getVisibleStaffRoles("RESTAURANT");
check(restaurantRoles.includes("MANAGER") && restaurantRoles.includes("CASHIER"), "RESTAURANT: Manager + Cashier visible");
check(restaurantRoles.includes("KITCHEN"), "RESTAURANT: Kitchen Staff visible (kitchen capability)");
check(restaurantRoles.includes("WAITER"), "RESTAURANT: Service Staff visible (service workflow)");
for (const t of ["SUPERMARKET", "GROCERY", "CLOTHING", "ELECTRONICS"]) {
  const roles = getVisibleStaffRoles(t);
  check(roles.includes("MANAGER") && roles.includes("CASHIER"), `${t}: Manager + Cashier visible`);
  check(!roles.includes("KITCHEN"), `${t}: Kitchen Staff NOT visible/selectable`);
}
check(getVisibleStaffRoles("BAKERY").includes("KITCHEN"), "BAKERY: Kitchen Staff visible (kitchen=true, production workflow)");
check(getVisibleStaffRoles("FOOD_TRUCK").includes("KITCHEN") && !getVisibleStaffRoles("FOOD_TRUCK").includes("WAITER"), "FOOD_TRUCK: kitchen visible, Service Staff NOT (no tables)");
check(getVisibleStaffRoles("CLOUD_KITCHEN").includes("KITCHEN") && !getVisibleStaffRoles("CLOUD_KITCHEN").includes("WAITER"), "CLOUD_KITCHEN: kitchen visible, Service Staff NOT");
check(getVisibleStaffRoles("UNKNOWN_TYPE").length === 2, "unknown type → Manager + Cashier only (retail default)");
const sdr = staffDiscountRoles("SUPERMARKET");
check(JSON.stringify(sdr) === JSON.stringify(getVisibleStaffRoles("SUPERMARKET")), "staffDiscountRoles shares ONE list with getVisibleStaffRoles");

console.log("\n─── 11. Staff-create capability enforcement (source invariants, spec §6) ───");
const userCtrlSrc = require("fs").readFileSync(require("path").join(__dirname, "../controllers/user.controller.js"), "utf8");
check(userCtrlSrc.includes("getVisibleStaffRoles") && userCtrlSrc.includes("resolveVisibleStaffRoles"), "user controller resolves capability roles server-side");
check(userCtrlSrc.includes("is not available for this business type"), "unsupported role submission rejected with a clear error");
check(userCtrlSrc.includes("prisma.restaurant.findUnique") && userCtrlSrc.includes("businessType: true"), "businessType resolved from the platform Restaurant row (never the client)");
check(userCtrlSrc.includes("TENANT_STAFF_ROLES.includes(role)"), "global RBAC tenant-staff enum validation unchanged");

console.log(`\nRESULTS: PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
