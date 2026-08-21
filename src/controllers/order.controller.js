const prisma = require("../config/prisma");
const { successResponse, errorResponse } = require("../utils/response");
const {
    generateOrderNumber
} = require("../utils/numberGenerator");
// const { text } = require("pdfkit");
const {
    recalculateOrder
} = require("../services/order.service");
const {
    createNotification
} = require("../services/notification.service");
const {
    generateKOTNumber
} = require("../utils/numberGenerator");
const { emitOrderEvent } = require("../services/socket");
const {
    deductStockForOrderCreation,
    deductStockForAddedItems,
    adjustStockForOrderChange,
    restoreStockForCancelledOrder
} = require("../services/inventory.service");

const createOrder = async (req, res) => {
    try {

        const {

            tableId,
            customerId,
            orderType,

            discountType,
            discountValue = 0,

            serviceCharge = 0,

            notes,

            items

        } = req.body;
        // Validate table belongs to current restaurant (skip for COUNTER_SALE)
        if (tableId && orderType !== "COUNTER_SALE") {

            const table = await prisma.restaurantTable.findFirst({

                where: {

                    id: Number(tableId),

                    restaurantId: req.user.restaurantId

                }

            });

            if (!table) {

                return errorResponse(

                    res,

                    "Table not found",

                    404

                );

            }

            if (table.status !== "AVAILABLE") {

                return errorResponse(

                    res,

                    "Selected table is not available"

                );

            }

        }

        const order = await prisma.$transaction(async (tx) => {

            let subtotal = 0;
            let taxAmount = 0;

            const orderItems = [];

            for (const item of items) {

                const menuItem = await tx.menuItem.findFirst({
                    where: {
                        id: Number(item.menuItemId),
                        restaurantId: req.user.restaurantId
                    }
                });

                if (!menuItem) {
                    const err = new Error(`Menu Item ${item.menuItemId} not found`);
                    err.statusCode = 404;
                    throw err;
                }

                if (!menuItem.isAvailable) {
                    const err = new Error(`${menuItem.name} is unavailable`);
                    err.statusCode = 400;
                    throw err;
                }

                const lineSubtotal =
                    menuItem.price * item.quantity;

                const lineTax =
                    (lineSubtotal * menuItem.tax) / 100;

                const lineTotal =
                    lineSubtotal + lineTax;

                subtotal += lineSubtotal;
                taxAmount += lineTax;

                orderItems.push({
                    menuItemId: menuItem.id,
                    quantity: item.quantity,
                    price: menuItem.price,
                    tax: lineTax,
                    total: lineTotal,
                    notes: item.notes || null
                });
            }
            const discountTypeValue = req.body.discountType || null;

            const discountValueAmount = Number(req.body.discountValue || 0);

            let calculatedDiscount = 0;

            if (discountTypeValue === "FLAT") {

                calculatedDiscount = discountValueAmount;

            } else if (discountTypeValue === "PERCENTAGE") {

                calculatedDiscount = (subtotal * discountValueAmount) / 100;

            }

            if (calculatedDiscount > subtotal) {

                calculatedDiscount = subtotal;

            }

            const totalAmount =
                subtotal -
                calculatedDiscount +
                serviceCharge +
                taxAmount;
            let selectedCustomerId = customerId;

            if (!selectedCustomerId) {

                const walkInCustomer = await tx.customer.findFirst({

                    where: {
                        restaurantId: req.user.restaurantId,
                        type: "WALK_IN"

                    }

                });

                if (walkInCustomer) {
                    selectedCustomerId = walkInCustomer.id;
                } else {
                    // Auto-create Walk-in Customer if missing
                    const newWalkIn = await tx.customer.create({
                        data: {
                            restaurantId: req.user.restaurantId,
                            name: "Walk-in Customer",
                            type: "WALK_IN"
                        }
                    });
                    selectedCustomerId = newWalkIn.id;
                }

            }
            const createdOrder = await tx.order.create({

                data: {
                    restaurantId: req.user.restaurantId,
                    orderNo: await generateOrderNumber(),

                    orderType,

                    tableId,

                    customerId: selectedCustomerId,

                    subtotal,

                    discount: calculatedDiscount,

                    discountType,

                    discountValue: discountValueAmount,

                    serviceCharge,

                    taxAmount,

                    totalAmount,

                    notes

                }
            });

            // ── Mark table as OCCUPIED if table is assigned (skip for COUNTER_SALE) ──
            if (tableId && orderType !== "COUNTER_SALE") {
              await tx.restaurantTable.update({
                where: { id: Number(tableId) },
                data: { status: "OCCUPIED" }
              });
            }
            await createNotification({

                restaurantId: req.user.restaurantId,

                userId: req.user.id,

                title: "New Order",

                message: `Order ${createdOrder.orderNo} created successfully.`,

                type: "INFO"

            });


            for (const item of orderItems) {
                await tx.orderItem.create({
                    data: {
                        orderId: createdOrder.id,
                        ...item
                    }
                });
            }

            // ── Reserve item stock immediately when the order is placed ──
            // (all order types: DINE_IN, TAKEAWAY, DELIVERY, COUNTER_SALE).
            // Errors propagate → the whole transaction rolls back, so an order can
            // never be created without its stock being reserved. Idempotent: the
            // stockDeductedAt claim ensures a retry never double-deducts.
            await deductStockForOrderCreation(
                tx,
                { id: createdOrder.id, orderNo: createdOrder.orderNo, orderItems },
                req.user.restaurantId,
                req.user.id
            );

            // ── Auto-create KOT for kitchen-based orders (skip for COUNTER_SALE) ──
            if (orderType !== "COUNTER_SALE" && (orderType === "DINE_IN" || orderType === "TAKEAWAY")) {
                try {
                    await tx.kOT.create({
                        data: {
                            restaurantId: req.user.restaurantId,
                            kotNo: await generateKOTNumber(),
                            orderId: createdOrder.id,
                            status: "PENDING",
                            notes: notes || null
                        }
                    });
                } catch (kotErr) {
                    console.error("KOT creation error:", kotErr.message);
                    // Don't fail the order if KOT creation fails
                }
            }

            return await tx.order.findUnique({
                where: {
                    id: createdOrder.id
                },
                include: {
                    table: true,
                    customer: true,
                    kot: {
                        select: {
                            id: true,
                            kotNo: true,
                            status: true
                        }
                    },
                    orderItems: {
                        include: {
                            menuItem: true
                        }
                    }
                }
            });

        });

        // ── Emit real-time event ──
        try {
            emitOrderEvent(req.user.restaurantId, "created", order);
        } catch (sockErr) {
            console.error("Socket emit error:", sockErr.message);
        }

        return successResponse(
            res,
            order,
            "Order Created Successfully",
            201
        );

    } catch (error) {

        console.error(error);

        return errorResponse(
            res,
            error.message,
            error.statusCode || 500
        );

    }
};

