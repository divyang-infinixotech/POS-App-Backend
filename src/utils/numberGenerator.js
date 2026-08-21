const prisma = require("../config/prisma");

const padNumber = (number) => {
    return String(number).padStart(6, "0");
};

// Generate Bill Number
const generateBillNumber = async () => {

    const setting = await prisma.restaurantSetting.findFirst();

    if (!setting) {
        throw new Error("Restaurant settings not found");
    }

    const lastBill = await prisma.bill.findFirst({
        orderBy: {
            id: "desc"
        }
    });

    let nextNumber = setting.billNumberStart;

    if (lastBill) {

        const last = parseInt(
            lastBill.billNo.split("-")[1]
        );

        nextNumber = last + 1;
    }

    return `${setting.billPrefix}-${padNumber(nextNumber)}`;
};

// Generate KOT Number
const generateKOTNumber = async () => {

    const setting = await prisma.restaurantSetting.findFirst();

    const lastKOT = await prisma.kOT.findFirst({
        orderBy: {
            id: "desc"
        }
    });

    let nextNumber = 1;

    if (lastKOT) {

        const last = parseInt(
            lastKOT.kotNo.split("-")[1]
        );

        nextNumber = last + 1;
    }

    return `${setting.kotPrefix}-${padNumber(nextNumber)}`;
};

// Generate Order Number
const generateOrderNumber = async () => {

    const lastOrder = await prisma.order.findFirst({
        orderBy: {
            id: "desc"
        }
    });

    let nextNumber = 1;

    if (lastOrder) {

        const last = parseInt(
            lastOrder.orderNo.split("-")[1]
        );

        nextNumber = last + 1;
    }

    return `ORD-${padNumber(nextNumber)}`;
};

// Generate Invoice Number
const generateInvoiceNumber = async () => {

    const setting = await prisma.restaurantSetting.findFirst();

    const lastBill = await prisma.bill.findFirst({
        orderBy: {
            id: "desc"
        }
    });

    let nextNumber = 1;

    if (lastBill) {

        const last = parseInt(
            lastBill.billNo.split("-")[1]
        );

        nextNumber = last + 1;
    }

    return `${setting.invoicePrefix}-${padNumber(nextNumber)}`;
};

// Generate Payment Number
const generatePaymentNumber = async () => {

    const lastPayment = await prisma.payment.findFirst({

        orderBy: {

            id: "desc"

        }

    });

    let nextNumber = 1;

    if (lastPayment) {

        const last = parseInt(

            lastPayment.paymentNo.split("-")[1]

        );

        nextNumber = last + 1;

    }

    return `PAY-${String(nextNumber).padStart(6, "0")}`;

};

module.exports = {

    generateBillNumber,

    generateOrderNumber,

    generateKOTNumber,

    generateInvoiceNumber,

    generatePaymentNumber

};