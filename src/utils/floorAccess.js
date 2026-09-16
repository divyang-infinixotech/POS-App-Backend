/**
 * Floor assignment access (Staff → Floor many-to-many).
 *
 * Model: tenant.UserFloorAssignment (unique userId+floorId; a staff member may
 * work multiple floors and a floor may have multiple staff).
 *
 * Enforcement policy (opt-in — "do not unexpectedly restrict existing roles"):
 *   - SUPER_ADMIN / ADMIN / MANAGER: restaurant-wide, NEVER filtered by
 *     assignments (managers are floor-unrestricted by existing role design).
 *   - Any other staff (CASHIER / KITCHEN / WAITER): once the Admin assigns them
 *     floors, table/floor visibility is restricted to those floors. With NO
 *     assignments they keep today's restaurant-wide visibility — assigning
 *     floors narrows access, it never widens anything.
 */
const ASSIGNMENT_EXEMPT_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER"];

function isFloorRestrictedRole(role) {
  return !ASSIGNMENT_EXEMPT_ROLES.includes(role);
}

/** All floorIds a user is assigned to, or null when the user is unrestricted. */
async function getAssignedFloorIds(tenantDb, userId, role) {
  if (!isFloorRestrictedRole(role)) return null;
  const rows = await tenantDb.userFloorAssignment.findMany({
    where: { userId: Number(userId) },
    select: { floorId: true },
  });
  return rows.map((r) => r.floorId);
}

/**
 * Table list scoping for GET /tables: returns null (no filtering) for
 * unrestricted roles or staff without assignments; otherwise an exact-floor
 * Prisma where-fragment.
 */
async function tableScopeFor(tenantDb, user) {
  const floorIds = await getAssignedFloorIds(tenantDb, user.id, user.role);
  if (floorIds === null || floorIds.length === 0) return null;
  return { floorId: { in: floorIds } };
}

/** 403 responder when a restricted staff member targets an unassigned floor. */
function floorAccessDenied(res) {
  return res.status(403).json({
    success: false,
    message: "You are not assigned to this floor.",
  });
}

/**
 * Order-list scoping (Part 12: active orders / order lists).
 * Returns null (no filtering) for unrestricted roles or staff without
 * assignments; otherwise a Prisma where-fragment that keeps table-bound
 * orders on assigned floors. Table-less orders (TAKEAWAY / DELIVERY /
 * COUNTER_SALE) are not floor-specific and stay visible.
 */
async function orderFloorScopeFor(tenantDb, user) {
  const floorIds = await getAssignedFloorIds(tenantDb, user.id, user.role);
  if (floorIds === null || floorIds.length === 0) return null;
  return {
    OR: [{ tableId: null }, { table: { floorId: { in: floorIds } } }],
  };
}

/**
 * Single-order floor guard (Part 12/13): a restricted staff member with
 * assignments may not operate an order whose table sits on an unassigned
 * floor. Returns an error message (respond 403) or null when allowed.
 * Unrestricted roles, staff without assignments, and table-less orders pass.
 */
async function orderFloorAccessError(tenantDb, user, order) {
  if (!order || !order.tableId) return null;
  const floorIds = await getAssignedFloorIds(tenantDb, user.id, user.role);
  if (floorIds === null || floorIds.length === 0) return null;
  const table = await tenantDb.restaurantTable.findUnique({
    where: { id: order.tableId },
    select: { floorId: true },
  });
  if (table && table.floorId != null && !floorIds.includes(table.floorId)) {
    return "You are not assigned to this floor.";
  }
  return null;
}

module.exports = {
  ASSIGNMENT_EXEMPT_ROLES,
  isFloorRestrictedRole,
  getAssignedFloorIds,
  tableScopeFor,
  orderFloorScopeFor,
  orderFloorAccessError,
  floorAccessDenied,
};
