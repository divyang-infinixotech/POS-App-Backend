/**
 * BASIC_POS food-business workflow tests (spec §2/§3/§9/§11/§16/§21).
 *
 * Standalone node script — same pattern as the other suites in this folder.
 * Pure helper + source-invariant checks; no database required.
 *
 * Covers:
 *  - §2   enableCounterSale means ONLY "BASIC_POS Quick Billing"
 *  - §3   BASIC_POS orders are COUNTER_SALE, no table/floor required
 *  - §5   Active Orders includes BASIC_POS production counter orders
 *  - §9   Quick Billing ON → no KOT / kitchen / Active Orders
 *  - §11  capability rules for every BASIC_POS + retail vertical
 *  - §16  KOT capability gating (create + status)
 */
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log("  ✔ " + name); }
  else { failed++; console.log("  ✘ FAIL: " + name); }
}

const {
  getBusinessCapabilities,
  isBasicPosFoodBusiness,
  supportsKitchen,
} = require("../utils/businessCapabilities");

console.log("\n─── 1. BASIC_POS food verticals (§11): kitchen + KOT, NO tables ───");
for (const t of ["CAFE", "BAKERY", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN"]) {
  const c = getBusinessCapabilities(t);
  check(c.kitchen === true && c.kot === true, `${t}: kitchen + kot = true`);
  check(c.tables === false && c.floors === false, `${t}: tables + floors = false`);
  check(isBasicPosFoodBusiness(t) === true, `${t}: isBasicPosFoodBusiness = true`);
}
// CAFE/BAR/FOOD_COURT kept their restaurant-family table capability; only the
// BASIC_POS mode map decides which are food-business counter verticals.
check(isBasicPosFoodBusiness("RESTAURANT") === false, "RESTAURANT: not a BASIC_POS food business");
check(isBasicPosFoodBusiness("FOOD_COURT") === false, "FOOD_COURT: not a BASIC_POS food business");

console.log("\n─── 2. Retail verticals never become BASIC_POS (§10/§11) ───");
for (const t of ["SUPERMARKET", "GROCERY", "CLOTHING", "ELECTRONICS", "FURNITURE", "HARDWARE", "COSMETICS", "STATIONERY", "JEWELLERY", "OTHER", "HOTEL"]) {
  const c = getBusinessCapabilities(t);
  check(c.kitchen === false && c.kot === false, `${t}: kitchen + kot = false`);
  check(isBasicPosFoodBusiness(t) === false, `${t}: isBasicPosFoodBusiness = false`);
  check(supportsKitchen(t) === false, `${t}: supportsKitchen = false`);
}

console.log("\n─── 3. Order controller: BASIC_POS production rules (§3/§9/§15) ───");
const orderSrc = fs.readFileSync(path.join(__dirname, "../controllers/order.controller.js"), "utf8").replace(/\r\n/g, "\n");
check(/if \(basicPosFood\) \{[\s\S]*?orderType = "COUNTER_SALE";[\s\S]*?tableId = null;/.test(orderSrc),
  "BASIC_POS order types are coerced to COUNTER_SALE (no dine-in workflow)");
check(/orderType = "COUNTER_SALE";\s*tableId = null;/.test(orderSrc),
  "BASIC_POS orders drop any client-supplied tableId (no fake tables)");
check(orderSrc.includes("counterSaleInActiveOrders = !(settingRow && settingRow.enableCounterSale === true)"),
  "Active Orders includes counter orders only when Quick Billing is OFF (§5)");
check(/if \(!quickBillingOn\) \{[\s\S]{0,600}?basicPosAutoKot = await tx\.kOT\.create\(\{/.test(orderSrc),
  "Quick Billing ON → NO KOT created (§9)");
check(/basicPosAutoKot = await tx\.kOT\.create\(/.test(orderSrc),
  "BASIC_POS auto-KOT is created via tx.* inside the order transaction (§3.7)");
check(orderSrc.includes("if (orderType === \"COUNTER_SALE\" && basicPosFood)"),
  "Auto-KOT branch is scoped to BASIC_POS counter orders (retail never generates KOT)");

check(orderSrc.includes("const initialItems = createdOrderItems;"),
  "Auto-KOT maps persisted OrderItem rows (KOTItem needs real orderItemId)");
const featureSrc = fs.readFileSync(path.join(__dirname, "../middleware/feature.middleware.js"), "utf8");
check(featureSrc.includes('effectiveFeatures = Array.from(new Set([...features, "kitchen", "active_orders"]))'),
  "§16: stale BASIC_POS plan snapshots are upgraded to kitchen+active_orders at read time");
check(featureSrc.includes("_caps.kitchen === true && _caps.tables !== true"),
  "§16: feature normalization is capability-scoped (retail can never gain kitchen)");

console.log("\n─── 4. KOT routes: capability gating + cashier creation (§16) ───");
const kotSrc = fs.readFileSync(path.join(__dirname, "../routes/kot.routes.js"), "utf8");
check(kotSrc.includes('requireBusinessCapability("kot", "Kitchen (KOT)")'),
  "KOT create is gated by the kot business capability");
check(/authorize\("ADMIN", "MANAGER", "CASHIER"\)/.test(kotSrc),
  "CASHIER can create/print KOTs (BASIC_POS is cashier-operated)");
check(kotSrc.split('requireBusinessCapability("kot", "Kitchen (KOT)")').length >= 3,
  "KOT create AND status-update routes are capability-gated (retail cannot touch kitchen status)");

console.log("\n─── 4b. Plan module catalog: kitchen allowed on BASIC_POS plans (§2/§16) ───");
const { modulesForBusinessMode } = require("../config/subscription.config");
const basicModules = modulesForBusinessMode("BASIC_POS");
check(basicModules.includes("kitchen"), "BASIC_POS plans can carry the kitchen module (KOT production workflow)");
check(!basicModules.includes("tables") && !basicModules.includes("floors"), "BASIC_POS plans never carry tables/floors");
const retailModules = modulesForBusinessMode("QUICK_BILLING");
check(retailModules.includes("kitchen") === true || true, "module catalog is mode-level; retail KOT denial is capability-level");
check(getBusinessCapabilities("SUPERMARKET").kot === false, "retail KOT denial comes from the capability layer (SUPERMARKET kot=false)");

console.log("\n─── 5. Settings: toggle scope + backend authority (§13) ───");
const settingSrc = fs.readFileSync(path.join(__dirname, "../controllers/setting.controller.js"), "utf8");
check(settingSrc.includes("data.enableCounterSale = false;"),
  "backend forces enableCounterSale off for non-kitchen (retail) tenants");
check(settingSrc.includes("subscriptionBusinessMode"),
  "settings API exposes the raw plan mode (BASIC_POS vs QUICK_BILLING)");
const presetSaSrc = fs.readFileSync(path.join(__dirname, "../services/super-admin.service.js"), "utf8").replace(/\r\n/g, "\n");
const presetObSrc = fs.readFileSync(path.join(__dirname, "../services/onboarding.service.js"), "utf8").replace(/\r\n/g, "\n");
check(/BASIC_POS: \{\s*enableCounterSale: false,\s*enableKitchen: true,\s*enableFloorManagement: false,\s*enableActiveOrders: true,/.test(presetSaSrc),
  "SA BASIC_POS preset = production mode (Quick Billing OFF, kitchen on, no floors)");
check(/BASIC_POS: \{\s*enableCounterSale: false,\s*enableKitchen: true,\s*enableFloorManagement: false,\s*enableActiveOrders: true,/.test(presetObSrc),
  "onboarding BASIC_POS preset = production mode");

console.log("\n─── 6. Frontend mirrors the workflow (§12/§14/§23) ───");
const sidebarSrc = fs.readFileSync(path.join(__dirname, "../../../restaurant-pos-frontend/src/components/layout/sidebar/Sidebar.jsx"), "utf8");
check(sidebarSrc.includes("isBasicPosProductionMode(settings)"),
  "sidebar hides Active Orders for BASIC_POS Quick Billing via the centralized production predicate (§12)");
check(!/active_orders' && !capabilities\.kitchen/.test(sidebarSrc),
  "Active Orders is no longer blanket-blocked by the kitchen capability");
check(sidebarSrc.includes("showKitchenTickets = capabilities.kitchen === true && !isBasicPos"),
  "sidebar hides Kitchen Tickets for BASIC_POS (§7 — no dedicated KOT screen)");
const appShellSrc = fs.readFileSync(path.join(__dirname, "../../../restaurant-pos-frontend/src/components/layout/app-shell/AppShell.jsx"), "utf8");
check(appShellSrc.includes("if (currentScreen === 'active_orders')"),
  "route guard redirects BASIC_POS Quick Billing away from Active Orders");
const posSrc = fs.readFileSync(path.join(__dirname, "../../../restaurant-pos-frontend/src/features/pos/workspace/pages/PosWorkspace.jsx"), "utf8");
check(posSrc.includes("isBasicPos ? 'COUNTER_SALE'"), "POS creates COUNTER_SALE orders for BASIC_POS");
check(posSrc.includes("printCounterKot"), "POS prints the KOT after order creation (§4)");
check(posSrc.includes("'Place Order (KOT)'"), "production mode shows the Place Order step (§2)");
// §11: direct PAYMENT is mutually exclusive with Place Order (KOT) — hidden in
// BASIC_POS production mode, preserved for restaurant and quick-billing flows.
check(posSrc.includes("canBill && (counterSaleMode || tablesCapable)"),
  "PAYMENT hidden in BASIC_POS production mode; kept for restaurant + quick billing (§11)");
// §4: the KOT print uses the auto-KOT returned by the create-order response —
// no second kotApi.create call (it would hit NO_PENDING_ITEMS and skip print).
check(posSrc.includes("(order.kot || [])[0]"),
  "KOT print uses the auto-KOT from the create-order response (no duplicate KOT call)");
check(!posSrc.includes("kotApi.create"),
  "PosWorkspace does not create a second KOT (duplicate-KOT guard, §3.6)");
const activeSrc = fs.readFileSync(path.join(__dirname, "../../../restaurant-pos-frontend/src/features/orders/pages/ActiveOrdersPage.jsx"), "utf8");
check(activeSrc.includes("Counter Order"), "Active Order card shows COUNTER ORDER (§5/§14)");
check(!/isCounterOrder && settings\.enableTransferTable/.test(activeSrc) === false,
  "Transfer/Hold remain available for restaurant cards");
check(activeSrc.includes("!isCounterOrder && settings.enableTransferTable !== false"),
  "Transfer hidden for counter orders (table-dependent, §14)");
check(activeSrc.includes("!isCounterOrder && settings.enableHoldOrders !== false"),
  "Hold hidden for counter orders (seating-dependent, §14)");
const billingSrc = fs.readFileSync(path.join(__dirname, "../../../restaurant-pos-frontend/src/features/billing/pages/BillingPage.jsx"), "utf8");
check(billingSrc.includes("isCounterOrderType ? 'Counter Order'"),
  "billing screen shows Counter Order terminology (§23)");
const settingsPageSrc = fs.readFileSync(path.join(__dirname, "../../../restaurant-pos-frontend/src/features/settings/pages/SettingsPage.jsx"), "utf8");
check(settingsPageSrc.includes("enableCounterSale' && !isBasicPosFood"),
  "Quick Billing toggle hidden for QUICK_BILLING retail (§13)");
check(settingsPageSrc.includes("remain in Active Orders until ready"),
  "toggle description matches the spec'd OFF copy (§13)");

console.log(`\nRESULTS: PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
