/**
 * Discounts & Promotions — DiscountEngine service.
 *
 * The SINGLE backend source of truth for applying discounts to orders:
 *   Order → DiscountEngine → find eligible discounts → validate rules →
 *   calculate amount → persist OrderDiscount → recalculate bill totals.
 *
 * All pure rule logic lives in ../utils/discountRules.js; this service only
 * orchestrates tenant-DB reads/writes and transactions (spec §20).
 *
 * Concurrency (§34/§16): usage counters are incremented with a guarded
 * UPDATE … WHERE usage_count < usage_limit inside a transaction, so two
 * simultaneous orders can never both claim the last use. Stacking and
 * double-application guards run inside the same transaction.
 */
const {
  evaluateEligibility,
  calculateDiscountAmount,
  canStackWith,
  discountLabel,
  normalizePromoCode,
  staffRoleMaxPercent,
  effectiveStatus,
  round2,
  parseStaffUserIds,
} = require("../utils/discountRules");
const { recalculateOrder } = require("./order.service");
const { staffDiscountRoles } = require("../utils/businessCapabilities");
const prisma = require("../config/prisma");

// Receivable STAFF-discount roles common to every vertical (ADMIN is kept
// receivable as before — see STAFF_DISCOUNT_BASE_ROLES in the controller).
const STAFF_DISCOUNT_BASE_ROLES = ["ADMIN", "MANAGER", "CASHIER"];

// IST offset used consistently across the app's business-date logic.
const IST_OFFSET_MINUTES = 330;

/** Recompute the order total from subtotal − discount + tax + service charge. */
function computeTotalAmount(order, discountAmount) {
  return round2(
    Math.max(
      0,
      Number(order.subtotal || 0) -
        Number(discountAmount || 0) +
        Number(order.taxAmount || 0) +
        Number(order.serviceCharge || 0)
    )
  );
}

/**
 * Load scope junction ids for a set of discounts in one round-trip.
 * Returns Map<discountId, number[]> (category or product ids per scope).
 */
async function loadScopeIds(db, discounts) {
  const scoped = discounts.filter((d) => d.scope === "CATEGORIES" || d.scope === "PRODUCTS");
  const map = new Map();
  for (const d of discounts) map.set(d.id, []);
  for (const d of scoped) {
    if (d.scope === "CATEGORIES") {
      const rows = await db.discountCategory.findMany({
        where: { discountId: d.id },
        select: { categoryId: true },
      });
      map.set(d.id, rows.map((r) => r.categoryId));
    } else {
      const rows = await db.discountProduct.findMany({
        where: { discountId: d.id },
        select: { menuItemId: true },
      });
      map.set(d.id, rows.map((r) => r.menuItemId));
    }
  }
  return map;
}

/** Build the pure-rule evaluation context for an order. */
async function buildOrderContext(db, order, user) {
  const items = await db.orderItem.findMany({
    where: { orderId: order.id },
    include: { menuItem: { select: { categoryId: true } } },
  });
  return {
    orderItems: items.map((oi) => ({
      menuItemId: oi.menuItemId,
      categoryId: oi.menuItem?.categoryId ?? null,
    })),
    subtotal: Number(order.subtotal || 0),
    customerType: order.customer?.type || null,
    staffRole: user?.role || null,
    offsetMinutes: IST_OFFSET_MINUTES,
  };
}

/**
 * List discounts that are currently eligible for an order (the billing
 * "Apply Discount" panel). Only eligible rows are returned (§21) — but the
 * backend still re-validates on the actual apply call.
 *
 * @returns [{ discount, includedIds, staffRequestedValue }]
 */
