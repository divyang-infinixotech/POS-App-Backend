/**
 * Staff order-type access (Takeaway vs Dine In).
 *
 * BUSINESS RULE: DINE IN IS THE DEFAULT for every staff member — it needs no
 * assignment. Takeaway is opt-in via a single reserved tenant UserPermission
 * row (orders.takeaway). Reuses the existing table — NO new model.
 *
 * Semantics (backward compatible):
 *   - No orders.takeaway row (or enabled=false) → DINE_IN only. Existing
 *     legacy `orders.dine_in` rows are IGNORED on read (Dine In is implicit)
 *     and normalized away on save.
 *   - orders.takeaway enabled=true → DINE_IN + TAKEAWAY allowed.
 *   - ADMIN / SUPER_ADMIN / MANAGER are never restricted
 *     (mirrors ASSIGNMENT_EXEMPT_ROLES in floorAccess.js).
 */
const { ASSIGNMENT_EXEMPT_ROLES } = require("./floorAccess");

const ORDER_TYPE_TAKEAWAY_KEY = "orders.takeaway";
// Legacy key from an earlier two-checkbox design — read-tolerated, never
// required, and removed when assignments are re-saved.
const ORDER_TYPE_DINE_IN_KEY = "orders.dine_in";
const ORDER_TYPE_ASSIGNMENT_KEYS = [ORDER_TYPE_TAKEAWAY_KEY, ORDER_TYPE_DINE_IN_KEY];

// Order types that count as the "Takeaway" bucket (non floor/table orders).
const TAKEAWAY_ORDER_TYPES = ["TAKEAWAY", "DELIVERY", "COUNTER_SALE"];

/**
 * Extract the allowed order types from tenant UserPermission rows.
 * Dine In is always allowed (default), so the return value encodes only the
 * takeaway grant — [] (never null) so API consumers get one consistent shape:
 *   []            → DINE_IN only (no takeaway row, or legacy-only rows)
 *   ['TAKEAWAY']  → DINE_IN + TAKEAWAY
 */
function assignedOrderTypesFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const hasTakeaway = list.some((r) => r && r.permissionKey === ORDER_TYPE_TAKEAWAY_KEY && r.enabled === true);
  return hasTakeaway ? ["TAKEAWAY"] : [];
}

/**
 * Error message when a RESTRICTED staff member places a TAKEAWAY order
 * without the grant, or null when allowed. Unrestricted roles
 * (ADMIN/SUPER_ADMIN/MANAGER) always pass. DINE_IN always passes — it is the
 * default for all staff.
 */
async function orderTypeAccessError(tenantDb, user, orderType) {
  if (!tenantDb || !user || !orderType) return null;
  if (orderType === "DINE_IN") return null; // default access — never restricted
  const role = String(user.role || "").toUpperCase();
  if (ASSIGNMENT_EXEMPT_ROLES.includes(role)) return null;
  const rows = await tenantDb.userPermission.findMany({
    where: { userId: Number(user.id), permissionKey: ORDER_TYPE_TAKEAWAY_KEY },
    select: { permissionKey: true, enabled: true },
  });
  // assignedOrderTypesFromRows returns ['TAKEAWAY'] when granted, [] when not.
  const allowed = assignedOrderTypesFromRows(rows).includes("TAKEAWAY");
  return allowed ? null : "You are not assigned to Takeaway orders.";
}

module.exports = {
  ORDER_TYPE_TAKEAWAY_KEY,
  ORDER_TYPE_DINE_IN_KEY,
  ORDER_TYPE_ASSIGNMENT_KEYS,
  TAKEAWAY_ORDER_TYPES,
  assignedOrderTypesFromRows,
  orderTypeAccessError,
};
