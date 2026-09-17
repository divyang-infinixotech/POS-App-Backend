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

console.log("\n─── 2. Bakery: food/dietary but NO tables/kitchen (spec §2) ───");
const b = getBusinessCapabilities("BAKERY");
check(b.food === true && b.dietary === true, "BAKERY: food + dietary");
check(b.kitchen === false && b.kot === false, "BAKERY: no kitchen/KOT");
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

console.log(`\nRESULTS: PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