async function getEligibleDiscountsForOrder(db, orderId, user) {
  const order = await db.order.findFirst({
    where: { id: Number(orderId), isDeleted: false },
    include: { customer: { select: { type: true } } },
  });
  if (!order) throw Object.assign(new Error("Order not found"), { statusCode: 404 });

  const now = new Date();
  const discounts = await db.discount.findMany({
    where: { status: { not: "DISABLED" }, archivedAt: null, type: { not: "PROMO_CODE" } },
    include: { promoCode: true },
  });

  const context = await buildOrderContext(db, order, user);
  const scopeMap = await loadScopeIds(db, discounts);

  // Existing applied discounts (stacking context)
  const existing = await db.orderDiscount.findMany({
    where: { orderId: order.id },
    include: { discount: true },
  });

  const eligible = [];
  const excluded = [];
  for (const d of discounts) {
    const includedIds = scopeMap.get(d.id) || [];
    const ctx = {
      ...context,
      now,
      includedIds,
      customerUses: 0, // listing-level check only; per-customer enforced at apply
      // §13: at listing time no staff recipient has been selected — staff-role /
      // targeting validation happens at apply, against the chosen recipient.
      deferStaffChecks: d.type === "STAFF",
    };
    const result = evaluateEligibility(d, ctx);
    if (!result.eligible) {
      excluded.push({ discount: d, reason: result.reason, detail: result.detail || null });
      continue;
    }
    // Stacking preview against what is already applied
    const stack = canStackWith(existing, d);
    if (!stack.allowed) {
      excluded.push({ discount: d, reason: `STACKING_${stack.reason}`, detail: null });
      continue;
    }
    eligible.push({ discount: d, includedIds, staffRequestedValue: null });
  }
  return { eligible, excluded };
}

/**
 * Apply a configured discount (or promo code) to an order.
 *
 * @param {object} db       tenant Prisma client
 * @param {object} params
 *   orderId, discountId?, promoCode? (raw code string),
 *   staffRequestedValue? (STAFF percentage override — validated),
 *   reason?, user (req.user)
 * @returns { order, orderDiscount } — recalculated order + the applied record
 */