const getOrders = async (req, res) => {

    try {

        if (!req.user.restaurantId) {
            return successResponse(
                res,
                [],
                "Orders fetched successfully"
            );
        }

        const orders =
            await prisma.order.findMany({

                where: {
                    restaurantId: req.user.restaurantId,
                    isDeleted: false
                },

                include: {

                    customer: true,

                    table: true,

                    orderItems: {

                        include: {

                            menuItem: true

                        }

                    }

                },

                orderBy: {

                    createdAt: "desc"

                }

            });

        return successResponse(
            res,
            orders,
            "Orders fetched successfully"
        );

    } catch (error) {

        return errorResponse(
            res,
            error.message
        );

    }

};

/// Get only active (non-completed, non-cancelled) orders for Active Orders screen
const getActiveOrders = async (req, res) => {
    try {
        if (!req.user.restaurantId) {
            return successResponse(res, [], "Active orders fetched");
        }

        const orders = await prisma.order.findMany({
            where: {
                restaurantId: req.user.restaurantId,
                isDeleted: false,
                status: {
                    notIn: ["COMPLETED", "CANCELLED"]
                },
                // COUNTER_SALE orders are quick-billing only; never show in Active Orders
                orderType: {
                    not: "COUNTER_SALE"
                }
            },
            include: {
                customer: true,
                table: true,
                orderItems: {
                    include: {
                        menuItem: true
                    }
                },
                kot: {
                    select: {
                        id: true,
                        kotNo: true,
                        status: true
                    }
                }
            },
            orderBy: {
                createdAt: "desc"
            }
        });

        return successResponse(res, orders, "Active orders fetched successfully");

    } catch (error) {
        return errorResponse(res, error.message);
    }
};

