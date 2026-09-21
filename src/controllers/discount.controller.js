const { successResponse, errorResponse } = require("../utils/response");
const {
  validateDiscountInput,
  normalizePromoCode,
  effectiveStatus,
  evaluateEligibility,
  calculateDiscountAmount,
  discountLabel,
  maskToDayList,
} = require("../utils/discountRules");
const engine = require("../services/discountEngine.service");
const { createAuditLog } = require("../services/audit.service");
const {
  getBusinessCapabilities,
  staffDiscountRoles,
} = require("../utils/businessCapabilities");
const prisma = require("../config/prisma");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const dayListToMaskSafe = (days) => {
  const { dayListToMask } = require("../utils/discountRules");
  return dayListToMask(days);
};

// Roles that may receive a STAFF discount, derived from THIS tenant's
// business capabilities (never a scattered businessType check): Manager and
// Cashier are core in every vertical; KITCHEN is receivable only where the
// kitchen capability exists; WAITER only where a service workflow exists.
// ADMIN remains receivable as before (platform owners frequently ring sales).
const STAFF_DISCOUNT_BASE_ROLES = ["ADMIN", "MANAGER", "CASHIER"];

/**
 * Resolve the tenant's staff-discount role set from the platform Restaurant
 * row (server-side — never client-supplied businessType).
 */
async function resolveStaffDiscountRoles(restaurantId) {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { businessType: true },
    });
    return staffDiscountRoles(restaurant ? restaurant.businessType : null);
  } catch {
    return [...STAFF_DISCOUNT_BASE_ROLES];
  }
}

/**
 * Validate a STAFF-discount payload's specific staff targeting (§5/§7):
 *  - every selected id is a real User of THIS tenant (req.tenantDb)
 *  - the user is active and not soft-deleted
 *  - the user's role is an eligible staff-discount role
 *  - the user's role is within the promotion's configured staffRoles
 * Returns an error message string, or null when valid.
 */
async function validateStaffUsers(db, body, allowedRoles) {
  const ids = Array.isArray(body.staffUserIds) ? body.staffUserIds.map(Number).filter(Number.isSafeInteger) : [];
  if (ids.length === 0) return null; // role-based eligibility only
  const roles = Array.isArray(body.staffRoles)
    ? body.staffRoles.map((r) => String(r).toUpperCase())
    : [];
  const users = await db.user.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, role: true, isActive: true },
  });
  if (users.length !== ids.length) {
    return "One or more selected staff members do not exist";
  }
  for (const u of users) {
    if (!u.isActive) return "One or more selected staff members are inactive";
    if (!allowedRoles.includes(u.role)) {
      return `Role ${u.role} cannot receive a staff discount in this business type`;
    }
    if (roles.length > 0 && !roles.includes(u.role)) {
      return `Selected staff member's role (${u.role}) is not eligible for this discount`;
    }
  }
  return null;
}

async function audit(req, module, action, description, referenceId, referenceNo) {
  try {
    await createAuditLog(
      {
        restaurantId: req.user?.restaurantId || null,
        userId: req.user?.id || null,
        module,
        action,
        description,
        referenceId: referenceId ?? null,
        referenceNo: referenceNo ?? null,
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
      },
      req.tenantDb || null
    );
  } catch (err) {
    console.error("[Discount] Audit log error:", err.message);
  }
}

