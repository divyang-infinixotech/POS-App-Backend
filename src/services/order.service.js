/**
 * Order service - queries tenant-schema models (Order, Bill, OrderItem).
 * All functions require a tenantDb (PrismaClient scoped to the tenant schema).
 */

const recalculateOrder = async (
    restaurantId,
    orderId,
    tenantDb
) => {
    const prisma = tenantDb;
    if (!prisma) {
        throw new Error("tenantDb is required for recalculateOrder");
    }

    const order = await prisma.order.findFirst({
        where: {
            id: Number(orderId)
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
        discount = (subtotal * order.discountValue) / 100;
    }

    if (discount > subtotal) {
        discount = subtotal;
    }

    const totalAmount = subtotal - discount + taxAmount + order.serviceCharge;

    await prisma.order.update({
        where: { id: order.id },
        data: { subtotal, discount, taxAmount, totalAmount }
    });

    const bill = await prisma.bill.findFirst({
        where: { orderId: order.id }
    });

    if (bill) {
        await prisma.bill.update({
            where: { id: bill.id },
            data: { subtotal, discount, taxAmount, grandTotal: totalAmount }
        });
    }
};

module.exports = { recalculateOrder };