const getOrderById = async (req, res) => {

    try {

        const order =
            await prisma.order.findFirst({

                where: {

                    id: Number(req.params.id),
                    restaurantId: req.user.restaurantId,
                    isDeleted: false

                },

                include: {

                    customer: true,

                    table: true,

                    kot: {
                        select: {
                            id: true,
                            kotNo: true,
                            status: true
                        }
                    },

                    orderItems: {

                        include: {

                            menuItem: true

                        }

                    }

                }

            });

        if (!order) {
            return errorResponse(
                res,
                "Order not found",
                404
            );
        }

        return successResponse(
            res,
            order,
            "Order details"
        );

    } catch (error) {

        return errorResponse(
            res,
            error.message
        );

    }

};

const updateOrderStatus = async (req, res) => {

    try {

        const { status } = req.body;

        const order = await prisma.order.findFirst({
            where: {
                id: Number(req.params.id),
                restaurantId: req.user.restaurantId
            },
            include: { orderItems: true }
        });

        if (!order) {
            return errorResponse(res, "Order not found", 404);
        }

        if (order.status === "CANCELLED") {
            return errorResponse(res, "Cannot update a cancelled order", 400);
        }

        let resultOrder;
        if (status === "CANCELLED") {
            // Cancelling via status update must also restore reserved stock (idempotent)
            resultOrder = await prisma.$transaction(async (tx) => {
                const updated = await tx.order.update({
                    where: { id: order.id },
                    data: { status, cancelledAt: new Date() }
                });
                await restoreStockForCancelledOrder(
                    tx,
                    { id: order.id, orderNo: order.orderNo, orderItems: order.orderItems },
                    req.user.restaurantId,
                    req.user.id
                );
                return updated;
            });
        } else {
            resultOrder = await prisma.order.update({
                where: { id: order.id },
                data: { status }
            });
        }
        try {
            emitOrderEvent(req.user.restaurantId, "updated", resultOrder);
        } catch (sockErr) {}
        return successResponse(
            res,
            resultOrder,
            "Order status updated"
        );

    } catch (error) {

        return errorResponse(
            res,
            error.message
        );

    }

};
const cancelOrder = async (req, res) => {

    try {

        const { reason } = req.body;

        const existingOrder = await prisma.order.findFirst({

            where: {

                id: Number(req.params.id),
                restaurantId: req.user.restaurantId

            },
            include: { orderItems: true }

        });

        if (!existingOrder) {

            return errorResponse(

                res,

                "Order not found",

                404

            );

        }

        if (existingOrder.status === "COMPLETED") {

            return errorResponse(

                res,

                "Completed order cannot be cancelled",

                400

            );

        }

        if (existingOrder.status === "CANCELLED") {

            return errorResponse(

                res,

                "Order already cancelled",

                400

            );

        }

        const order = await prisma.$transaction(async (tx) => {

            // Atomic status claim: exactly one concurrent cancel can flip the status,
            // so the paired stock-restore also runs exactly once.
            const claim = await tx.order.updateMany({
                where: {
                    id: Number(req.params.id),
                    status: { notIn: ["COMPLETED", "CANCELLED"] }
                },
                data: {
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelReason: reason
                }
            });
            if (claim.count === 0) {
                throw new Error("Order is already completed or cancelled");
            }

            // Restore reserved stock back to inventory (idempotent — exactly once)
            await restoreStockForCancelledOrder(
                tx,
                { id: existingOrder.id, orderNo: existingOrder.orderNo, orderItems: existingOrder.orderItems },
                req.user.restaurantId,
                req.user.id
            );

            if (existingOrder.tableId) {

                await tx.restaurantTable.update({

                    where: {

                        id: existingOrder.tableId

                    },

                    data: {

                        status: "AVAILABLE"

                    }

                });

            }

            // Return the actual updated order (the claim only carries a count)
            return tx.order.findUnique({ where: { id: existingOrder.id } });
        });

        try {
            emitOrderEvent(req.user.restaurantId, "cancelled", order);
        } catch (sockErr) {}

        return successResponse(

            res,

            order,

            "Order cancelled successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const holdOrder = async (req, res) => {

    try {

        const order = await prisma.order.findFirst({

            where: {
                id: Number(req.params.id),
                restaurantId: req.user.restaurantId
            }

        });

        if (!order) {

            return errorResponse(
                res,
                "Order not found",
                404
            );

        }        if (order.status === "COMPLETED") {

            return errorResponse(

                res,

                "Completed order cannot be placed on hold",

                400

            );

        }

        if (order.status === "CANCELLED") {

            return errorResponse(

                res,

                "Cancelled order cannot be placed on hold",

                400

            );

        }

        if (order.status === "HOLD") {

            return errorResponse(

                res,

                "Order is already on hold",

                400

            );

        }

        const updatedOrder = await prisma.order.update({

            where: {
                id: Number(req.params.id)
            },

            data: {

                status: "HOLD",

                holdAt: new Date()

            }

        });

        try {
            emitOrderEvent(req.user.restaurantId, "updated", updatedOrder);
        } catch (sockErr) {}
        return successResponse(
            res,
            updatedOrder,
            "Order placed on hold"
        );

    } catch (error) {

        return errorResponse(
            res,
            error.message
        );

    }

};
const resumeOrder = async (req, res) => {

    try {

        const order = await prisma.order.findFirst({

            where: {

                id: Number(req.params.id),
                restaurantId: req.user.restaurantId

            }

        });

        if (!order) {

            return errorResponse(

                res,

                "Order not found",

                404

            );

        }

        if (order.status !== "HOLD") {

            return errorResponse(

                res,

                "Only held orders can be resumed",

                400

            );

        }

        const updatedOrder = await prisma.order.update({

            where: {

                id: Number(req.params.id)

            },

            data: {

                status: "PENDING",

                holdAt: null

            }

        });

        try {
            emitOrderEvent(req.user.restaurantId, "updated", updatedOrder);
        } catch (sockErr) {}
        return successResponse(

            res,

            updatedOrder,

            "Order resumed successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

const changeTable = async (req, res) => {

    try {

        const { tableId } = req.body;

        const order = await prisma.order.findFirst({

            where: {

                id: Number(req.params.id),
                restaurantId: req.user.restaurantId

            }

        });

        if (!order) {

            return errorResponse(

                res,

                "Order not found",

                404

            );

        }

        if (order.status === "CANCELLED") {
            return errorResponse(res, "Cannot transfer a cancelled order", 400);
        }

        if (!order.tableId) {

            return errorResponse(

                res,

                "Order has no assigned table"

            );

        }

        const newTable = await prisma.restaurantTable.findFirst({
            where: {
                id: Number(tableId),
                restaurantId: req.user.restaurantId
            }
        });

        if (!newTable) {

            return errorResponse(

                res,

                "New table not found"

            );

        }

        if (newTable.status !== "AVAILABLE") {

            return errorResponse(

                res,

                "Selected table is not available"

            );

        }

        await prisma.$transaction(async (tx) => {

            await tx.restaurantTable.update({

                where: {

                    id: order.tableId

                },

                data: {

                    status: "AVAILABLE"

                }

            });

            await tx.restaurantTable.update({

                where: {

                    id: Number(tableId)

                },

                data: {

                    status: "OCCUPIED"

                }

            });

            await tx.order.update({

                where: {

                    id: Number(req.params.id)

                },

                data: {

                    tableId: Number(tableId)

                }

            });

        });

        const updatedOrder = await prisma.order.findFirst({

            where: {

                id: order.id,

                restaurantId: req.user.restaurantId

            },

            include: {

                table: true,

                orderItems: {

                    include: {

                        menuItem: true

                    }

                }

            }

        });
        return successResponse(

            res,

            updatedOrder,

            "Table changed successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const updateOrder = async (req, res) => {

    try {

        const {

            discountType,
            discount = 0,

            serviceCharge = 0,

            notes,

            items

        } = req.body;

        const order = await prisma.order.findFirst({

            where: {

                id: Number(req.params.id),
                restaurantId: req.user.restaurantId


            },
            include: { orderItems: true }

        });

        if (!order) {

            return errorResponse(

                res,

                "Order not found",

                404

            );

        }

        if (

            !["PENDING", "HOLD"].includes(order.status)

        ) {

            return errorResponse(

                res,

                "Order cannot be edited"

            );

        }

        // Snapshot current reserved quantities so we can reconcile the stock delta
        const oldQtyByItem = {};
        for (const oi of order.orderItems) {
            oldQtyByItem[oi.menuItemId] = (oldQtyByItem[oi.menuItemId] || 0) + oi.quantity;
        }

        let subtotal = 0;

        let taxAmount = 0;

        const orderItems = [];

        for (const item of items) {

            const menuItem = await prisma.menuItem.findFirst({

                where: {

                    id: Number(item.menuItemId),
                    restaurantId: req.user.restaurantId

                }

            });

            if (!menuItem) {

                return errorResponse(

                    res,

                    `Menu Item ${item.menuItemId} not found`

                );

            }

            const lineSubtotal =

                menuItem.price * item.quantity;

            const lineTax =

                (lineSubtotal * menuItem.tax) / 100;

            subtotal += lineSubtotal;

            taxAmount += lineTax;

            orderItems.push({

                menuItemId: menuItem.id,

                quantity: item.quantity,

                price: menuItem.price,

                tax: lineTax,

                total: lineSubtotal + lineTax,

                notes: item.notes || null

            });

        }

        const discountTypeValue = req.body.discountType || null;

        const discountValueAmount = Number(req.body.discountValue || 0);

        let calculatedDiscount = 0;

        if (discountTypeValue === "FLAT") {

            calculatedDiscount = discountValueAmount;

        } else if (discountTypeValue === "PERCENTAGE") {

            calculatedDiscount = (subtotal * discountValueAmount) / 100;

        }

        if (calculatedDiscount > subtotal) {

            calculatedDiscount = subtotal;

        }
        const totalAmount =

            subtotal -
            calculatedDiscount +
            serviceCharge +
            taxAmount;

        await prisma.$transaction(async (tx) => {

            await tx.order.update({

                where: {

                    id: order.id

                },

                data: {

                    subtotal,

                    discount: calculatedDiscount,
                    discountType,

                    discountValue: discountValueAmount,


                    serviceCharge,

                    taxAmount,

                    totalAmount,

                    notes

                }

            });

            await tx.orderItem.deleteMany({

                where: {

                    orderId: order.id

                }

            });

            await tx.orderItem.createMany({

                data: orderItems.map(i => ({

                    ...i,

                    orderId: order.id

                }))

            });

            // Reconcile stock: compare old vs new quantities per item.
            // Positive delta = restore, negative delta = deduct more.
            const newQtyByItem = {};
            for (const oi of orderItems) {
                newQtyByItem[oi.menuItemId] = (newQtyByItem[oi.menuItemId] || 0) + oi.quantity;
            }
            const deltas = [];
            const allItemIds = new Set([
                ...Object.keys(oldQtyByItem).map(Number),
                ...Object.keys(newQtyByItem).map(Number)
            ]);
            for (const menuItemId of allItemIds) {
                const delta = (oldQtyByItem[menuItemId] || 0) - (newQtyByItem[menuItemId] || 0);
                if (delta !== 0) deltas.push({ menuItemId, delta });
            }
            await adjustStockForOrderChange(
                tx,
                { id: order.id, orderNo: order.orderNo },
                deltas,
                req.user.restaurantId,
                req.user.id
            );

        });

        const updatedOrder = await prisma.order.findUnique({

            where: {

                id: order.id

            },

            include: {

                table: true,

                orderItems: {

                    include: {

                        menuItem: true

                    }

                }

            }

        });

        return successResponse(

            res,

            updatedOrder,

            "Order updated successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const addOrderItem = async (req, res) => {

    try {

        const orderId = Number(req.params.id);

        const {

            menuItemId,

            quantity,

            notes

        } = req.body;

        const order = await prisma.order.findFirst({

            where: {

                id: orderId,
                restaurantId: req.user.restaurantId

            },

            include: {

                bill: true

            }

        });

        if (!order) {

            return errorResponse(

                res,

                "Order not found",

                404

            );

        }

        if (order.status === "CANCELLED") {
            return errorResponse(res, "Cannot add items to a cancelled order", 400);
        }

        if (order.bill) {

            return errorResponse(

                res,

                "Cannot modify order after bill generation"

            );

        }

        if (order.status === "CANCELLED") {
            return errorResponse(res, "Cannot modify a cancelled order", 400);
        }

        const menuItem = await prisma.menuItem.findFirst({

            where: {

                id: Number(menuItemId),
                restaurantId: req.user.restaurantId

            }

        });

        if (!menuItem) {

            return errorResponse(

                res,

                "Menu item not found",

                404

            );

        }

        if (!menuItem.isAvailable) {

            return errorResponse(

                res,

                "Menu item is unavailable"

            );

        }

        const subtotal =

            menuItem.price * quantity;

        const tax =

            (subtotal * menuItem.tax) / 100;

        const total =

            subtotal + tax;

        const orderItem = await prisma.$transaction(async (tx) => {

            const created = await tx.orderItem.create({

                data: {

                    orderId,

                    menuItemId,

                    quantity,

                    price: menuItem.price,

                    tax,

                    total,

                    notes

                }

            });

            // Deduct stock ONLY for the newly added quantity (type ORDER_UPDATED)
            await deductStockForAddedItems(
                tx,
                { id: order.id, orderNo: order.orderNo },
                [{ menuItemId, quantity }],
                req.user.restaurantId,
                req.user.id
            );

            return created;

        });

        await recalculateOrder(req.user.restaurantId, orderId);

        const updatedOrder = await prisma.order.findFirst({

            where: {

                id: orderId,

                restaurantId: req.user.restaurantId

            },

            include: {

                customer: true,

                table: true,

                orderItems: {

                    include: {

                        menuItem: true

                    }

                }

            }

        });
        return successResponse(

            res,

            updatedOrder,

            "Item added successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const updateOrderItem = async (req, res) => {

    try {

        const orderId = Number(req.params.orderId);

        const itemId = Number(req.params.itemId);

        const {

            quantity,

            notes

        } = req.body;

        const order = await prisma.order.findFirst({

            where: {

                id: orderId,
                restaurantId: req.user.restaurantId

            },

            include: {

                bill: true

            }

        });

        if (!order) {

            return errorResponse(

                res,

                "Order not found",

                404

            );

        }

        if (order.status === "CANCELLED") {
            return errorResponse(res, "Cannot modify a cancelled order", 400);
        }

        if (order.bill) {

            return errorResponse(

                res,

                "Cannot modify order after bill generation"

            );

        }

        const orderItem = await prisma.orderItem.findFirst({
            where: {
                id: itemId,
                orderId: order.id
            },
            include: {
                menuItem: true
            }
        });

        if (!orderItem) {

            return errorResponse(

                res,

                "Order item not found",

                404

            );

        }

        const subtotal =

            orderItem.menuItem.price * quantity;

        const tax =

            (subtotal * orderItem.menuItem.tax) / 100;

        const total =

            subtotal + tax;

        await prisma.$transaction(async (tx) => {

            await tx.orderItem.update({

                where: {

                    id: itemId

                },

                data: {

                    quantity,

                    tax,

                    total,

                    notes

                }

            });

            // Adjust reserved stock by the quantity delta (ORDER_UPDATED)
            const delta = orderItem.quantity - Number(quantity);
            if (delta !== 0) {
                await adjustStockForOrderChange(
                    tx,
                    { id: order.id, orderNo: order.orderNo },
                    [{ menuItemId: orderItem.menuItemId, delta }],
                    req.user.restaurantId,
                    req.user.id
                );
            }

        });

        await recalculateOrder(req.user.restaurantId, orderId);

        const updatedOrder = await prisma.order.findFirst({

            where: {

                id: orderId,

                restaurantId: req.user.restaurantId

            },

            include: {

                customer: true,

                table: true,

                orderItems: {

                    include: {

                        menuItem: true

                    }

                }

            }

        });
        return successResponse(

            res,

            updatedOrder,

            "Order item updated successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const deleteOrderItem = async (req, res) => {

    try {

        const orderId = Number(req.params.orderId);

        const itemId = Number(req.params.itemId);

        const order = await prisma.order.findFirst({

            where: {

                id: orderId,
                restaurantId: req.user.restaurantId

            },

            include: {

                bill: true

            }

        });

        if (!order) {

            return errorResponse(

                res,

                "Order not found",

                404

            );

        }

        if (order.status === "CANCELLED") {
            return errorResponse(res, "Cannot modify a cancelled order", 400);
        }

        if (order.bill) {

            return errorResponse(

                res,

                "Cannot modify order after bill generation"

            );

        }

        const orderItem = await prisma.orderItem.findFirst({

            where: {

                id: itemId,

                orderId

            }

        });

        if (!orderItem) {

            return errorResponse(

                res,

                "Order item not found",

                404

            );

        }

        const totalItems = await prisma.orderItem.count({

            where: {

                orderId

            }

        });

        if (totalItems === 1) {

            return errorResponse(

                res,

                "Order must contain at least one item"

            );

        }

        await prisma.$transaction(async (tx) => {

            await tx.orderItem.delete({

                where: {

                    id: itemId

                }

            });

            // Restore the removed item's reserved quantity back to stock (ORDER_UPDATED)
            await adjustStockForOrderChange(
                tx,
                { id: order.id, orderNo: order.orderNo },
                [{ menuItemId: orderItem.menuItemId, delta: orderItem.quantity }],
                req.user.restaurantId,
                req.user.id
            );

        });

        await recalculateOrder(req.user.restaurantId, orderId);

        const updatedOrder = await prisma.order.findFirst({

            where: {

                id: orderId,

                restaurantId: req.user.restaurantId

            },

            include: {

                customer: true,

                table: true,

                orderItems: {

                    include: {

                        menuItem: true

                    }

                }

            }

        });
        return successResponse(

            res,

            updatedOrder,

            "Order item deleted successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const updateDiscount = async (req, res) => {

    try {

        const {

            discountType,

            discountValue

        } = req.body;

        const order = await prisma.order.findFirst({

            where: {

                id: Number(req.params.id),
                restaurantId: req.user.restaurantId

            }

        });

        if (!order) {

            return errorResponse(

                res,

                "Order not found",

                404

            );

        }

        if (order.status === "CANCELLED") {
            return errorResponse(res, "Cannot update discount on a cancelled order", 400);
        }

        let discount = 0;

        if (discountType === "FLAT") {

            discount = discountValue;

        } else if (discountType === "PERCENTAGE") {

            discount =

                (order.subtotal * discountValue) / 100;

        }

        if (discount > order.subtotal) {

            discount = order.subtotal;

        }

        const totalAmount =

            order.subtotal -

            discount +

            order.taxAmount +

            order.serviceCharge;

        const updatedOrder = await prisma.order.update({

            where: {

                id: order.id

            },

            data: {

                discount,

                discountType,

                discountValue,

                totalAmount

            }

        });

        // Update bill if already generated
        const bill = await prisma.bill.findFirst({

            where: {

                orderId: order.id

            }

        });

        if (bill) {

            await prisma.bill.update({

                where: {

                    id: bill.id

                },

                data: {

                    discount,

                    grandTotal: totalAmount

                }

            });

        }

        return successResponse(

            res,

            updatedOrder,

            "Discount updated successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const deleteOrder = async (req, res) => {

    try {        const order = await prisma.order.findFirst({
            where: {
                id: Number(req.params.id),
                restaurantId: req.user.restaurantId
            },
            include: { orderItems: true }
        });

        if (!order) {
            return errorResponse(res, "Order not found", 404);
        }

        if (order.isDeleted) {
            return errorResponse(res, "Order already deleted", 400);
        }

        await prisma.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: Number(req.params.id) },
                data: { isDeleted: true, deletedAt: new Date() }
            });

            // A permanently deleted order restores its reserved stock (idempotent)
            await restoreStockForCancelledOrder(
                tx,
                { id: order.id, orderNo: order.orderNo, orderItems: order.orderItems },
                req.user.restaurantId,
                req.user.id
            );

            if (order.tableId) {
                await tx.restaurantTable.update({
                    where: { id: order.tableId },
                    data: { status: "AVAILABLE" }
                });
            }
        });
        try {
            emitOrderEvent(req.user.restaurantId, "deleted", { id: Number(req.params.id) });
        } catch (sockErr) {}
        return successResponse(
            res,
            null,
            "Order deleted successfully"
        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

// ── Merge Orders ──
const mergeOrders = async (req, res) => {
    try {
        const sourceOrderId = Number(req.params.id);
        const { targetOrderId } = req.body;

        if (!targetOrderId) {
            return errorResponse(res, "Target order ID is required", 400);
        }

        const sourceOrder = await prisma.order.findFirst({
            where: { id: sourceOrderId, restaurantId: req.user.restaurantId },
            include: { orderItems: true, bill: true }
        });

        if (!sourceOrder) {
            return errorResponse(res, "Source order not found", 404);
        }

        if (sourceOrder.bill) {
            return errorResponse(res, "Cannot merge order after bill generation", 400);
        }

        const targetOrder = await prisma.order.findFirst({
            where: { id: Number(targetOrderId), restaurantId: req.user.restaurantId },
            include: { bill: true }
        });

        if (!targetOrder) {
            return errorResponse(res, "Target order not found", 404);
        }

        if (targetOrder.bill) {
            return errorResponse(res, "Cannot merge into order with existing bill", 400);
        }

        if (sourceOrder.status === "COMPLETED" || sourceOrder.status === "CANCELLED") {
            return errorResponse(res, "Source order is already completed or cancelled", 400);
        }

        if (targetOrder.status === "COMPLETED" || targetOrder.status === "CANCELLED") {
            return errorResponse(res, "Target order is already completed or cancelled", 400);
        }

        await prisma.$transaction(async (tx) => {
            // Move all items from source to target
            for (const item of sourceOrder.orderItems) {
                await tx.orderItem.create({
                    data: {
                        orderId: Number(targetOrderId),
                        menuItemId: item.menuItemId,
                        quantity: item.quantity,
                        price: item.price,
                        tax: item.tax,
                        total: item.total,
                        notes: item.notes
                    }
                });
            }

            // Cancel source order
            await tx.order.update({
                where: { id: sourceOrderId },
                data: {
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelReason: "Merged into order " + targetOrder.orderNo
                }
            });

            // Recalculate target order
            const updatedTarget = await tx.order.findUnique({
                where: { id: Number(targetOrderId) },
                include: { orderItems: true }
            });

            let newSubtotal = 0;
            let newTaxAmount = 0;
            for (const item of updatedTarget.orderItems) {
                newSubtotal += item.price * item.quantity;
                newTaxAmount += item.tax;
            }

            let discount = 0;
            if (updatedTarget.discountType === "FLAT") {
                discount = updatedTarget.discountValue;
            } else if (updatedTarget.discountType === "PERCENTAGE") {
                discount = (newSubtotal * updatedTarget.discountValue) / 100;
            }
            if (discount > newSubtotal) discount = newSubtotal;

            const newTotal = newSubtotal - discount + newTaxAmount + updatedTarget.serviceCharge;

            await tx.order.update({
                where: { id: Number(targetOrderId) },
                data: {
                    subtotal: newSubtotal,
                    taxAmount: newTaxAmount,
                    discount,
                    totalAmount: newTotal
                }
            });

            // Update KOT if exists
            const targetKot = await tx.kOT.findFirst({
                where: { orderId: Number(targetOrderId) }
            });
            if (targetKot) {
                await tx.kOT.update({
                    where: { id: targetKot.id },
                    data: { notes: (targetKot.notes || "") + " [Merged: " + sourceOrder.orderNo + "]" }
                });
            }

            // Release source table if applicable
            if (sourceOrder.tableId) {
                await tx.restaurantTable.update({
                    where: { id: sourceOrder.tableId },
                    data: { status: "AVAILABLE" }
                });
            }
        });

        const updatedTargetOrder = await prisma.order.findUnique({
            where: { id: Number(targetOrderId) },
            include: {
                table: true,
                customer: true,
                orderItems: { include: { menuItem: true } }
            }
        });

        try {
            emitOrderEvent(req.user.restaurantId, "merged", {
                sourceOrderId, targetOrderId,
                sourceNo: sourceOrder.orderNo
            });
        } catch (sockErr) {}

        return successResponse(res, updatedTargetOrder, "Orders merged successfully");

    } catch (error) {
        console.error("mergeOrders error:", error);
        return errorResponse(res, error.message);
    }
};

// ── Update Order Notes (uses existing `notes` field with JSON to store multiple note types) ──
const updateOrderNotes = async (req, res) => {
    try {
        const orderId = Number(req.params.id);
        // Frontend sends { kitchenNote, customerNote, billNote } directly at top level of req.body
        const { kitchenNote, customerNote, billNote } = req.body;

        const order = await prisma.order.findFirst({
            where: { id: orderId, restaurantId: req.user.restaurantId }
        });

        if (!order) {
            return errorResponse(res, "Order not found", 404);
        }

        // Store notes as JSON string: { kitchenNote, customerNote, billNote }
        let existingNotes = {};
        try { existingNotes = order.notes ? JSON.parse(order.notes) : {}; } catch {}

        const mergedNotes = { ...existingNotes, kitchenNote, customerNote, billNote };

        const updatedOrder = await prisma.order.update({
            where: { id: order.id },
            data: { notes: JSON.stringify(mergedNotes) }
        });

        return successResponse(res, updatedOrder, "Order notes updated");

    } catch (error) {
        return errorResponse(res, error.message);
    }
};

module.exports = {

    createOrder,

    getOrders,
    getActiveOrders,

    getOrderById,
    updateOrder,
    addOrderItem,
    updateOrderItem,
    deleteOrderItem,
    updateOrderStatus,
    updateDiscount,
    cancelOrder,
    holdOrder,
    resumeOrder,
    changeTable,
    deleteOrder,
    mergeOrders,
    updateOrderNotes
};