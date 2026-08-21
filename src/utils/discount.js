/**
 * Discount calculation utilities.
 * Shared between bill and payment modules.
 */

/**
 * Calculate the discount amount from discount type and value.
 * @param {string|null} discountType - "FLAT", "PERCENTAGE", or null
 * @param {number} discountValue - The discount value (percentage or amount)
 * @param {number} subtotal - The order/bill subtotal to calculate against
 * @returns {number} The calculated discount amount (rounded to 2 decimals)
 */
function calculateDiscountAmount(discountType, discountValue, subtotal) {
  let discountAmount = 0;
  if (discountType === "PERCENTAGE") {
    discountAmount = (Number(subtotal) * Number(discountValue)) / 100;
  } else if (discountType === "FLAT") {
    discountAmount = Number(discountValue);
  }
  // Discount cannot exceed subtotal
  if (discountAmount > Number(subtotal)) {
    discountAmount = Number(subtotal);
  }
  return Math.round(discountAmount * 100) / 100;
}

/**
 * Format a discount label for display on receipts/invoices.
 * @param {object} bill - Bill object with discountType, discountValue, discount fields
 * @returns {string} Formatted discount label
 */
function formatDiscountLabel(bill) {
  if (!bill || !Number(bill.discount || 0)) return "";
  if (bill.discountType === "PERCENTAGE") {
    return `Discount (${Number(bill.discountValue || 0)}%):`;
  } else if (bill.discountType === "FLAT" && Number(bill.discountValue || 0) > 0) {
    return `Discount (\u20B9${Number(bill.discountValue).toFixed(0)}):`;
  }
  return "Discount:";
}

module.exports = {
  calculateDiscountAmount,
  formatDiscountLabel,
};
