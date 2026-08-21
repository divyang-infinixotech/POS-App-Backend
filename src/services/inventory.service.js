const prisma = require("../config/prisma");

/**
 * Inventory workflow — stock is reserved when an ORDER IS PLACED, not at payment.
 *
 * Movement types:
 *   ORDER_CREATED   — initial reservation when an order is placed (all order types)
 *   ORDER_UPDATED   — incremental changes on an existing order (add item / qty change)
 *   ORDER_CANCELLED — stock restored when an order is cancelled or deleted
 *   STOCK_ADJUSTMENT — manual stock corrections (reserved for future use)
 *
 * All operations:
 *   - are scoped by restaurantId (multi-tenant safe)
 *   - never let stock go below zero (clamped at 0)
 *   - write an append-only StockMovement row per line item
 *   - are idempotent (order-level claims prevent double deduction / double restore)
 */

/**
 * Core primitive: apply a signed delta to one menu item's stock and record a movement.
 *
 * @param {Prisma.TransactionClient} tx
 * @param {object} opts
 * @param {number} opts.restaurantId
 * @param {number} opts.menuItemId
 * @param {number|null} opts.orderId
 * @param {number} opts.delta - signed quantity (negative = deduct, positive = restore)
 * @param {string} opts.type - ORDER_CREATED | ORDER_UPDATED | ORDER_CANCELLED | STOCK_ADJUSTMENT
 * @param {string|null} opts.reference
 * @param {number|null} opts.createdBy
 * @returns {Promise<{before:number, after:number, delta:number}|null>} null when item untracked/not found
 */
async function applyStockDelta(
  tx,
  { restaurantId, menuItemId, orderId = null, delta, type, reference = null, createdBy = null }
) {
  const menuItem = await tx.menuItem.findUnique({
    where: { id: Number(menuItemId) },
    select: { id: true, currentStock: true, restaurantId: true },
  });
  if (!menuItem || menuItem.restaurantId !== Number(restaurantId)) return null;

  const before = menuItem.currentStock;
  // Null stock = not tracked; treat as unlimited and leave untouched.
  if (before === null || before === undefined) return null;

  // Clamp at zero so stock can never go negative. The ACTUAL applied delta
  // (after - before) is what gets recorded — when a large deduction is
  // clamped (e.g. reserve 99999 but only 25 in stock), the movement records
  // only the -25 actually applied. Restores then add back exactly what was
  // deducted, never inflating stock beyond the original level.
  const after = Math.max(0, Number(before) + Number(delta)); // never negative
  const appliedDelta = after - Number(before);

  if (after !== Number(before)) {
    await tx.menuItem.update({
      where: { id: menuItem.id },
      data: { currentStock: after },
    });
  }

  await tx.stockMovement.create({
    data: {
      restaurantId: Number(restaurantId),
      menuItemId: menuItem.id,
      orderId: orderId ? Number(orderId) : null,
      type,
      quantity: appliedDelta,
      stockBefore: Number(before),
      stockAfter: after,
      reference: reference || null,
      createdBy: createdBy ? Number(createdBy) : null,
    },
  });

  return { before: Number(before), after, delta: appliedDelta };
}

/**
 * Reserve stock for a newly placed order (all order types: DINE_IN, TAKEAWAY,
 * DELIVERY, COUNTER_SALE). Called inside the order-creation transaction.
 *
 * Idempotent: guarded by the atomic `stockDeductedAt` claim — exactly one caller
 * wins, so a retried order-create can never double-deduct.
 */
async function deductStockForOrderCreation(tx, order, restaurantId, createdBy = null) {
  if (!order || !order.id) {
    throw new Error("Order is required to reserve stock");
  }

  const orderId = Number(order.id);

  // Atomic claim: only reserve once per order
  const claim = await tx.order.updateMany({
    where: { id: orderId, stockDeductedAt: null },
    data: { stockDeductedAt: new Date() },
  });
  if (claim.count === 0) {
    return { deducted: 0, movements: 0, skipped: true };
  }

  const items = order.orderItems || [];
  let deducted = 0;
  let movements = 0;

  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    const menuItemId = Number(item.menuItemId);
    if (!menuItemId || qty <= 0) continue;

    const res = await applyStockDelta(tx, {
      restaurantId,
      menuItemId,
      orderId,
      delta: -qty,
      type: "ORDER_CREATED",
      reference: `Order ${order.orderNo || orderId} created`,
      createdBy,
    });
    if (res) {
      deducted += qty;
      movements += 1;
    }
  }

  return { deducted, movements, skipped: false };
}

