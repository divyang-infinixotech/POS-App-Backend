/**
 * Feature catalog — metadata describing each SaaS module/feature key.
 *
 * NOTE: This is NOT plan configuration. Plan definitions (pricing, limits,
 * trial days, billing cycle, feature access) live in the `Plan` table and are
 * fully managed by the Super Admin. This file only maps feature keys to
 * human-readable labels and to the restaurant settings that should be
 * force-enabled/disabled when a plan is applied.
 */

// Mirrors the PlanModule catalog rows in the database (label/icon metadata only —
// enforcement is 100% database-driven via Subscription.features).
const PLAN_FEATURES = {
  dashboard:      { label: "Dashboard",                icon: "layout-dashboard" },
  pos:            { label: "POS Ordering",            icon: "shopping-cart" },
  billing:        { label: "Billing & Payments",      icon: "receipt" },
  floors:         { label: "Floor Management",        icon: "building" },
  tables:         { label: "Tables & Floors",         icon: "layers" },
  active_orders:  { label: "Active Orders",           icon: "clock" },
  kitchen:        { label: "Kitchen Module (KOT)",    icon: "chef-hat" },
  menu:           { label: "Menu Management",         icon: "utensils" },
  customers:      { label: "Customer Module",         icon: "contact" },
  staff:          { label: "Staff Management",        icon: "users" },
  reports:        { label: "Reports & Analytics",     icon: "bar-chart" },
  inventory:      { label: "Inventory / Stock",       icon: "boxes" },
  settings:       { label: "Settings",                icon: "settings" },
  printers:       { label: "Printer Management",      icon: "printer" },
  qr_ordering:    { label: "QR Ordering",             icon: "qr-code" },
  api_access:     { label: "API Access",              icon: "code" },  multi_terminal: { label: "Multi-Terminal",      icon: "monitor" },
  barcode_scanner: { label: "Barcode Scanner",      icon: "scan-barcode" },
};

// NOTE: This catalog intentionally mirrors the PlanModule rows in the database
// (17 keys). Legacy keys that exist in neither the DB catalog nor the frontend
// (multi_printer, analytics, online_ordering, multi_branch) were removed.

/** Plan feature key → RestaurantSetting module flags applied on plan change */
const FEATURE_SETTINGS_MAP = {
  pos:            ["enablePosOrdering"],
  kitchen:        ["enableKitchen"],
  billing:        ["enableBilling"],
  reports:        ["enableReports"],
  inventory:      ["enableStock"],
  floors:         ["enableFloorManagement"],
  tables:         ["enableFloorManagement"],
  menu:           ["enableMenu"],
  active_orders:  ["enableActiveOrders"],
};

/** Default feature set granted when a subscription has no snapshot (safety net) */
const DEFAULT_FEATURES = ["dashboard", "pos", "menu", "billing", "tables", "active_orders"];

/**
 * The ONLY module keys that correspond to a real, usable restaurant feature in
 * the current application (a working frontend screen/flow AND a backend API
 * gated with requireFeature). The Plan editor must not offer anything else:
 * keys absent from this list (qr_ordering, api_access, multi_terminal,
 * inventory, printers) are either future/placeholder modules or live inside
 * another module's screen (stock is part of Menu & Stock, printers live in
 * POS Settings) — they have no standalone feature to enable or disable.
 *
 * Platform-level features (Super Admin screens, gateway, plans, users, ...)
 * are deliberately NOT restaurant plan modules.
 */
const AVAILABLE_RESTAURANT_MODULES = [
  "dashboard",
  "pos",
  "billing",
  "floors",
  "tables",
  "kitchen",
  "active_orders",
  "menu",
  "customers",
  "staff",
  "reports",
  "settings",
  "barcode_scanner",
];

// ─── Business-mode capability map (SINGLE authoritative source) ─────────────
// Modules that only make sense with a full restaurant DINE-IN workflow
// (floors, tables). Kitchen/KOT is NOT restaurant-only: BASIC_POS food
// businesses (café/bakery/bar/food-truck/cloud-kitchen) run the production
// workflow Order → KOT → Active Orders → Ready → Bill in their default mode
// (spec §2/§11/§16), so a BASIC_POS plan CAN carry the kitchen module —
// retail tenants stay blocked from KOT by the businessType capability layer
// (requireBusinessCapability("kot") / requireBusinessCapability("kitchen")),
// never by the plan mode alone.
const RESTAURANT_ONLY_MODULES = ["floors", "tables"];

/**
 * Modules selectable for a plan/business mode.
 * businessMode: "RESTAURANT" | "BASIC_POS" | "QUICK_BILLING" (unknown → the
 * RESTAURANT superset is NOT granted; unknown falls back to the restrictive
 * basic set).
 */
function modulesForBusinessMode(businessMode) {
  const mode = String(businessMode || "BASIC_POS").toUpperCase();
  if (mode === "RESTAURANT") return [...AVAILABLE_RESTAURANT_MODULES];
  return AVAILABLE_RESTAURANT_MODULES.filter((m) => RESTAURANT_ONLY_MODULES.indexOf(m) === -1);
}

/**
 * Filter an arbitrary modules/features payload down to what the given plan
 * mode allows. Used by plan create/update so the DB can never hold a Basic
 * plan with restaurant-only entitlements.
 */
function filterModulesForBusinessMode(items, businessMode) {
  const allowed = modulesForBusinessMode(businessMode);
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => {
      const key = typeof item === "string" ? item : item && item.moduleKey;
      return allowed.indexOf(key) !== -1;
    });
}

module.exports = {
  PLAN_FEATURES,
  FEATURE_SETTINGS_MAP,
  DEFAULT_FEATURES,
  AVAILABLE_RESTAURANT_MODULES,
  RESTAURANT_ONLY_MODULES,
  modulesForBusinessMode,
  filterModulesForBusinessMode,
};