async function applyDiscountToOrder(db, params) {
  const { orderId, discountId, promoCode, staffRequestedValue, staffUserId, reason, user } = params;

  const order = await db.order.findFirst({
    where: { id: Number(orderId), isDeleted: false },
    include: { customer: { select: { type: true } } },
  });
  if (!order) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
  if (order.status === "CANCELLED") {
    throw Object.assign(new Error("Cannot apply a discount to a cancelled order"), { statusCode: 400 });
  }
  if (order.bill && order.bill.status === "PAID") {
    throw Object.assign(new Error("Cannot modify a paid order"), { statusCode: 400 });
  }

  // Resolve the discount row (tenant-scoped by the client itself)
  let discount = null;
  let promoCodeId = null;
  if (discountId) {
    discount = await db.discount.findFirst({
      where: { id: Number(discountId), archivedAt: null },
      include: { promoCode: true },
    });
    if (!discount) throw Object.assign(new Error("Discount not found"), { statusCode: 404 });
    if (discount.type === "PROMO_CODE") {
      throw Object.assign(new Error("PROMO_CODE discounts must be applied via their code"), { statusCode: 400 });
    }
  } else if (promoCode) {
    const normalized = normalizePromoCode(promoCode);
    const codeRow = await db.promoCode.findFirst({
      where: { code: normalized, isActive: true },
      include: { discount: true },
    });
    if (!codeRow || !codeRow.discount || codeRow.discount.archivedAt) {
      throw Object.assign(new Error("Invalid or expired promo code"), { statusCode: 404 });
    }
    discount = codeRow.discount;
    promoCodeId = codeRow.id;
  } else {
    throw Object.assign(new Error("discountId or promoCode is required"), { statusCode: 400 });
  }

  // Stacking — re-load existing applications inside the apply path
  const existing = await db.orderDiscount.findMany({ where: { orderId: order.id } });
  // Duplicate application guard: the same discount twice on one order is never
  // intentional (§34). Removing it first is the explicit path.
  if (existing.some((od) => od.discountId === discount.id)) {
    throw Object.assign(new Error("This discount is already applied to the order"), { statusCode: 400 });
  }
  const stack = canStackWith(existing, discount);
  if (!stack.allowed) {
    const messages = {
      MAX_DISCOUNTS_PER_ORDER: "Maximum discounts per order reached for this promotion",
      NOT_STACKABLE: `${discount.name} cannot be combined with other discounts`,
      EXISTING_NOT_STACKABLE: "A non-stackable discount is already applied to this order",
    };
    throw Object.assign(new Error(messages[stack.reason] || "Stacking rule violated"), { statusCode: 400 });
  }

  // Eligibility (pure rules — schedule/scope/minimum/usage/customer/staff)
  const context = await buildOrderContext(db, order, user);
  const scopeIds = await loadScopeIds(db, [discount]);
  // Per-customer usage: only meaningful for an IDENTIFIED customer. Anonymous
  // orders share the tenant's default "Walk-in Customer" record — counting
  // them would pool every walk-in into one pseudo-customer and wrongly block
  // the promotion for all anonymous orders after the first uses by anyone.
  // Global cap for anonymous traffic is the promotion's usageLimit.
  const perCustomerUses =
    discount.perCustomerLimit != null &&
    discount.perCustomerLimit > 0 &&
    order.customerId != null &&
    order.customer?.type !== "WALK_IN"
      ? await db.orderDiscount.count({
          where: {
            discountId: discount.id,
            order: { customerId: order.customerId },
          },
        })
      : 0;

  const staffRequested =
    discount.type === "STAFF" && staffRequestedValue != null && Number(staffRequestedValue) > 0
      ? Number(staffRequestedValue)
      : null;

  // Staff recipient (§5/§6): a STAFF discount must be applied TO a real staff
  // member of this tenant. Validate: exists, active, not deleted, eligible
  // role, member of the promotion's targeted staff list. A manipulated
  // request can never attach a discount to an invalid staff member.
  let staffRecipient = null;
  if (discount.type === "STAFF") {
    // §2/§18: the recipient is ALWAYS an explicitly selected tenant employee —
    // NEVER the logged-in POS operator. The operator (cashier Rahul) and the
    // staff member receiving the benefit (Amit) are two separate identities;
    // req.user.id is a public-schema auth id and must never be silently
    // substituted. Missing recipient ⇒ 400.
    const recipientId = staffUserId == null ? 0 : Number(staffUserId);
    if (!Number.isSafeInteger(recipientId) || recipientId <= 0) {
      throw Object.assign(
        new Error("Select the staff member receiving this discount"),
        { statusCode: 400 }
      );
    }
    staffRecipient = await db.user.findFirst({
      where: { id: recipientId, deletedAt: null, isActive: true },
      select: { id: true, name: true, role: true },
    });
    if (!staffRecipient) {
      throw Object.assign(new Error("Selected staff member does not exist in this restaurant"), { statusCode: 400 });
    }
    // §6: receivable roles come from THIS tenant's business capabilities —
    // resolved from the platform Restaurant row, never the client. A retail
    // tenant's legacy KITCHEN user is not deleted; the role simply cannot
    // receive a staff discount where the kitchen capability is absent.
    let businessType = null;
    try {
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: order.restaurantId },
        select: { businessType: true },
      });
      businessType = restaurant ? restaurant.businessType : null;
    } catch {
      businessType = null;
    }
    const receivable = [
      ...new Set([
        ...STAFF_DISCOUNT_BASE_ROLES,
        ...staffDiscountRoles(businessType),
      ]),
    ];
    if (!receivable.includes(staffRecipient.role)) {
      throw Object.assign(
        new Error(`Role ${staffRecipient.role} cannot receive a staff discount in this business type`),
        { statusCode: 400 }
      );
    }
    const targetedIds = parseStaffUserIds(discount.staffUserIds);
    if (targetedIds.length > 0 && !targetedIds.includes(staffRecipient.id)) {
      throw Object.assign(new Error("Selected staff member is not eligible for this staff discount"), { statusCode: 400 });
    }
  }

  // Role cap (§14): with no explicit request, the effective percentage is
  // min(configured, roleCap) — e.g. Manager 15% vs Cashier 10% for the same
  // promotion. roleCap 0 blocks the role (checked inside evaluateEligibility).
  // Non-STAFF types always snapshot the promotion's configured value.
  // For STAFF discounts the RECIPIENT's role governs eligibility and the cap
  // (the cashier applying it on behalf of a waiter must not be blocked by
  // their own role) — falling back to the applier only when no recipient.
  const effectiveRole =
    discount.type === "STAFF" && staffRecipient ? staffRecipient.role : user?.role;
  const effectiveStaffValue =
    discount.type === "STAFF"
      ? staffRequested == null
        ? Math.min(Number(discount.discountValue), staffRoleMaxPercent(discount, effectiveRole))
        : staffRequested
      : Number(discount.discountValue);

  const evaluation = evaluateEligibility(
    { ...discount, usageCount: discount.usageCount },
    {
      ...context,
      includedIds: scopeIds.get(discount.id) || [],
      customerUses: perCustomerUses,
      requestedValue: staffRequested || undefined,
      staffUserId: staffRecipient?.id,
      staffRole: effectiveRole,
    }
  );
  if (!evaluation.eligible) {
    const messages = {
      DISABLED: "This discount is disabled",
      ARCHIVED: "This discount is no longer available",
      STAFF_MEMBER_NOT_ELIGIBLE: "Selected staff member is not eligible for this staff discount",
      OUT_OF_DATE_RANGE: "This discount is not within its valid date range",
      DAY_NOT_VALID: "This discount is not valid today",
      OUT_OF_TIME_WINDOW: "This discount is outside its daily time window",
      SCOPE_NOT_COVERED: "This discount does not apply to all items in this order",
      MINIMUM_ORDER: `Order subtotal must be at least ${discount.minimumOrderAmount} for this discount`,
      USAGE_LIMIT_REACHED: "This discount has reached its usage limit",
      PER_CUSTOMER_LIMIT_REACHED: "You have already used this discount the maximum number of times",
      REGISTERED_CUSTOMERS_ONLY: "This discount is only available for registered customers",
      STAFF_DISCOUNT_REQUIRES_STAFF_USER: "Select the staff member receiving this staff discount",
      STAFF_ROLE_NOT_ELIGIBLE: "The selected staff member's role is not eligible for this staff discount",
      STAFF_ROLE_LIMIT: `The selected staff member's role allows a maximum ${evaluation.detail?.roleCap ?? 0}% staff discount`,
    };
    throw Object.assign(new Error(messages[evaluation.reason] || "Discount not eligible"), { statusCode: 400 });
  }

  const amount = calculateDiscountAmount(discount, order.subtotal, effectiveStaffValue);

  // Persist + usage increment + total recalculation in ONE transaction.
  // The guarded update (usageCount < usageLimit) is the race-condition guard:
  // when two orders claim the final use, exactly one transaction wins.
  const result = await db.$transaction(async (tx) => {
    if (discount.usageLimit != null && discount.usageLimit > 0) {
      const claim = await tx.discount.updateMany({
        where: {
          id: discount.id,
          OR: [
            { usageLimit: null },
            { usageCount: { lt: discount.usageLimit } },
          ],
        },
        data: { usageCount: { increment: 1 } },
      });
      if (claim.count === 0) {
        throw Object.assign(new Error("This discount has reached its usage limit"), { statusCode: 400 });
      }
    }

    const orderDiscount = await tx.orderDiscount.create({
      data: {
        orderId: order.id,
        discountId: discount.id,
        promoCodeId: promoCodeId || null,
        discountType: discount.type,
        discountName: discount.name,
        discountValue: effectiveStaffValue,
        discountAmount: amount,
        discountLabel: discountLabel(discount, effectiveStaffValue),
        reason: reason || null,
        appliedBy: user?.id || null,
        approvedBy: null,
        staffUserId: staffRecipient?.id || null,
        staffName: staffRecipient?.name || null,
        isManual: false,
      },
    });

    // Recompute the order total from the sum of all applied discounts
    const allApplied = await tx.orderDiscount.findMany({ where: { orderId: order.id } });
    const totalDiscount = allApplied.reduce((s, od) => s + Number(od.discountAmount || 0), 0);
    const totalAmount = computeTotalAmount(order, totalDiscount);
    await tx.order.update({
      where: { id: order.id },
      data: {
        discount: round2(totalDiscount),
        totalAmount,
      },
    });

    // Keep an existing bill in sync (never silently drop a discount)
    const bill = await tx.bill.findFirst({ where: { orderId: order.id, isCancelled: false } });
    if (bill) {
      await tx.bill.update({
        where: { id: bill.id },
        data: { discount: round2(totalDiscount), grandTotal: totalAmount },
      });
    }

    return { orderDiscount, totalDiscount, totalAmount };
  });

  const updatedOrder = await db.order.findFirst({ where: { id: order.id } });
  return { order: updatedOrder, orderDiscount: result.orderDiscount };
}

