/**
 * Discounts & Promotions — PURE discount rules (single source of truth).
 *
 * ALL discount eligibility evaluation, amount calculation, stacking rules,
 * staff-role limits and input validation live HERE. The service layer
 * (discountEngine.service.js) only orchestrates database reads/writes and
 * transactions on top of these pure functions — so the POS, billing, reports
 * and admin screens can never drift into their own discount math, and the
 * rules are unit-testable without a database.
 *
 * Deterministic evaluation order (spec §19):
 *   1. Schedule   (date range → day → time window)
 *   2. Scope      (entire order / category / product coverage)
 *   3. Minimum order
 *   4. Admin status switch (DISABLED/ARCHIVED never eligible)
 *   5. Usage limits
 *   6. Customer/staff eligibility
 *   7. Stacking
 *   8. Amount calculation (incl. maximum-discount cap + subtotal clamp)
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMOTION_TYPES = ["PERCENTAGE", "FIXED_AMOUNT", "STAFF", "PROMO_CODE"];
const DISCOUNT_STATUSES = ["ACTIVE", "SCHEDULED", "DISABLED"];
const DISCOUNT_SCOPES = ["ENTIRE_ORDER", "CATEGORIES", "PRODUCTS"];
const CUSTOMER_ELIGIBILITIES = ["EVERYONE", "REGISTERED"];

// Day bitmask — bit 0 = Sunday … bit 6 = Saturday (JS getDay() order).
const DAY_BIT = { SUN: 1, MON: 2, TUE: 4, WED: 8, THU: 16, FRI: 32, SAT: 64 };
const ALL_DAYS_MASK = 127; // every day within the date range

// ─── Small helpers ──────────────────────────────────────────────────────────

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Normalize a promo code deterministically: trim + uppercase + collapse inner
 * whitespace. "welcome10", " WELCOME10 ", "Welcome 10" → "WELCOME10"/"WELCOME 10".
 * One rule everywhere (creation, lookup, uniqueness).
 */