/** Data-shape normalizer shared by create/update. */
function buildDiscountData(body, user) {
  const data = {
    name: String(body.name).trim(),
    description: body.description ? String(body.description).trim() : null,
    type: body.type,
    discountValue: Number(body.discountValue),
    maximumDiscountAmount:
      body.maximumDiscountAmount != null && body.maximumDiscountAmount !== ""
        ? Number(body.maximumDiscountAmount)
        : null,
    minimumOrderAmount: body.minimumOrderAmount != null ? Number(body.minimumOrderAmount) : 0,
    startDate: new Date(body.startDate),
    endDate: new Date(body.endDate),
    startTime: body.startTime ? String(body.startTime) : null,
    endTime: body.endTime ? String(body.endTime) : null,
    status: body.status || "ACTIVE",
    scope: body.scope || "ENTIRE_ORDER",
    applicableDays:
      body.applicableDays != null
        ? Number(body.applicableDays)
        : Array.isArray(body.days)
          ? dayListToMaskSafe(body.days)
          : 127,
    customerEligibility: body.customerEligibility || "EVERYONE",
    stackable: body.stackable === true,
    maxDiscountsPerOrder: body.maxDiscountsPerOrder != null ? Number(body.maxDiscountsPerOrder) : 1,
    usageLimit: body.usageLimit != null && body.usageLimit !== "" ? Number(body.usageLimit) : null,
    perCustomerLimit:
      body.perCustomerLimit != null && body.perCustomerLimit !== "" ? Number(body.perCustomerLimit) : null,
    createdBy: user?.id || null,
  };

  if (data.type === "STAFF") {
    data.staffRoles = JSON.stringify((body.staffRoles || []).map((r) => String(r).toUpperCase()));
    // Specific-staff targeting (§5): store the real tenant User ids the admin
    // selected. Null/empty = role-based eligibility for every matching user.
    if (Array.isArray(body.staffUserIds) && body.staffUserIds.length > 0) {
      data.staffUserIds = body.staffUserIds.map((n) => Number(n)).filter(Number.isSafeInteger);
    }
    if (body.staffRoleMaxPercent && typeof body.staffRoleMaxPercent === "object") {
      const map = {};
      for (const [role, pct] of Object.entries(body.staffRoleMaxPercent)) {
        if (pct === "" || pct == null) continue;
        map[String(role).toUpperCase()] = Number(pct);
      }
      data.staffRoleMaxPercent = Object.keys(map).length > 0 ? map : null;
    }
  } else {
    data.staffRoles = null;
    data.staffUserIds = null;
    data.staffRequireApproval = false;
    data.staffRoleMaxPercent = null;
  }
  // PROMO_CODE: persist the configured grant method (percentage vs fixed)
  if (data.type === "PROMO_CODE") {
    data.promoMethod = body.promoMethod === "PERCENTAGE" ? "PERCENTAGE" : "FIXED_AMOUNT";
  }
  return data;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

const getDiscounts = async (req, res) => {
  const db = req.tenantDb;
  try {
    const { status, type, search } = req.query;
    const rows = await engine.listDiscountsWithStatus(db);

    let filtered = rows;
    if (status && status !== "ALL") filtered = filtered.filter((d) => d.effectiveStatus === status);
    if (type && type !== "ALL") filtered = filtered.filter((d) => d.type === type);
    if (search) {
      const q = String(search).toLowerCase();
      filtered = filtered.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          (d.promoCode && d.promoCode.code.toLowerCase().includes(q)) ||
          (d.description || "").toLowerCase().includes(q)
      );
    }

    return successResponse(res, filtered, "Discounts fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getDiscountById = async (req, res) => {
  const db = req.tenantDb;
  try {
    const discount = await db.discount.findFirst({
      where: { id: Number(req.params.id), archivedAt: null },
      include: {
        categories: { select: { categoryId: true } },
        products: { select: { menuItemId: true } },
        promoCode: true,
      },
    });
    if (!discount) return errorResponse(res, "Discount not found", 404);

    const {
      categories, products, promoCode, ...rest
    } = discount;
    return successResponse(
      res,
      {
        ...rest,
        categoryIds: (categories || []).map((c) => c.categoryId),
        menuItemIds: (products || []).map((p) => p.menuItemId),
        promoCode: promoCode || null,
        effectiveStatus: effectiveStatus(discount),
      },
      "Discount fetched successfully"
    );
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const createDiscount = async (req, res) => {
  const db = req.tenantDb;
  try {
    // Authoritative backend validation (§6/§33)
    const { valid, errors } = validateDiscountInput(req.body);
    if (!valid) {
      return res.status(400).json({ success: false, message: Object.values(errors)[0], errors });
    }

    const data = buildDiscountData(req.body, req.user);

    // Duplicate active promo code within the tenant (§15)
    let codeNorm = null;
    if (data.type === "PROMO_CODE") {
      codeNorm = normalizePromoCode(req.body.code);
      const dupe = await db.promoCode.findFirst({ where: { code: codeNorm } });
      if (dupe) {
        return res.status(400).json({
          success: false,
          message: `Promo code "${codeNorm}" already exists`,
          errors: { code: "This promo code is already in use" },
        });
      }
    }

    // Scope selections must belong to THIS tenant (§26) — the tenant client is
    // already schema-isolated, but the rows must also exist in this schema.
    const categoryIds = req.body.scope === "CATEGORIES" ? req.body.categoryIds.map(Number) : [];
    const menuItemIds = req.body.scope === "PRODUCTS" ? req.body.menuItemIds.map(Number) : [];
    if (req.body.scope === "CATEGORIES") {
      const found = await db.category.count({ where: { id: { in: categoryIds } } });
      if (found !== categoryIds.length) {
        return errorResponse(res, "One or more selected categories do not exist", 400);
      }
    }
    if (req.body.scope === "PRODUCTS") {
      const found = await db.menuItem.count({ where: { id: { in: menuItemIds } } });
      if (found !== menuItemIds.length) {
        return errorResponse(res, "One or more selected products do not exist", 400);
      }
    }

    // STAFF targeting (§5): every selected staff member must be a real,
    // active, non-deleted User of THIS tenant with a role receivable in THIS
    // business type (capability-derived) and inside the promotion's roles.
    if (data.type === "STAFF") {
      const allowedRoles = [
        ...new Set([
          ...STAFF_DISCOUNT_BASE_ROLES,
          ...(await resolveStaffDiscountRoles(req.user?.restaurantId)),
        ]),
      ];
      const invalidRole = (req.body.staffRoles || []).find(
        (r) => !allowedRoles.includes(String(r).toUpperCase())
      );
      if (invalidRole) {
        return errorResponse(
          res,
          `Role ${String(invalidRole).toUpperCase()} is not available for this business type`,
          400
        );
      }
      const staffErr = await validateStaffUsers(db, req.body, allowedRoles);
      if (staffErr) return errorResponse(res, staffErr, 400);
    }

    const created = await db.$transaction(async (tx) => {
      const discount = await tx.discount.create({ data });
      if (categoryIds.length > 0) {
        await tx.discountCategory.createMany({
          data: categoryIds.map((categoryId) => ({ discountId: discount.id, categoryId })),
        });
      }
      if (menuItemIds.length > 0) {
        await tx.discountProduct.createMany({
          data: menuItemIds.map((menuItemId) => ({ discountId: discount.id, menuItemId })),
        });
      }
      if (codeNorm) {
        await tx.promoCode.create({
          data: { discountId: discount.id, code: codeNorm, isActive: true },
        });
      }
      return tx.discount.findFirst({ where: { id: discount.id }, include: { promoCode: true } });
    });

    await audit(
      req, "DISCOUNT", "CREATE",
      `Created ${data.type} discount "${created.name}" (${discountLabel(created)})`,
      created.id, created.promoCode?.code || null
    );

    return successResponse(res, created, "Discount created successfully", 201);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const updateDiscount = async (req, res) => {
  const db = req.tenantDb;
  try {
    const existing = await db.discount.findFirst({
      where: { id: Number(req.params.id), archivedAt: null },
      include: { promoCode: true },
    });
    if (!existing) return errorResponse(res, "Discount not found", 404);

    const payload = { ...req.body };
    // Duplicate promo code check excludes this discount's own code
    if (payload.type === "PROMO_CODE" || existing.type === "PROMO_CODE") {
      const targetCode = payload.code || existing.promoCode?.code;
      if (targetCode) {
        const norm = normalizePromoCode(targetCode);
        const dupe = await db.promoCode.findFirst({ where: { code: norm, discountId: { not: existing.id } } });
        if (dupe) {
          return res.status(400).json({
            success: false,
            message: `Promo code "${norm}" already exists`,
            errors: { code: "This promo code is already in use" },
          });
        }
      }
    }

    const { valid, errors } = validateDiscountInput({
      name: payload.name ?? existing.name,
      description: payload.description ?? existing.description,
      type: payload.type ?? existing.type,
      discountValue: payload.discountValue ?? existing.discountValue,
      maximumDiscountAmount: payload.maximumDiscountAmount ?? existing.maximumDiscountAmount,
      minimumOrderAmount: payload.minimumOrderAmount ?? existing.minimumOrderAmount,
      startDate: payload.startDate ?? existing.startDate,
      endDate: payload.endDate ?? existing.endDate,
      startTime: payload.startTime ?? existing.startTime,
      endTime: payload.endTime ?? existing.endTime,
      status: payload.status ?? existing.status,
      scope: payload.scope ?? existing.scope,
      categoryIds: payload.categoryIds ?? [],
      menuItemIds: payload.menuItemIds ?? [],
      applicableDays: payload.applicableDays ?? existing.applicableDays,
      customerEligibility: payload.customerEligibility ?? existing.customerEligibility,
      stackable: payload.stackable ?? existing.stackable,
      maxDiscountsPerOrder: payload.maxDiscountsPerOrder ?? existing.maxDiscountsPerOrder,
      usageLimit: payload.usageLimit ?? existing.usageLimit,
      perCustomerLimit: payload.perCustomerLimit ?? existing.perCustomerLimit,
      staffRoles: payload.staffRoles ?? (existing.staffRoles ? JSON.parse(existing.staffRoles) : []),
      staffRoleMaxPercent: payload.staffRoleMaxPercent ?? existing.staffRoleMaxPercent,
      code: payload.code ?? existing.promoCode?.code,
      promoMethod: payload.promoMethod ?? existing.promoMethod,
    });
    if (!valid) {
      return res.status(400).json({ success: false, message: Object.values(errors)[0], errors });
    }

    const data = buildDiscountData(
      {
        name: payload.name ?? existing.name,
        description: payload.description ?? existing.description,
        type: payload.type ?? existing.type,
        discountValue: payload.discountValue ?? existing.discountValue,
        maximumDiscountAmount: payload.maximumDiscountAmount ?? existing.maximumDiscountAmount,
        minimumOrderAmount: payload.minimumOrderAmount ?? existing.minimumOrderAmount,
        startDate: payload.startDate ?? existing.startDate,
        endDate: payload.endDate ?? existing.endDate,
        startTime: payload.startTime ?? existing.startTime,
        endTime: payload.endTime ?? existing.endTime,
        status: payload.status ?? existing.status,
        scope: payload.scope ?? existing.scope,
        applicableDays: payload.applicableDays ?? existing.applicableDays,
        customerEligibility: payload.customerEligibility ?? existing.customerEligibility,
        stackable: payload.stackable ?? existing.stackable,
        maxDiscountsPerOrder: payload.maxDiscountsPerOrder ?? existing.maxDiscountsPerOrder,
        usageLimit: payload.usageLimit ?? existing.usageLimit,
        perCustomerLimit: payload.perCustomerLimit ?? existing.perCustomerLimit,
        staffRoles: payload.staffRoles ?? (existing.staffRoles ? JSON.parse(existing.staffRoles) : []),
        staffUserIds: payload.staffUserIds ?? (existing.staffUserIds || []),
        staffRoleMaxPercent: payload.staffRoleMaxPercent ?? existing.staffRoleMaxPercent,
        promoMethod: payload.promoMethod ?? existing.promoMethod,
      },
      req.user
    );

    const categoryIds =
      (payload.scope === "CATEGORIES" || (payload.scope == null && existing.scope === "CATEGORIES")) &&
      Array.isArray(payload.categoryIds)
        ? payload.categoryIds.map(Number)
        : null;
    const menuItemIds =
      (payload.scope === "PRODUCTS" || (payload.scope == null && existing.scope === "PRODUCTS")) &&
      Array.isArray(payload.menuItemIds)
        ? payload.menuItemIds.map(Number)
        : null;

    if (categoryIds) {
      const found = await db.category.count({ where: { id: { in: categoryIds } } });
      if (found !== categoryIds.length) {
        return errorResponse(res, "One or more selected categories do not exist", 400);
      }
    }
    if (menuItemIds) {
      const found = await db.menuItem.count({ where: { id: { in: menuItemIds } } });
      if (found !== menuItemIds.length) {
        return errorResponse(res, "One or more selected products do not exist", 400);
      }
    }

    // STAFF targeting on update (§5): validate the final merged id list.
    // Newly submitted roles must all be receivable in this business type.
    if ((data.type ?? existing.type) === "STAFF") {
      const allowedRoles = [
        ...new Set([
          ...STAFF_DISCOUNT_BASE_ROLES,
          ...(await resolveStaffDiscountRoles(req.user?.restaurantId)),
        ]),
      ];
      const submittedRoles = Array.isArray(payload.staffRoles)
        ? payload.staffRoles.map((r) => String(r).toUpperCase())
        : [];
      const invalidRole = submittedRoles.find((r) => !allowedRoles.includes(r));
      if (invalidRole) {
        return errorResponse(
          res,
          `Role ${invalidRole} is not available for this business type`,
          400
        );
      }
      const mergedStaffBody = {
        staffRoles: payload.staffRoles ?? (existing.staffRoles ? JSON.parse(existing.staffRoles) : []),
        staffUserIds: payload.staffUserIds ?? (existing.staffUserIds || []),
      };
      const staffErr = await validateStaffUsers(db, mergedStaffBody, allowedRoles);
      if (staffErr) return errorResponse(res, staffErr, 400);
    }

    const updated = await db.$transaction(async (tx) => {
      const discount = await tx.discount.update({ where: { id: existing.id }, data });
      if (categoryIds) {
        await tx.discountCategory.deleteMany({ where: { discountId: existing.id } });
        if (categoryIds.length > 0) {
          await tx.discountCategory.createMany({
            data: categoryIds.map((categoryId) => ({ discountId: existing.id, categoryId })),
          });
        }
      }
      if (menuItemIds) {
        await tx.discountProduct.deleteMany({ where: { discountId: existing.id } });
        if (menuItemIds.length > 0) {
          await tx.discountProduct.createMany({
            data: menuItemIds.map((menuItemId) => ({ discountId: existing.id, menuItemId })),
          });
        }
      }
      const normCode = normalizePromoCode(payload.code ?? existing.promoCode?.code ?? "");
      if (discount.type === "PROMO_CODE" && normCode) {
        if (existing.promoCode) {
          await tx.promoCode.update({
            where: { id: existing.promoCode.id },
            data: { code: normCode },
          });
        } else {
          await tx.promoCode.create({ data: { discountId: existing.id, code: normCode, isActive: true } });
        }
      }
      return tx.discount.findFirst({ where: { id: existing.id }, include: { promoCode: true } });
    });

    await audit(
      req, "DISCOUNT", "UPDATE",
      `Updated discount "${updated.name}" (id ${updated.id})`,
      updated.id, updated.promoCode?.code || null
    );

    return successResponse(res, updated, "Discount updated successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const setDiscountStatus = async (req, res) => {
  const db = req.tenantDb;
  try {
    const { status } = req.body;
    const discount = await db.discount.findFirst({
      where: { id: Number(req.params.id), archivedAt: null },
    });
    if (!discount) return errorResponse(res, "Discount not found", 404);
    const updated = await db.discount.update({ where: { id: discount.id }, data: { status } });

    await audit(
      req, "DISCOUNT", status === "ACTIVE" ? "UPDATE" : "UPDATE",
      `${status === "ACTIVE" ? "Activated" : status === "DISABLED" ? "Disabled" : "Scheduled"} discount "${discount.name}" (id ${discount.id})`,
      discount.id, null
    );
    return successResponse(res, updated, `Discount ${status.toLowerCase()} now`);
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/**
 * Archive (safe delete). Discounts that have been applied to orders are
 * archived, never hard-deleted — OrderDiscount history stays intact (§23).
 */
const archiveDiscount = async (req, res) => {
  const db = req.tenantDb;
  try {
    const discount = await db.discount.findFirst({
      where: { id: Number(req.params.id), archivedAt: null },
      include: { _count: { select: { orderDiscounts: true } } },
    });
    if (!discount) return errorResponse(res, "Discount not found", 404);

    const hasBeenApplied = (discount._count?.orderDiscounts || 0) > 0;
    const updated = await db.discount.update({
      where: { id: discount.id },
      data: { archivedAt: new Date(), status: "DISABLED" },
    });

    await audit(
      req, "DISCOUNT", "DELETE",
      `${hasBeenApplied ? "Archived" : "Archived"} discount "${discount.name}" (id ${discount.id})`,
      discount.id, discount.promoCode ? undefined : null
    );
    return successResponse(res, updated, "Discount archived successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Billing integration ─────────────────────────────────────────────────────

const getEligibleDiscounts = async (req, res) => {
  const db = req.tenantDb;
  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return errorResponse(res, "Invalid order ID", 400);
    }
    const { eligible, excluded } = await engine.getEligibleDiscountsForOrder(db, orderId, req.user);
    const shaped = eligible.map(({ discount, includedIds, staffRequestedValue }) => ({
      id: discount.id,
      name: discount.name,
      description: discount.description,
      type: discount.type,
      discountValue: discount.discountValue,
      maximumDiscountAmount: discount.maximumDiscountAmount,
      minimumOrderAmount: discount.minimumOrderAmount,
      stackable: discount.stackable,
      scope: discount.scope,
      includedIds,
      staffRequestedValue,
      // Recipient-role list for the billing staff picker — the frontend
      // filters the directory to roles this promotion actually serves.
      staffRoles: discount.staffRoles || null,
      promoCode: discount.promoCode ? { id: discount.promoCode.id, code: discount.promoCode.code } : null,
      label: discountLabel(discount),
    }));
    // §13: never show a false "No eligible discounts" — excluded promotions are
    // returned WITH their machine reason so the UI can display exactly why
    // (below minimum order, outside schedule, stacking conflict, …).
    const EXCLUDED_REASONS = {
      DISABLED: "Disabled",
      ARCHIVED: "No longer available",
      OUT_OF_DATE_RANGE: "Outside its valid dates",
      DAY_NOT_VALID: "Not valid today",
      OUT_OF_TIME_WINDOW: "Outside its daily time window",
      SCOPE_NOT_COVERED: "Does not apply to all items in this order",
      MINIMUM_ORDER: "Order is below the minimum amount",
      USAGE_LIMIT_REACHED: "Usage limit reached",
      PER_CUSTOMER_LIMIT_REACHED: "Per-customer limit reached",
      REGISTERED_CUSTOMERS_ONLY: "Registered customers only",
      STAFF_ROLE_NOT_ELIGIBLE: "Staff role not eligible",
      STAFF_ROLE_LIMIT: "Staff role cap exceeded",
      STAFF_MEMBER_NOT_ELIGIBLE: "Selected staff member not eligible",
      STACKING_MAX_DISCOUNTS_PER_ORDER: "Maximum discounts per order reached",
      STACKING_NOT_STACKABLE: "Cannot be combined with other discounts",
      STACKING_EXISTING_NOT_STACKABLE: "A non-stackable discount is already applied",
    };
    const shapedExcluded = excluded.map(({ discount, reason, detail }) => ({
      id: discount.id,
      name: discount.name,
      type: discount.type,
      scope: discount.scope,
      minimumOrderAmount: discount.minimumOrderAmount,
      label: discountLabel(discount),
      reason,
      reasonLabel: EXCLUDED_REASONS[reason] || "Not eligible for this order",
      detail: detail || null,
    }));
    return successResponse(res, { eligible: shaped, excluded: shapedExcluded }, "Eligible discounts fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const applyDiscount = async (req, res) => {
  const db = req.tenantDb;
  try {
    const result = await engine.applyDiscountToOrder(db, {
      orderId: Number(req.params.orderId),
      discountId: req.body.discountId,
      promoCode: req.body.promoCode,
      staffRequestedValue: req.body.staffRequestedValue,
      staffUserId: req.body.staffUserId,
      reason: req.body.reason,
      user: req.user,
    });

    await audit(
      req, "DISCOUNT", "APPLY_DISCOUNT",
      `Applied discount "${result.orderDiscount.discountName}" (${result.orderDiscount.discountLabel || result.orderDiscount.discountType}) to order — amount ${result.orderDiscount.discountAmount}`,
      result.orderDiscount.id, result.orderDiscount.discountName
    );

    return successResponse(res, result, "Discount applied successfully", 200);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

const removeDiscount = async (req, res) => {
  const db = req.tenantDb;
  try {
    const order = await engine.removeOrderDiscount(db, req.params.orderDiscountId, req.user);
    await audit(
      req, "DISCOUNT", "UPDATE",
      `Removed an applied discount from order #${order?.orderNo || req.params.orderDiscountId}`,
      Number(req.params.orderDiscountId), null
    );
    return successResponse(res, order, "Discount removed successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/**
 * Manual discount (§22) — audited ad-hoc discount. Percentage/fixed only;
 * the authenticated user is recorded as appliedBy. Manager approval for
 * above-ceiling values is captured via the approvedBy field.
 */
const applyManualDiscount = async (req, res) => {
  const db = req.tenantDb;
  try {
    const orderId = Number(req.params.orderId);
    const { type, value, reason, approvedBy } = req.body;

    if (!["PERCENTAGE", "FIXED_AMOUNT"].includes(type)) {
      return errorResponse(res, "Manual discount type must be PERCENTAGE or FIXED_AMOUNT", 400);
    }
    if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) {
      return errorResponse(res, "Manual discount value must be greater than 0", 400);
    }
    if (type === "PERCENTAGE" && Number(value) > 100) {
      return errorResponse(res, "Percentage discount cannot exceed 100", 400);
    }

    const order = await db.order.findFirst({
      where: { id: orderId, isDeleted: false },
    });
    if (!order) return errorResponse(res, "Order not found", 404);
    if (order.status === "CANCELLED") {
      return errorResponse(res, "Cannot apply a discount to a cancelled order", 400);
    }

    // Stacking guard — manual discounts never stack with anything (safest default)
    const existing = await db.orderDiscount.findMany({ where: { orderId } });
    if (existing.length > 0) {
      return errorResponse(res, "Remove the existing discount before applying a manual discount", 400);
    }

    const amount = calculateDiscountAmount(
      { type: type === "PERCENTAGE" ? "PERCENTAGE" : "FIXED_AMOUNT", discountValue: Number(value) },
      order.subtotal
    );

    const orderDiscount = await db.$transaction(async (tx) => {
      const created = await tx.orderDiscount.create({
        data: {
          orderId,
          discountId: null,
          promoCodeId: null,
          discountType: type,
          discountName: "Manual Discount",
          discountValue: Number(value),
          discountAmount: amount,
          discountLabel: type === "PERCENTAGE" ? `${Number(value)}% OFF` : `₹${Number(value)} OFF`,
          reason: reason || null,
          appliedBy: req.user?.id || null,
          approvedBy: approvedBy ? Number(approvedBy) : null,
          isManual: true,
        },
      });
      const totalAmount = engine.computeTotalAmount(order, amount);
      await tx.order.update({
        where: { id: orderId },
        data: { discount: amount, totalAmount },
      });
      const bill = await tx.bill.findFirst({ where: { orderId, isCancelled: false } });
      if (bill) {
        await tx.bill.update({
          where: { id: bill.id },
          data: { discount: amount, grandTotal: totalAmount },
        });
      }
      return created;
    });

    await audit(
      req, "DISCOUNT", "APPLY_DISCOUNT",
      `Applied MANUAL ${type === "PERCENTAGE" ? value + "%" : "₹" + value} discount to order #${order.orderNo} — amount ${amount}${reason ? ` (reason: ${reason})` : ""}`,
      orderDiscount.id, order.orderNo
    );

    return successResponse(res, { orderDiscount }, "Manual discount applied successfully", 200);
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/**
 * Admin preview endpoint (§29) — informational only; the engine re-validates
 * everything on the real apply call.
 */
const previewDiscount = async (req, res) => {
  const db = req.tenantDb;
  try {
    const payload = req.body;
    const categoryIds = payload.scope === "CATEGORIES" ? (payload.categoryIds || []).map(Number) : [];
    const menuItemIds = payload.scope === "PRODUCTS" ? (payload.menuItemIds || []).map(Number) : [];

    let categories = [];
    let products = [];
    if (categoryIds.length > 0) {
      categories = await db.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true },
      });
    }
    if (menuItemIds.length > 0) {
      products = await db.menuItem.findMany({
        where: { id: { in: menuItemIds } },
        select: { id: true, name: true },
      });
    }

    return successResponse(
      res,
      {
        appliesTo:
          payload.scope === "CATEGORIES"
            ? categories.map((c) => c.name)
            : payload.scope === "PRODUCTS"
              ? products.map((p) => p.name)
              : ["Entire Order"],
        names: categories.map((c) => c.name),
        productNames: products.map((p) => p.name),
      },
      "Preview generated"
    );
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ═══ Reference endpoints (§14) ════════════════════════════════════════════
// Small tenant-scoped lookups for the Create/Edit Discount form. They exist
// because the canonical list endpoints return response shapes/fields geared to
// their own screens; these return exactly what targeting needs. All three use
// req.tenantDb, require authentication + the discounts permission, and never
// accept a restaurantId tenant selector.

const getReferenceCategories = async (req, res) => {
  const db = req.tenantDb;
  try {
    const categories = await db.category.findMany({
      where: { isActive: true },
      select: { id: true, name: true, color: true },
      orderBy: { name: "asc" },
    });
    return successResponse(res, { categories }, "Categories fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getReferenceProducts = async (req, res) => {
  const db = req.tenantDb;
  try {
    const { search } = req.query;
    const where = {};
    if (search) {
      where.OR = [{ name: { contains: String(search) } }, { sku: { contains: String(search) } }];
    }
    const items = await db.menuItem.findMany({
      where,
      select: { id: true, name: true, categoryId: true, category: { select: { id: true, name: true } }, isAvailable: true },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    });
    return successResponse(res, { products: items }, "Products fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

const getReferenceStaff = async (req, res) => {
  const db = req.tenantDb;
  try {
    // Roles that may receive a staff discount in THIS business type —
    // capability-derived (same catalog the apply path enforces). Legacy
    // KITCHEN users in a retail tenant are simply not listed, never deleted.
    const allowedRoles = [
      ...new Set([
        ...STAFF_DISCOUNT_BASE_ROLES,
        ...(await resolveStaffDiscountRoles(req.user?.restaurantId)),
      ]),
    ];
    const users = await db.user.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        role: { in: allowedRoles },
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    });
    return successResponse(res, { staff: users }, "Staff fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

/**
 * Usage stats (§2 summary cards) — real tenant data for the Discounts screen:
 * today's discount amount and total discounted orders, aggregated from the
 * persisted OrderDiscount history (never recalculated from live definitions).
 */
const getUsageStats = async (req, res) => {
  const db = req.tenantDb;
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [todayAgg, totalAgg] = await Promise.all([
      db.orderDiscount.aggregate({
        _sum: { discountAmount: true },
        _count: { _all: true },
        where: { createdAt: { gte: startOfToday } },
      }),
      db.orderDiscount.aggregate({
        _count: { orderId: true },
      }),
    ]);

    return successResponse(res, {
      todayDiscountAmount: Number(todayAgg._sum.discountAmount || 0),
      todayDiscountedOrders: todayAgg._count._all,
      totalDiscountedOrders: totalAgg._count.orderId,
    }, "Discount usage stats fetched successfully");
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getDiscounts,
  getDiscountById,
  createDiscount,
  updateDiscount,
  setDiscountStatus,
  archiveDiscount,
  getEligibleDiscounts,
  applyDiscount,
  removeDiscount,
  applyManualDiscount,
  previewDiscount,
  getUsageStats,
  getReferenceCategories,
  getReferenceProducts,
  getReferenceStaff,
};
