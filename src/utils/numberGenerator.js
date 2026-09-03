const { platformPrisma } = require("../config/tenantPrisma");

const padNumber = (number) => {
    return String(number).padStart(6, "0");
};

/**
 * Find the MAX numeric suffix across all records for a given column.
 * Uses raw SQL to parse the numeric part after the prefix dash.
 * Returns 0 if no records exist.
 *
 * Example: for KOT records with kotNo "KOT-000090" and "KOT-0089",
 * this returns 90 (the MAX of 90, 89).
 */
async function findMaxNumberRaw(prisma, tableName, columnName) {
    try {
        const result = await prisma.$queryRawUnsafe(
            `SELECT COALESCE(MAX(CAST(SUBSTRING("${columnName}" FROM '(?<=-)\\d+$') AS INTEGER)), 0)::int as maxnum FROM "${tableName}"`
        );
        return Number(result[0]?.maxnum || 0);
    } catch (e) {
        // Fallback: find all and parse in JS
        try {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT "${columnName}" as val FROM "${tableName}"`
            );
            let maxNum = 0;
            for (const row of rows) {
                const val = row.val || "";
                const parts = String(val).split("-");
                if (parts.length >= 2) {
                    const num = parseInt(parts[parts.length - 1], 10);
                    if (Number.isFinite(num) && num > maxNum) maxNum = num;
                }
            }
            return maxNum;
        } catch (e2) {
            console.error(`[NumberGenerator] findMaxNumberRaw fallback failed for ${tableName}:`, e2.message);
            return 0;
        }
    }
}

// Generate Bill Number
const generateBillNumber = async (tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for generateBillNumber");

    const setting = await prisma.restaurantSetting.findFirst();

    if (!setting) {
        throw new Error("Restaurant settings not found");
    }

    // Find the actual MAX number across all bills (not just last by id)
    const maxNum = await findMaxNumberRaw(prisma, "Bill", "billNo");
    const nextNumber = Math.max(setting.billNumberStart || 1, maxNum + 1);

    return `${setting.billPrefix}-${padNumber(nextNumber)}`;
};

// Generate KOT Number
const generateKOTNumber = async (tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for generateKOTNumber");

    const setting = await prisma.restaurantSetting.findFirst();

    // Find the actual MAX number across all KOTs (not just last by id)
    const maxNum = await findMaxNumberRaw(prisma, "KOT", "kotNo");
    const nextNumber = Math.max(1, maxNum + 1);

    return `${setting.kotPrefix}-${padNumber(nextNumber)}`;
};

// Generate Order Number
const generateOrderNumber = async (tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for generateOrderNumber");

    // Find the actual MAX number across all orders (not just last by id)
    const maxNum = await findMaxNumberRaw(prisma, "Order", "orderNo");
    const nextNumber = Math.max(1, maxNum + 1);

    return `ORD-${padNumber(nextNumber)}`;
};

// Generate Invoice Number
const generateInvoiceNumber = async (tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for generateInvoiceNumber");

    const setting = await prisma.restaurantSetting.findFirst();

    // Find the actual MAX number across all bills (not just last by id)
    const maxNum = await findMaxNumberRaw(prisma, "Bill", "billNo");
    const nextNumber = Math.max(1, maxNum + 1);

    return `${setting.invoicePrefix}-${padNumber(nextNumber)}`;
};

// Generate Payment Number
const generatePaymentNumber = async (tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for generatePaymentNumber");

    // Find the actual MAX number across all payments (not just last by id)
    const maxNum = await findMaxNumberRaw(prisma, "Payment", "paymentNo");
    const nextNumber = Math.max(1, maxNum + 1);

    return `PAY-${String(nextNumber).padStart(6, "0")}`;
};

module.exports = {
    generateBillNumber,
    generateOrderNumber,
    generateKOTNumber,
    generateInvoiceNumber,
    generatePaymentNumber
};