function normalizePromoCode(code) {
  return String(code || "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Parse "HH:mm" (24h) → minutes since midnight, or null when invalid/absent. */
function parseHHmm(value) {
  if (value == null || value === "") return null;
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Validate an "HH:mm" time string (used by admin input validation). */
function isValidHHmm(value) {
  if (value == null || value === "") return true; // optional
  return parseHHmm(value) !== null;
}

/** Day-of-week mask for a JS Date (server-local date — see timezone note below). */
function dayMaskFor(date) {
  const bit = 1 << new Date(date).getDay();
  return bit;
}

/**
 * Convert a day-name list (["MON","SAT"]) to the bitmask; empty → every day.
 */
function dayListToMask(days) {
  if (!Array.isArray(days) || days.length === 0) return ALL_DAYS_MASK;
  let mask = 0;
  for (const d of days) {
    const bit = DAY_BIT[String(d || "").trim().toUpperCase().slice(0, 3)];
    if (!bit) return NaN; // invalid day name → caller rejects
    mask |= bit;
  }
  return mask;
}

/** Bitmask → sorted ["Fri","Sat","Sun"] display list. */
function maskToDayList(mask) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const out = [];
  for (let i = 0; i < 7; i++) {
    if (Number(mask) & (1 << i)) out.push(names[i]);
  }
  return out;
}

/**
 * TIMEZONE STRATEGY (consistent with the rest of the app):
 * start/end DATE+TIME are stored as instants (Date). The optional daily
 * time WINDOW (startTime/endTime "HH:mm") and the day-of-week check are
 * evaluated in the business timezone via an offset, so a 16:00–19:00 happy
 * hour means 16:00–19:00 restaurant-local — not server-local.
 */
function businessZonedParts(date, offsetMinutes = 330 /* Asia/Kolkata */) {
  const d = new Date(date.getTime() + offsetMinutes * 60000);
  return {
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dayBit: 1 << d.getUTCDay(),
  };
}

// ─── Schedule evaluation (date → day → time) ────────────────────────────────

/**
 * Is the discount within its date range at `now`?
 * endDate is inclusive: an end of "30/09" covers the whole 30 Sep day when the
 * stored instant is a local-midnight value — we compare against now only.
 */
function isWithinDateRange(discount, now = new Date()) {
  const t = now.getTime();
  const start = new Date(discount.startDate).getTime();
  const end = new Date(discount.endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  // Inclusive end: if the stored endDate has no explicit time component
  // (midnight), treat the whole end day as covered.
  const endInclusive = end + (isMidnight(end) ? 24 * 60 * 60 * 1000 - 1 : 0);
  return t >= start && t <= endInclusive;
}

function isMidnight(ms) {
  const d = new Date(ms);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

/** Is the current weekday part of applicableDays? (empty/127 = every day) */
function isDayValid(discount, now = new Date(), offsetMinutes = 330) {
  const mask = Number(discount.applicableDays ?? ALL_DAYS_MASK);
  if (!mask || mask === ALL_DAYS_MASK) return true;
  const { dayBit } = businessZonedParts(now, offsetMinutes);
  return (mask & dayBit) !== 0;
}

/**
 * Daily time-window check. Handles windows crossing midnight (e.g. 22:00–02:00)
 * correctly: start > end means the window wraps past midnight.
 * Absent window → always valid.
 */
function isTimeValid(discount, now = new Date(), offsetMinutes = 330) {
  const startM = parseHHmm(discount.startTime);
  const endM = parseHHmm(discount.endTime);
  if (startM == null && endM == null) return true;
  const { minutes } = businessZonedParts(now, offsetMinutes);
  if (startM == null) return minutes <= endM;
  if (endM == null) return minutes >= startM;
  if (startM === endM) return true; // degenerate → treat as all day
  if (startM < endM) return minutes >= startM && minutes <= endM; // same-day window
  return minutes >= startM || minutes <= endM; // crosses midnight
}

// ─── Scope evaluation ───────────────────────────────────────────────────────

/**
 * Does the discount's scope cover this order's items?
 * context: { scope, categoryIdsByItem: [Set|Array], menuItemIds: [Number] }
 * ENTIRE_ORDER → always covered. CATEGORIES/PRODUCTS → covered when EVERY
 * matching-scope item in the order falls inside the selection (partial
 * coverage discounts must not silently shrink an entire order's total).
 */
function isScopeCovered(discount, orderItems, options = {}) {
  const scope = discount.scope || "ENTIRE_ORDER";
  if (scope === "ENTIRE_ORDER") return true;

  const includedIds = options.includedIds || [];
  const included = new Set(includedIds.map(Number));

  if (scope === "PRODUCTS") {
    const ids = (orderItems || []).map((oi) => Number(oi.menuItemId));
    if (ids.length === 0) return false;
    return ids.every((id) => included.has(id));
  }

  if (scope === "CATEGORIES") {
    const catIds = (orderItems || []).map((oi) => Number(oi.categoryId));
    if (catIds.length === 0) return false;
    return catIds.every((id) => included.has(id));
  }
  return false;
}

// ─── Eligibility evaluation ─────────────────────────────────────────────────

/**
 * Full deterministic eligibility check. Returns { eligible, reason } — reason
 * is a stable machine code the frontend maps to friendly copy.
 *
 * @param {object} discount   Discount row (+ .promoCode when relevant)
 * @param {object} context
 *   now           Date (default now)
 *   subtotal      Number  order subtotal
 *   orderItems    Array   [{ menuItemId, categoryId }]
 *   includedIds   Array   scope junction ids (category or product ids)
 *   customerType  String  WALK_IN | REGULAR | VIP | null
 *   staffRole     String  recipient staff role (for STAFF type, apply path)
 *   deferStaffChecks Boolean skip staff-role checks (eligible-listing for STAFF:
 *                          recipient is selected later, at apply time)
 *   requestedValue Number override for staff percentage (optional)
 *   offsetMinutes Number business timezone offset (default IST)
 */
function evaluateEligibility(discount, context = {}) {
  const now = context.now || new Date();

  // 1. Admin lifecycle switch — DISABLED or archived is never eligible
  if (discount.status === "DISABLED") {
    return { eligible: false, reason: "DISABLED" };
  }
  if (discount.archivedAt) {
    return { eligible: false, reason: "ARCHIVED" };
  }

  // 2. Schedule (§28: effective status derived from schedule)
  if (!isWithinDateRange(discount, now)) {
    return { eligible: false, reason: "OUT_OF_DATE_RANGE" };
  }
  if (!isDayValid(discount, now, context.offsetMinutes)) {
    return { eligible: false, reason: "DAY_NOT_VALID" };
  }
  if (!isTimeValid(discount, now, context.offsetMinutes)) {
    return { eligible: false, reason: "OUT_OF_TIME_WINDOW" };
  }

  // 3. Scope coverage
  if (!isScopeCovered(discount, context.orderItems || [], {
    includedIds: context.includedIds || [],
  })) {
    return { eligible: false, reason: "SCOPE_NOT_COVERED" };
  }

  // 4. Minimum order (§11)
  const minAmount = Number(discount.minimumOrderAmount || 0);
  if (minAmount > 0 && Number(context.subtotal || 0) < minAmount) {
    return { eligible: false, reason: "MINIMUM_ORDER" };
  }

  // 5. Usage limits (server counters — checked against passed-in usageCount)
  if (discount.usageLimit != null && Number(discount.usageLimit) > 0) {
    if (Number(discount.usageCount || 0) >= Number(discount.usageLimit)) {
      return { eligible: false, reason: "USAGE_LIMIT_REACHED" };
    }
  }
  if (discount.perCustomerLimit != null && Number(discount.perCustomerLimit) > 0) {
    const used = Number(context.customerUses || 0);
    if (used >= Number(discount.perCustomerLimit)) {
      return { eligible: false, reason: "PER_CUSTOMER_LIMIT_REACHED" };
    }
  }

  // 6. Customer eligibility (§17 — only rules the real data supports:
  //    walk-in vs registered customer rows)
  if (discount.customerEligibility === "REGISTERED") {
    if (!context.customerType || context.customerType === "WALK_IN") {
      return { eligible: false, reason: "REGISTERED_CUSTOMERS_ONLY" };
    }
  }

  // 7. Staff-specific rules (§13/§14).
  // NOTE: the listing endpoint passes deferStaffChecks for STAFF promotions —
  // at listing time no recipient has been chosen yet, so role/targeting/cap
  // validation belongs to the apply path where the staff member is selected
  // (the applier's own role must never gate someone else's staff discount).
  if (discount.type === "STAFF" && !context.deferStaffChecks) {
    if (!context.staffRole) {
      return { eligible: false, reason: "STAFF_DISCOUNT_REQUIRES_STAFF_USER" };
    }
    const roles = parseStaffRoles(discount.staffRoles);
    if (roles.length > 0 && !roles.includes(String(context.staffRole).toUpperCase())) {
      return { eligible: false, reason: "STAFF_ROLE_NOT_ELIGIBLE" };
    }
    // Specific-staff targeting: when the promotion names eligible staff
    // members, the receiving user must be one of them (staffUserId context).
    const staffUserIds = parseStaffUserIds(discount.staffUserIds);
    if (staffUserIds.length > 0 && context.staffUserId != null &&
        !staffUserIds.includes(Number(context.staffUserId))) {
      return { eligible: false, reason: "STAFF_MEMBER_NOT_ELIGIBLE" };
    }
    // Role-specific maximum (§14): an EXPLICITLY requested percentage can
    // never exceed the role's configured cap. With no explicit request the
    // engine applies min(configured, roleCap) — a cap of 0 excludes the role.
    const roleCap = staffRoleMaxPercent(discount, context.staffRole);
    const requested = context.requestedValue != null ? Number(context.requestedValue) : null;
    if (requested != null && requested > roleCap) {
      return { eligible: false, reason: "STAFF_ROLE_LIMIT", detail: { roleCap } };
    }
    if (requested == null && roleCap <= 0) {
      return { eligible: false, reason: "STAFF_ROLE_LIMIT", detail: { roleCap } };
    }
  }

  return { eligible: true, reason: null };
}

function parseStaffRoles(json) {
  if (!json) return [];
  try {
    const arr = typeof json === "string" ? JSON.parse(json) : json;
    return Array.isArray(arr) ? arr.map((r) => String(r).toUpperCase()) : [];
  } catch {
    return [];
  }
}

/** Parse Discount.staffUserIds (JSON array of tenant User ids) safely. */
function parseStaffUserIds(json) {
  if (!json) return [];
  try {
    const arr = typeof json === "string" ? JSON.parse(json) : json;
    return Array.isArray(arr) ? arr.map(Number).filter(Number.isSafeInteger) : [];
  } catch {
    return [];
  }
}

/** Role cap for STAFF discounts: staffRoleMaxPercent[role] else discountValue. */
function staffRoleMaxPercent(discount, role) {
  const map = discount.staffRoleMaxPercent;
  let parsed = null;
  if (map != null) {
    try {
      parsed = typeof map === "string" ? JSON.parse(map) : map;
    } catch {
      parsed = null;
    }
  }
  const key = String(role || "").toUpperCase();
  if (parsed && typeof parsed === "object" && parsed[key] != null) {
    return Number(parsed[key]);
  }
  return Number(discount.discountValue); // default cap = configured value
}

// ─── Amount calculation (§12) ───────────────────────────────────────────────

/**
 * THE discount calculation. One place, used by apply/promo/manual paths.
 * PERCENTAGE → subtotal × value% (capped by maximumDiscountAmount, then subtotal)
 * FIXED_AMOUNT/STAFF/PROMO_CODE → value (capped by maximumDiscountAmount, then subtotal)
 * staffRequestedValue lets a STAFF discount apply a role-allowed percentage
 * lower than the configured one (never higher — caller must have validated).
 */
function calculateDiscountAmount(discount, subtotal, staffRequestedValue = null) {
  const sub = Math.max(0, Number(subtotal) || 0);
  let amount = 0;
  const value = Number(
    discount.type === "STAFF" && staffRequestedValue != null
      ? staffRequestedValue
      : discount.discountValue
  );

  // Effective calculation method (§4/§5): PERCENTAGE and STAFF are always
  // percentage-based; PROMO_CODE resolves through promoMethod (percentage vs
  // fixed, default fixed); FIXED_AMOUNT is a flat amount.
  const type = String(discount.type || "").toUpperCase();
  const method =
    type === "PROMO_CODE"
      ? (discount.promoMethod === "PERCENTAGE" ? "PERCENTAGE" : "FIXED_AMOUNT")
      : type === "PERCENTAGE" || type === "STAFF"
        ? "PERCENTAGE"
        : "FIXED_AMOUNT";

  if (method === "PERCENTAGE") {
    amount = (sub * value) / 100;
  } else {
    amount = value;
  }

  if (discount.maximumDiscountAmount != null && Number(discount.maximumDiscountAmount) > 0) {
    amount = Math.min(amount, Number(discount.maximumDiscountAmount));
  }
  amount = Math.min(amount, sub); // payable can never go negative
  return round2(Math.max(0, amount));
}

/** Human-readable value label for previews/receipts: "20% OFF" / "₹200 OFF". */
function discountLabel(discount, staffRequestedValue = null) {
  const value = Number(
    discount.type === "STAFF" && staffRequestedValue != null ? staffRequestedValue : discount.discountValue
  );
  // PROMO_CODE labels follow its configured method (percentage vs fixed)
  const isPercent =
    discount.type === "PERCENTAGE" ||
    discount.type === "STAFF" ||
    (discount.type === "PROMO_CODE" && discount.promoMethod === "PERCENTAGE");
  if (isPercent) return `${value}% OFF`;
  return `₹${value} OFF`;
}

// ─── Stacking (§18) ─────────────────────────────────────────────────────────

/**
 * Can this discount be added on top of the discounts already applied to the
 * order? Returns { allowed, reason }.
 */
function canStackWith(existingApplied, incomingDiscount) {
  const existing = Array.isArray(existingApplied) ? existingApplied : [];
  if (existing.length === 0) return { allowed: true, reason: null };

  const maxPerOrder = Number(incomingDiscount.maxDiscountsPerOrder || 1);
  if (existing.length >= maxPerOrder) {
    return { allowed: false, reason: "MAX_DISCOUNTS_PER_ORDER" };
  }
  if (incomingDiscount.stackable === false) {
    return { allowed: false, reason: "NOT_STACKABLE" };
  }
  // Existing non-stackable discounts also block a later add-on (the engine
  // re-checks every existing row, not just the incoming one).
  const hasNonStackable = existing.some((d) => d.stackable === false || d.isManual === true);
  if (hasNonStackable) {
    return { allowed: false, reason: "EXISTING_NOT_STACKABLE" };
  }
  return { allowed: true, reason: null };
}

// ─── Effective status (§28) ─────────────────────────────────────────────────

/**
 * Derived display status. Stored status is only the admin switch:
 *   DISABLED            → DISABLED (never becomes ACTIVE automatically)
 *   archived            → EXPIRED (display)
 *   before startDate    → SCHEDULED
 *   within range        → ACTIVE   (SCHEDULED auto-activates)
 *   after endDate       → EXPIRED
 */
function effectiveStatus(discount, now = new Date()) {
  if (discount.status === "DISABLED") return "DISABLED";
  if (discount.archivedAt) return "EXPIRED";
  if (!isWithinDateRange(discount, now)) {
    const start = new Date(discount.startDate).getTime();
    return now.getTime() < start ? "SCHEDULED" : "EXPIRED";
  }
  return "ACTIVE";
}

// ─── Admin input validation (§6) ────────────────────────────────────────────

/**
 * Full create/update validation for a discount payload. Returns
 * { valid, errors: {field: message} } — the controller rejects with 400 when
 * invalid. Frontend repeats these rules for UX; backend is authoritative.
 */
function validateDiscountInput(payload) {
  const errors = {};
  const p = payload || {};

  // Basic information
  if (!p.name || !String(p.name).trim()) errors.name = "Discount name is required";
  else if (String(p.name).trim().length > 120) errors.name = "Discount name is too long";

  if (!PROMOTION_TYPES.includes(p.type)) errors.type = "Invalid discount type";
  if (!DISCOUNT_SCOPES.includes(p.scope)) errors.scope = "Invalid scope";

  // Discount value (§6)
  const value = Number(p.discountValue);
  if (!Number.isFinite(value)) errors.discountValue = "Discount value is required";
  else if (value <= 0) errors.discountValue = "Discount value must be greater than 0";
  else if ((p.type === "PERCENTAGE" || p.type === "STAFF") && value > 100) {
    errors.discountValue = "Percentage cannot exceed 100";
  }

  const maxAmt = p.maximumDiscountAmount;
  if (maxAmt != null && maxAmt !== "" && (!Number.isFinite(Number(maxAmt)) || Number(maxAmt) < 0)) {
    errors.maximumDiscountAmount = "Maximum discount must be 0 or more";
  }

  const minAmt = p.minimumOrderAmount;
  if (minAmt != null && minAmt !== "" && (!Number.isFinite(Number(minAmt)) || Number(minAmt) < 0)) {
    errors.minimumOrderAmount = "Minimum order amount must be 0 or more";
  }

  // Schedule (§8): start must exist, end must exist, end after start
  if (!p.startDate) errors.startDate = "Start date is required";
  if (!p.endDate) errors.endDate = "End date is required";
  if (p.startDate && p.endDate) {
    const s = new Date(p.startDate);
    const e = new Date(p.endDate);
    if (Number.isNaN(s.getTime())) errors.startDate = "Invalid start date";
    if (Number.isNaN(e.getTime())) errors.endDate = "Invalid end date";
    if (!errors.startDate && !errors.endDate && e.getTime() <= s.getTime()) {
      errors.endDate = "End date must be after the start date";
    }
  }
  if (!isValidHHmm(p.startTime)) errors.startTime = "Start time must be HH:mm";
  if (!isValidHHmm(p.endTime)) errors.endTime = "Time window must be HH:mm";

  // Days (§9)
  if (p.applicableDays != null) {
    const n = Number(p.applicableDays);
    if (!Number.isInteger(n) || n < 0 || n > 127) errors.applicableDays = "Invalid days selection";
  }

  // Usage limits (§16)
  if (p.usageLimit != null && p.usageLimit !== "") {
    const n = Number(p.usageLimit);
    if (!Number.isInteger(n) || n <= 0) errors.usageLimit = "Usage limit must be a positive whole number";
  }
  if (p.perCustomerLimit != null && p.perCustomerLimit !== "") {
    const n = Number(p.perCustomerLimit);
    if (!Number.isInteger(n) || n <= 0) errors.perCustomerLimit = "Per-customer limit must be a positive whole number";
  }
  if (p.maxDiscountsPerOrder != null) {
    const n = Number(p.maxDiscountsPerOrder);
    if (!Number.isInteger(n) || n < 1 || n > 5) errors.maxDiscountsPerOrder = "Max discounts per order must be 1–5";
  }

  // Status (§4): EXPIRED is derived, never settable
  if (p.status != null && !DISCOUNT_STATUSES.includes(p.status)) {
    errors.status = "Status must be ACTIVE, SCHEDULED or DISABLED";
  }

  if (!CUSTOMER_ELIGIBILITIES.includes(p.customerEligibility || "EVERYONE")) {
    errors.customerEligibility = "Invalid customer eligibility";
  }

  // Scope selections must be present when scoped
  if (p.scope === "CATEGORIES" && (!Array.isArray(p.categoryIds) || p.categoryIds.length === 0)) {
    errors.categoryIds = "Select at least one category";
  }
  if (p.scope === "PRODUCTS" && (!Array.isArray(p.menuItemIds) || p.menuItemIds.length === 0)) {
    errors.menuItemIds = "Select at least one product";
  }

  // Staff discount (§13/§14)
  if (p.type === "STAFF") {
    const roles = p.staffRoles;
    if (!Array.isArray(roles) || roles.length === 0) {
      errors.staffRoles = "Select at least one eligible role";
    } else {
      const valid = ["ADMIN", "MANAGER", "CASHIER", "WAITER", "KITCHEN"];
      if (!roles.every((r) => valid.includes(String(r).toUpperCase()))) {
        errors.staffRoles = "Invalid role selected";
      }
    }
    if (p.staffRoleMaxPercent != null && typeof p.staffRoleMaxPercent === "object") {
      for (const [role, pct] of Object.entries(p.staffRoleMaxPercent)) {
        if (pct === "" || pct == null) continue;
        const n = Number(pct);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          errors.staffRoleMaxPercent = `${role}: percentage must be between 0 and 100`;
          break;
        }
      }
    }
  }

  // Promo code (§15)
  if (p.type === "PROMO_CODE") {
    if (!p.code || !String(p.code).trim()) errors.code = "Promo code is required";
    else if (String(p.code).trim().length > 40) errors.code = "Promo code is too long";
    // Promo grants either a percentage or a fixed amount — never both
    if (p.promoMethod != null && !["PERCENTAGE", "FIXED_AMOUNT"].includes(p.promoMethod)) {
      errors.promoMethod = "Promo method must be PERCENTAGE or FIXED_AMOUNT";
    } else if (p.promoMethod === "PERCENTAGE" && value > 100) {
      errors.discountValue = "Percentage promo cannot exceed 100";
    }
  }

  // Specific-staff targeting (STAFF type): must be an array of positive ints
  if (p.type === "STAFF" && p.staffUserIds != null) {
    const ids = Array.isArray(p.staffUserIds) ? p.staffUserIds : null;
    if (!ids || !ids.every((n) => Number.isSafeInteger(Number(n)) && Number(n) > 0)) {
      errors.staffUserIds = "Eligible staff must be a list of valid staff members";
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// ─── Manual discount validation (§22) ───────────────────────────────────────

const MANUAL_DISCOUNT_LIMITS = { PERCENTAGE_MAX: 50, FLAT_MAX: 5000 };

/**
 * Manual (ad-hoc) discount authorization. Rejects out-of-range values and
 * roles above their billing.discount permission level. Returns
 * { allowed, reason, amount }.
 */
function authorizeManualDiscount({ type, value, subtotal, role, hasDiscountPermission }) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) {
    return { allowed: false, reason: "INVALID_VALUE" };
  }
  if (type === "PERCENTAGE") {
    if (v > 100) return { allowed: false, reason: "INVALID_VALUE" };
  }
  const sub = Math.max(0, Number(subtotal) || 0);

  // Permission gate — the existing RBAC action stays authoritative. A role
  // without the billing.discount permission can never apply a manual discount,
  // regardless of what the UI renders.
  if (!hasDiscountPermission) {
    return { allowed: false, reason: "NO_PERMISSION" };
  }

  const amount = type === "PERCENTAGE" ? round2((sub * v) / 100) : round2(v);
  if (type === "PERCENTAGE" && v > MANUAL_DISCOUNT_LIMITS.PERCENTAGE_MAX) {
    // Above the manual ceiling requires manager approval upstream (§22) —
    // this pure check only flags it.
    return { allowed: true, reason: "NEEDS_APPROVAL", amount };
  }
  if (type === "FIXED_AMOUNT" && v > MANUAL_DISCOUNT_LIMITS.FLAT_MAX) {
    return { allowed: true, reason: "NEEDS_APPROVAL", amount };
  }
  return { allowed: true, reason: null, amount: Math.min(amount, sub) };
}

module.exports = {
  PROMOTION_TYPES,
  DISCOUNT_STATUSES,
  DISCOUNT_SCOPES,
  CUSTOMER_ELIGIBILITIES,
  DAY_BIT,
  ALL_DAYS_MASK,
  MANUAL_DISCOUNT_LIMITS,
  round2,
  normalizePromoCode,
  parseHHmm,
  isValidHHmm,
  dayMaskFor,
  dayListToMask,
  maskToDayList,
  businessZonedParts,
  isWithinDateRange,
  isDayValid,
  isTimeValid,
  isScopeCovered,
  evaluateEligibility,
  parseStaffRoles,
  parseStaffUserIds,
  staffRoleMaxPercent,
  calculateDiscountAmount,
  discountLabel,
  canStackWith,
  effectiveStatus,
  validateDiscountInput,
  authorizeManualDiscount,
};
