/**
 * Staff permission model (tenant-scoped).
 *
 * THREE permission layers combine into the EFFECTIVE permission:
 *   1. ROLE DEFAULTS (below) — what each role gets out of the box,
 *   2. per-USER overrides (tenant.UserPermission rows: absent = role default,
 *      enabled=true/false = explicit grant/deny),
 *   3. restaurant MODULE toggles (tenant RestaurantSetting.enableKitchen etc.)
 *      which remain authoritative — a module disabled restaurant-wide blocks
 *      everyone regardless of user permission.
 *
 * ADMIN always resolves to full access (Part 21) and is never restricted by
 * its own (or anyone's) UserPermission rows. SUPER_ADMIN is platform-level.
 */

// ─── Screen permission keys (sidebar screens) ───────────────────────────────
const SCREEN_KEYS = [
  "dashboard.view",
  "pos.view",
  "kitchen.view",
  "tables.view",
  "active_orders.view",
  "menu.view",
  "staff.view",
  "reports.view",
  "settings.view",
];

// Screen key → uiStore screen name + RestaurantSetting module toggle.
// usedBy the sidebar/permission middleware to map a screen to its gates.
const SCREEN_MAP = {
  "dashboard.view": { screen: "dashboard", module: null },
  "pos.view": { screen: "order_taking", module: "enablePosOrdering" },
  "kitchen.view": { screen: "orders", module: "enableKitchen" },
  "tables.view": { screen: "tables", module: "enableFloorManagement" },
  "active_orders.view": { screen: "active_orders", module: "enableActiveOrders" },
  "menu.view": { screen: "menu", module: "enableMenu" },
  "staff.view": { screen: "staff", module: null },
  "reports.view": { screen: "reports", module: "enableReports" },
  "settings.view": { screen: "settings", module: null },
};

// ─── Action permission keys ─────────────────────────────────────────────────
const ACTION_KEYS = {
  // Order actions
  "orders.create": "Create Order",
  "orders.add_item": "Add Item",
  "orders.print_kot": "Print KOT",
  "orders.hold": "Hold Order",
  "orders.resume": "Resume Hold Order",
  "orders.cancel": "Cancel Order",
  "orders.transfer": "Transfer Table",
  "orders.merge": "Merge Tables",
  "orders.split": "Split Tables",
  // Billing actions
  "billing.view": "Open Bill",
  "billing.collect": "Collect Payment",
  "billing.print": "Print Bill",
  "billing.reprint": "Reprint Bill",
  "billing.discount": "Discount",
  "billing.refund": "Refund",
  // Menu actions
  "menu.create": "Create Item",
  "menu.edit": "Edit Item",
  "menu.delete": "Delete Item",
  "category.manage": "Manage Categories",
  "subcategory.manage": "Manage Subcategories",
  "menu.stock": "Manage Stock",
  // Staff actions
  "staff.create": "Create Staff",
  "staff.edit": "Edit Staff",
  "staff.status": "Change Status",
  "staff.password": "Change Password",
  "staff.delete": "Delete Staff",
  // Report actions
  "reports.sales": "View Sales Reports",
  "reports.payments": "View Payment Reports",
  "reports.staff": "View Staff Reports",
  "reports.management": "View Management Reports",
  "reports.export": "Export Reports",
  // Settings actions
  "settings.edit": "Change POS Settings",
  "settings.restaurant": "Change Restaurant Settings",
  "settings.kitchen": "Change Kitchen Settings",
  "settings.billing": "Change Billing Settings",
};

const ALL_PERMISSION_KEYS = [...SCREEN_KEYS, ...Object.keys(ACTION_KEYS)];

// Human-readable labels for the permission UI.
const PERMISSION_LABELS = {
  "dashboard.view": "Dashboard",
  "pos.view": "POS Ordering",
  "kitchen.view": "Kitchen Tickets / KOT",
  "tables.view": "Floors & Tables",
  "active_orders.view": "Active Orders",
  "menu.view": "Menu & Stock",
  "staff.view": "Staff Roster",
  "reports.view": "Reports & Sales",
  "settings.view": "POS Settings",
  ...ACTION_KEYS,
};

// Action permissions grouped for the expandable Permissions UI.
const ACTION_GROUPS = [
  { group: "Order Actions", keys: ["orders.create", "orders.add_item", "orders.print_kot", "orders.hold", "orders.resume", "orders.cancel", "orders.transfer", "orders.merge", "orders.split"] },
  { group: "Billing Actions", keys: ["billing.view", "billing.collect", "billing.print", "billing.reprint", "billing.discount", "billing.refund"] },
  { group: "Menu Actions", keys: ["menu.create", "menu.edit", "menu.delete", "category.manage", "subcategory.manage", "menu.stock"] },
  { group: "Staff Actions", keys: ["staff.create", "staff.edit", "staff.status", "staff.password", "staff.delete"] },
  { group: "Report Actions", keys: ["reports.sales", "reports.payments", "reports.staff", "reports.management", "reports.export"] },
  { group: "Settings Actions", keys: ["settings.edit", "settings.restaurant", "settings.kitchen", "settings.billing"] },
];