/**
 * Deduct stock for only the newly added items on an existing order.
 * The original quantity is never deducted again.
 */
async function deductStockForAddedItems(tx, order, additions, restaurantId, createdBy = null) {
  const orderId = Number(order.id);
  let deducted = 0;
  let movements = 0;

  for (const a of additions || []) {
    const qty = Number(a.quantity) || 0;
    const menuItemId = Number(a.menuItemId);
    if (!menuItemId || qty <= 0) continue;

    const res = await applyStockDelta(tx, {
      restaurantId,
      menuItemId,
      orderId,
      delta: -qty,
      type: "ORDER_UPDATED",
      reference: `Order ${order.orderNo || orderId} item added`,
      createdBy,
    });
    if (res) {
      deducted += qty;
      movements += 1;
    }
  }

  return { deducted, movements };
}

/**
 * Apply signed per-item deltas when an existing order's items change
 * (quantity edited, item removed, or full order replacement).
 * Positive delta = restore to stock; negative delta = deduct more.
 */
async function adjustStockForOrderChange(tx, order, deltas, restaurantId, createdBy = null) {
  const orderId = Number(order.id);
  let applied = 0;
  let movements = 0;

  for (const d of deltas || []) {
    const menuItemId = Number(d.menuItemId);
    const delta = Number(d.delta) || 0;
    if (!menuItemId || delta === 0) continue;

    const res = await applyStockDelta(tx, {
      restaurantId,
      menuItemId,
      orderId,
      delta,
      type: "ORDER_UPDATED",
      reference: `Order ${order.orderNo || orderId} updated`,
      createdBy,
    });
    if (res) {
      applied += Math.abs(delta);
      movements += 1;
    }
  }

  return { applied, movements };
}

/**
 * Restore reserved stock when an order is cancelled or deleted.
 *
 * Idempotent: guarded by the atomic `stockRestoredAt` claim — a cancelled order
 * that is later deleted (or a retried cancel) restores exactly once.
 * Only restores orders that actually had stock deducted (stockDeductedAt set).
 */
async function restoreStockForCancelledOrder(tx, order, restaurantId, createdBy = null) {
  if (!order || !order.id) {
    throw new Error("Order is required to restore stock");
  }

  const orderId = Number(order.id);

  // Atomic claim: only restore once per order, and only if stock was deducted
  const claim = await tx.order.updateMany({
    where: { id: orderId, stockDeductedAt: { not: null }, stockRestoredAt: null },
    data: { stockRestoredAt: new Date() },
  });
  if (claim.count === 0) {
    return { restored: 0, movements: 0, skipped: true };
  }

  // Restore exactly what was actually deducted, per item. The order's own
  // items carry the REQUESTED quantities, which can exceed what was really
  // applied (deductions are clamped at zero stock). The stock movements hold
  // the truth — net them out (negative = deducted) and add the reverse.
  const movements = await tx.stockMovement.findMany({
    where: {
      orderId,
      type: { in: ["ORDER_CREATED", "ORDER_UPDATED"] },
    },
    select: { menuItemId: true, quantity: true },
  });

  const netByItem = {};
  for (const m of movements) {
    const id = Number(m.menuItemId);
    if (!id) continue;
    netByItem[id] = (netByItem[id] || 0) + Number(m.quantity);
  }

  let restored = 0;
  let movementCount = 0;

  for (const [menuItemId, netQty] of Object.entries(netByItem)) {
    const toRestore = -netQty; // negate the net deduction
    if (!toRestore) continue;
    const res = await applyStockDelta(tx, {
      restaurantId,
      menuItemId: Number(menuItemId),
      orderId,
      delta: toRestore,
      type: "ORDER_CANCELLED",
      reference: `Order ${order.orderNo || orderId} cancelled`,
      createdBy,
    });
    if (res) {
      restored += Math.abs(toRestore);
      movementCount += 1;
    }
  }

  return { restored, movements: movementCount, skipped: false };
}

/**
 * Convenience wrapper: restore inside its own transaction
 * (used by non-transactional endpoints like cancel/delete).
 */
async function restoreOrderStockAtomic(orderId, restaurantId, createdBy = null) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: Number(orderId) },
      include: { orderItems: true },
    });
    if (!order) return { restored: 0, movements: 0, skipped: true };
    return restoreStockForCancelledOrder(tx, order, restaurantId, createdBy);
  });
}

module.exports = {
  applyStockDelta,
  deductStockForOrderCreation,
  deductStockForAddedItems,
  adjustStockForOrderChange,
  restoreStockForCancelledOrder,
  restoreOrderStockAtomic,
};
