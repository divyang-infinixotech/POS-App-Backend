/**
 * Billing-capable roles — the ONLY roles allowed to create bills, collect
 * payments, run checkout-desk operations, and reprint/print/email receipts.
 *
 * KITCHEN and WAITER are explicitly excluded. SUPER_ADMIN is granted access
 * automatically by role.middleware.js (authorize bypasses the role check for
 * SUPER_ADMIN), so it does not need to appear in this list.
 *
 * Mirrored on the frontend as `canHandleBilling` (src/utils/permissions.js) so
 * the UI visibility and the API enforcement always agree.
 */
const BILLING_ROLES = ["ADMIN", "MANAGER", "CASHIER"];

const isBillingRole = (role) => BILLING_ROLES.includes(role);

module.exports = { BILLING_ROLES, isBillingRole };