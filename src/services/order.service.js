const prisma = require("../config/prisma");

const recalculateOrder = async (
    restaurantId,
    orderId
) => {

    const order = await prisma.order.findFirst({

        where: {

            id: Number(orderId),

            restaurantId

        },

        include: {

            orderItems: true

        }

    });

    if (!order) {

        throw new Error("Order not found");

    }

    let subtotal = 0;

    let taxAmount = 0;

    for (const item of order.orderItems) {

        subtotal += item.price * item.quantity;

        taxAmount += item.tax;

    }

    let discount = 0;

    if (order.discountType === "FLAT") {

        discount = order.discountValue;

    }

    else if (order.discountType === "PERCENTAGE") {

        discount =

            (subtotal * order.discountValue) / 100;

    }

    if (discount > subtotal) {

        discount = subtotal;

    }

    const totalAmount =

        subtotal -

        discount +

        taxAmount +

        order.serviceCharge;

    await prisma.order.update({

        where: {

            id: order.id

        },

        data: {

            subtotal,

            discount,

            taxAmount,

            totalAmount

        }

    });

    const bill = await prisma.bill.findFirst({

        where: {

            orderId: order.id,

            restaurantId

        }

    });

    if (bill) {

        await prisma.bill.update({

            where: {

                id: bill.id

            },

            data: {

                subtotal,

                discount,

                taxAmount,

                grandTotal: totalAmount

            }

        });

    }


};

module.exports = {

    recalculateOrder

};