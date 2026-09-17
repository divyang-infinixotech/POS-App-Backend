/**
 * Centralized BusinessType → Capability resolution.
 *
 * Single source of truth for WHAT FEATURES a business type can use,
 * independent of (and composable with) plan entitlements and user permissions:
 *
 *   featureVisible = businessCapability && planCapability && userPermission
 *
 * Concepts kept strictly separate (do not merge them):
 *   businessType    — WHAT the business is (RESTAURANT, CAFE, CLOTHING, …)
 *   businessMode    — WHICH plan/POS experience it may buy (RESTAURANT, BASIC_POS)
 *                     (see businessMode.js — plan compatibility stays there)
 *   capabilities    — WHICH FEATURES this vertical may expose (this file)
 *   plan features   — WHICH FEATURES the tenant's subscription grants
 *   permissions     — WHICH FEATURES the signed-in staff member may use
 *
 * Capability flags (extensible — add flags here and they flow to every consumer):
 *   food       — sells food/beverages (menu semantics, food UI)
 *   dietary    — veg/non-veg classification is meaningful
 *   kitchen    — kitchen workflow screens/toggles exist
 *   kot        — kitchen tickets can be generated/printed
 *   tables     — dine-in tables
 *   floors     — physical floors containing tables
 *   menu       — "menu"-style catalog (food naming)
 *   products   — retail-style catalog naming (Products & Stock)
 *   barcode    — barcode scanning/lookup makes sense
 *   inventory  — stock quantities tracked
 *   stock      — low-stock / stock movements meaningful
 *   variants   — size/colour variant support (retail)
 *   customers  — customer master useful
 */

const BUSINESS_CAPABILITIES = {
  RESTAURANT: {
    food: true, dietary: true, kitchen: true, kot: true,
    tables: true, floors: true, menu: true, products: false,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  CAFE: {
    food: true, dietary: true, kitchen: true, kot: true,
    tables: true, floors: true, menu: true, products: false,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  BAR: {
    food: true, dietary: true, kitchen: true, kot: true,
    tables: true, floors: true, menu: true, products: false,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  FOOD_TRUCK: {
    food: true, dietary: true, kitchen: true, kot: true,
    tables: false, floors: false, menu: true, products: false,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  CLOUD_KITCHEN: {
    food: true, dietary: true, kitchen: true, kot: true,
    tables: false, floors: false, menu: true, products: false,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  FOOD_COURT: {
    food: true, dietary: true, kitchen: true, kot: true,
    tables: true, floors: true, menu: true, products: false,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  BAKERY: {
    food: true, dietary: true, kitchen: false, kot: false,
    tables: false, floors: false, menu: true, products: false,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  // ─── Non-food retail verticals ────────────────────────────────────────────
  CLOTHING: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: true,
    customers: true,
  },
  SUPERMARKET: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  GROCERY: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  ELECTRONICS: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: true,
    customers: true,
  },
  FURNITURE: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: true,
    customers: true,
  },
  HARDWARE: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  COSMETICS: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: true,
    customers: true,
  },
  STATIONERY: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  JEWELLERY: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: true,
    customers: true,
  },
  // OTHER / legacy HOTEL → generic retail-flavored capabilities. Legacy food
  // tenants stored as OTHER keep working: their DB data is untouched and the
  // plan/businessMode layer continues to drive the restaurant-mode UI where
  // the subscription actually grants it.
  OTHER: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
  HOTEL: {
    food: false, dietary: false, kitchen: false, kot: false,
    tables: false, floors: false, menu: false, products: true,
    barcode: true, inventory: true, stock: true, variants: false,
    customers: true,
  },
};

/** Fallback for unknown/legacy values — most restrictive (generic retail). */
const DEFAULT_CAPABILITIES = BUSINESS_CAPABILITIES.OTHER;

/**
 * Resolve the capability set for a business type.
 * Never throws; unknown values fall back to the generic retail set.
 * Accepts case/whitespace variants ("bakery" → BAKERY).
 */
function getBusinessCapabilities(businessType) {
  if (!businessType || typeof businessType !== "string") {
    return DEFAULT_CAPABILITIES;
  }
  const key = businessType.trim().toUpperCase();
  return BUSINESS_CAPABILITIES[key] || DEFAULT_CAPABILITIES;
}

/** Boolean convenience: does this business type expose dietary features? */
function supportsDietary(businessType) {
  return getBusinessCapabilities(businessType).dietary === true;
}

/** Boolean convenience: does this business type expose kitchen/KOT? */
function supportsKitchen(businessType) {
  const c = getBusinessCapabilities(businessType);
  return c.kitchen === true || c.kot === true;
}

/**
 * Catalog naming for UI: food verticals say "Menu", retail says "Products".
 * Returns { catalogLabel, itemLabel, catalogIconHint } for consistent copy.
 */
function catalogNaming(businessType) {
  const c = getBusinessCapabilities(businessType);
  if (c.menu) return { catalogLabel: "Menu & Stock", itemLabel: "Menu Items", collectionLabel: "Menu" };
  return { catalogLabel: "Products & Stock", itemLabel: "Products", collectionLabel: "Products" };
}

module.exports = {
  BUSINESS_CAPABILITIES,
  DEFAULT_CAPABILITIES,
  getBusinessCapabilities,
  supportsDietary,
  supportsKitchen,
  catalogNaming,
};
