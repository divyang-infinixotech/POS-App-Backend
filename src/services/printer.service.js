const { platformPrisma } = require("../config/tenantPrisma");

const {
    buildBillTemplate
} = require("../templates/bill.template");
const {
    buildKOTTemplate
} = require("../templates/kot.template");

const savePrinterSettings = async (restaurantId, data, tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for printer service");

    const existing = await prisma.printerSetting.findFirst({
        where: { restaurantId }
    });

    if (existing) {
        return await prisma.printerSetting.update({
            where: { id: existing.id },
            data
        });
    }

    return await prisma.printerSetting.create({
        data: { restaurantId, ...data }
    });
};

const getPrinterSettings = async (restaurantId, tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for printer service");

    return await prisma.printerSetting.findFirst({
        where: { restaurantId }
    });
};

const getBillPrintData = async (restaurantId, billId, tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for printer service");

    const restaurant = await prisma.restaurantSetting.findFirst({
        where: { restaurantId }
    });

    const bill = await prisma.bill.findFirst({
        where: { id: Number(billId) },
        include: {
            order: {
                include: {
                    table: true,
                    orderItems: { include: { menuItem: true } }
                }
            }
        }
    });

    if (!bill) {
        throw new Error("Bill not found");
    }

    return buildBillTemplate(restaurant, bill, bill.order, bill.order.orderItems);
};

const getKOTPrintData = async (restaurantId, kotId, tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for printer service");

    const restaurant = await prisma.restaurantSetting.findFirst({
        where: { restaurantId }
    });

    const kot = await prisma.kOT.findFirst({
        where: { id: Number(kotId) },
        include: {
            order: {
                include: {
                    table: true,
                    orderItems: { include: { menuItem: true } }
                }
            },
            kotItems: {
                include: { menuItem: true }
            }
        }
    });

    if (!kot) {
        throw new Error("KOT not found");
    }

    // KOTItems are the authoritative source for what a KOT contains.
    // A NEW KOT MUST have KOTItems. Only genuinely legacy KOTs (created before
    // incremental tracking existed) may lack them.
    if (!kot.kotItems || kot.kotItems.length === 0) {
        // Check if this is a legacy KOT (created before KOTItem tracking existed)
        const isLegacy = !kot.kotItems || kot.kotItems.length === 0;
        if (isLegacy) {
            console.warn(
                `[Printer] KOT ${kot.kotNo} has no KOTItems — treating as legacy KOT. ` +
                `Falling back to all order items. ` +
                `If this is a NEW KOT, the KOTItem creation may have failed and should be investigated.`
            );
            // Legacy fallback: use all order items
            return buildKOTTemplate(restaurant, kot, kot.order, kot.order.orderItems);
        }
    }

    // Correct path for new KOTs: use ONLY the delta items recorded in KOTItem
    return buildKOTTemplate(restaurant, kot, kot.order, kot.kotItems);
};

const reprintBill = async (restaurantId, billId, tenantDb) => {
    const prisma = tenantDb;
    if (!prisma) throw new Error("tenantDb is required for printer service");

    const bill = await prisma.bill.findFirst({
        where: { id: Number(billId) }
    });

    if (!bill) {
        throw new Error("Bill not found");
    }

    await prisma.bill.update({
        where: { id: bill.id },
        data: {
            reprintCount: { increment: 1 },
            printedAt: new Date()
        }
    });

    return await getBillPrintData(restaurantId, billId, tenantDb);
};

module.exports = {
    savePrinterSettings,
    getPrinterSettings,
    getBillPrintData,
    getKOTPrintData,
    reprintBill
};
