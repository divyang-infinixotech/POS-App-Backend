const prisma = require("../config/prisma");

const {

    buildBillTemplate

} = require("../templates/bill.template");
const {
    buildKOTTemplate
} = require("../templates/kot.template");

const savePrinterSettings = async (restaurantId, data) => {

    const existing = await prisma.printerSetting.findFirst({
        where: {
            restaurantId
        }
    });

    if (existing) {

        return await prisma.printerSetting.update({

            where: {

                id: existing.id

            },

            data

        });

    }

    return await prisma.printerSetting.create({

        data: {

            restaurantId,

            ...data

        }

    });

};

const getPrinterSettings = async (restaurantId) => {

    return await prisma.printerSetting.findFirst({
        where: {
            restaurantId
        }
    });

};




const getBillPrintData = async (restaurantId, billId) => {

    const restaurant =
        await prisma.restaurantSetting.findFirst({
            where: {
                restaurantId
            }
        });

    const bill =
        await prisma.bill.findFirst({

            where: {

                id: Number(billId),

                restaurantId

            },

            include: {

                order: {

                    include: {

                        table: true,

                        orderItems: {

                            include: {

                                menuItem: true

                            }

                        }

                    }

                }

            }

        });

    if (!bill) {

        throw new Error("Bill not found");

    }

    return buildBillTemplate(

        restaurant,

        bill,

        bill.order,

        bill.order.orderItems

    );

};

const getKOTPrintData = async (restaurantId, kotId) => {

    const restaurant =
        await prisma.restaurantSetting.findFirst({
            where: {
                restaurantId
            }
        });

    const kot =
        await prisma.kOT.findFirst({

            where: {

                id: Number(kotId),

                restaurantId

            },

            include: {

                order: {

                    include: {

                        table: true,

                        orderItems: {

                            include: {

                                menuItem: true

                            }

                        }

                    }

                }

            }

        });

    if (!kot) {

        throw new Error("KOT not found");

    }

    return buildKOTTemplate(

        restaurant,

        kot,

        kot.order,

        kot.order.orderItems

    );

};

const reprintBill = async (restaurantId, billId) => {

    const bill = await prisma.bill.findFirst({

        where: {

            id: Number(billId),

            restaurantId

        }

    });

    if (!bill) {

        throw new Error("Bill not found");

    }

    await prisma.bill.update({

        where: {

            id: bill.id

        },

        data: {

            reprintCount: {

                increment: 1

            },

            printedAt: new Date()

        }

    });

    return await getBillPrintData(
        restaurantId,
        billId
    );

};

module.exports = {

    savePrinterSettings,

    getPrinterSettings,

    getBillPrintData,
    getKOTPrintData,
    reprintBill

};