/**
 * Remove an applied discount from an order (billing "X" on the chip) and
 * restore the promo usage counter. Order totals are recalculated — but only
 * for the order being edited, never for historical orders.
 */
async function removeOrderDiscount(db, orderDiscountId, user) {
  const record = await db.orderDiscount.findFirst({
    where: { id: Number(orderDiscountId) },
    include: { order: true },
  });
  if (!record) throw Object.assign(new Error("Applied discount not found"), { statusCode: 404 });
  const order = record.order;
  if (order.status === "CANCELLED" || (order.bill && order.bill.status === "PAID")) {
    throw Object.assign(new Error("Cannot modify a cancelled or paid order"), { statusCode: 400 });
  }

  await db.$transaction(async (tx) => {
    await tx.orderDiscount.delete({ where: { id: record.id } });
    // Restore usage counter (best-effort — only for limited promotions)
    if (record.discountId) {
      await tx.discount.updateMany({
        where: { id: record.discountId, usageCount: { gt: 0 } },
        data: { usageCount: { decrement: 1 } },
      });
    }
    const remaining = await tx.orderDiscount.findMany({ where: { orderId: order.id } });
    const totalDiscount = remaining.reduce((s, od) => s + Number(od.discountAmount || 0), 0);
    const totalAmount = computeTotalAmount(order, totalDiscount);
    await tx.order.update({
      where: { id: order.id },
      data: { discount: round2(totalDiscount), totalAmount },
    });
    const bill = await tx.bill.findFirst({ where: { orderId: order.id, isCancelled: false } });
    if (bill) {
      await tx.bill.update({
        where: { id: bill.id },
        data: { discount: round2(totalDiscount), grandTotal: totalAmount },
      });
    }
  });

  return db.order.findFirst({ where: { id: order.id } });
}