// ─── Role defaults (Part 3) — used for new staff AND for the one-time
// backfill of existing staff so nobody loses their current access. ──────────
const ROLE_DEFAULTS = {
  ADMIN: "FULL", // full access — never restricted by per-user rows
  MANAGER: [
    "dashboard.view", "pos.view", "kitchen.view", "tables.view",
    "active_orders.view", "menu.view", "staff.view", "reports.view", "settings.view",
    "orders.create", "orders.add_item", "orders.print_kot", "orders.hold", "orders.resume", "orders.cancel", "orders.transfer", "orders.merge", "orders.split",
    "billing.view", "billing.collect", "billing.print", "billing.reprint", "billing.discount",
    "menu.create", "menu.edit", "menu.delete", "category.manage", "subcategory.manage", "menu.stock",
    "staff.create", "staff.edit", "staff.status", "staff.password",
    "reports.sales", "reports.payments", "reports.staff", "reports.management", "reports.export",
    "settings.edit", "settings.kitchen",
  ],
  CASHIER: [
    "dashboard.view", "pos.view", "tables.view", "active_orders.view", "reports.view",
    "orders.create", "orders.add_item", "orders.hold", "orders.resume",
    "billing.view", "billing.collect", "billing.print", "billing.reprint",
    "reports.sales",
  ],
  KITCHEN: [
    "kitchen.view", "active_orders.view",
    "orders.add_item",
  ],
  WAITER: [
    "pos.view", "tables.view", "active_orders.view",
    "orders.create", "orders.add_item",
    "orders.print_kot", // KOT printing only — explicitly enabled by default per Part 3
  ],
};

function roleDefaultsFor(role) {
  const key = String(role || "").toUpperCase();
  if (key === "ADMIN" || key === "SUPER_ADMIN") return "FULL";
  return ROLE_DEFAULTS[key] || [];
}

// ─── Dietary access ─────────────────────────────────────────────────────────
const DIETARY_ACCESS = {
  VEG_ONLY: "VEG_ONLY",
  VEG_AND_NON_VEG: "VEG_AND_NON_VEG",
};

/**
 * Resolve the user's effective dietary access from a tenant User row.
 * ADMIN (public plane) defaults to VEG_AND_NON_VEG.
 */
function effectiveDietaryAccess(user) {
  return user && user.dietaryAccess === "VEG_ONLY" ? "VEG_ONLY" : "VEG_AND_NON_VEG";
}

/**
 * Resolve the EFFECTIVE permission set for a staff user.
 *
 * @param {object} user      tenant User row (role, id)
 * @param {Array}  permRows  tenant UserPermission rows for this user
 * @returns {{ full: boolean, permissions: Set<string> }}
 */
function resolveEffectivePermissions(user, permRows = []) {
  const role = String(user && user.role ? user.role : "").toUpperCase();
  if (role === "ADMIN" || role === "SUPER_ADMIN") {
    return { full: true, permissions: new Set(ALL_PERMISSION_KEYS) };
  }

  const defaults = new Set(roleDefaultsFor(role));
  const overrides = Array.isArray(permRows) ? permRows : [];
  for (const row of overrides) {
    if (!row || !row.permissionKey) continue;
    if (row.enabled === true) defaults.add(row.permissionKey);
    else if (row.enabled === false) defaults.delete(row.permissionKey);
  }
  return { full: false, permissions: defaults };
}

/**
 * Does the user hold an effective permission?
 * ADMIN/SUPER_ADMIN always true (Part 21 — never restricted by own rows).
 */
function hasEffectivePermission(effective, role, key) {
  if (!key) return false;
  const upperRole = String(role || "").toUpperCase();
  if (effective.full || upperRole === "ADMIN" || upperRole === "SUPER_ADMIN") return true;
  return effective.permissions.has(key);
}

module.exports = {
  SCREEN_KEYS,
  SCREEN_MAP,
  ACTION_KEYS,
  ALL_PERMISSION_KEYS,
  PERMISSION_LABELS,
  ACTION_GROUPS,
  ROLE_DEFAULTS,
  DIETARY_ACCESS,
  roleDefaultsFor,
  effectiveDietaryAccess,
  resolveEffectivePermissions,
  hasEffectivePermission,
};