/**
 * List active promotions for the admin Discounts & Promotions screen,
 * enriched with the derived effective status (§28).
 */
async function listDiscountsWithStatus(db, now = new Date()) {
  const discounts = await db.discount.findMany({
    where: { archivedAt: null },
    include: { promoCode: true },
    orderBy: { createdAt: "desc" },
  });
  // Resolve targeted staff members (STAFF type) so the management UI can
  // display real names — ids only would be meaningless after staff changes.
  const staffIds = new Set();
  for (const d of discounts) {
    for (const id of parseStaffUserIds(d.staffUserIds)) staffIds.add(id);
  }
  let staffById = new Map();
  if (staffIds.size > 0) {
    const users = await db.user.findMany({
      where: { id: { in: [...staffIds] } },
      select: { id: true, name: true, role: true, isActive: true },
    });
    staffById = new Map(users.map((u) => [u.id, u]));
  }
  return discounts.map((d) => {
    const promoCode = d.promoCode || null;
    const { promoCode: _pc, ...rest } = d;
    const targetedStaff = parseStaffUserIds(d.staffUserIds).map(
      (id) => staffById.get(id) || { id, name: `Staff #${id}`, role: null, isActive: false }
    );
    return {
      ...rest,
      promoCode,
      targetedStaff,
      effectiveStatus: effectiveStatus(d, now),
    };
  });
}

module.exports = {
  IST_OFFSET_MINUTES,
  computeTotalAmount,
  loadScopeIds,
  buildOrderContext,
  getEligibleDiscountsForOrder,
  applyDiscountToOrder,
  removeOrderDiscount,
  listDiscountsWithStatus,
};
