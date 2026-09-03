// tenantDb is available as req.tenantDb (attached by auth middleware)
const {
    generateKOTNumber
} = require("../utils/numberGenerator");
const {
    successResponse,
    errorResponse
} = require("../utils/response");
const {

    createNotification

} = require("../services/notification.service");
const { emitKotEvent } = require("../services/socket");

const createKOT = async (req, res) => {
    const prisma = req.tenantDb;

    try {
        const { orderId, notes } = req.body;
        const order = await prisma.order.findFirst({
            where: {
                id: Number(orderId)
            },
            include: {
                orderItems: true
            }
        });

        if (!order) {
            return errorResponse(res, "Order not found", 404);
        }

        // ── Create KOT + KOTItems + update sentQuantity in a SINGLE transaction ──
        // Delta calculation happens INSIDE the transaction to prevent race conditions:
        // two simultaneous requests cannot both see the same pending items.
        const kot = await prisma.$transaction(async (tx) => {
            // Lock the OrderItem rows for this order to prevent concurrent KOT creation
            const lockedOrderItems = await tx.orderItem.findMany({
                where: { orderId: Number(orderId) },
                orderBy: { id: 'asc' }
            });

            // Load ALL existing KOTItems for these OrderItems (authoritative history)
            const orderItemIds = lockedOrderItems.map(oi => oi.id);
            const existingKOTItems = orderItemIds.length > 0
                ? await tx.kOTItem.findMany({
                    where: {
                        orderItemId: { in: orderItemIds }
                    },
                    select: {
                        orderItemId: true,
                        quantity: true
                    }
                })
                : [];

            // Aggregate sent quantity per orderItemId from KOTItem records
            const sentByOrderItem = new Map();
            for (const ki of existingKOTItems) {
                sentByOrderItem.set(
                    ki.orderItemId,
                    (sentByOrderItem.get(ki.orderItemId) || 0) + ki.quantity
                );
            }

            // Calculate pending quantity for each OrderItem
            const deltaItems = [];
            for (const oi of lockedOrderItems) {
                const historicalKOTQuantity = sentByOrderItem.get(oi.id) || 0;
                const pending = Math.max(0, oi.quantity - historicalKOTQuantity);

                if (pending > 0) {
                    deltaItems.push({
                        orderItem: oi,
                        pendingQty: pending,
                        historicalKOTQuantity
                    });
                }
            }

            if (deltaItems.length === 0) {
                const noItemsErr = new Error("NO_PENDING_ITEMS");
                noItemsErr.isNoPending = true;
                throw noItemsErr;
            }

            const newKot = await tx.kOT.create({
                data: {
                    restaurantId: req.user.restaurantId,
                    kotNo: await generateKOTNumber(tx),
                    orderId,
                    notes,
                    status: "PENDING"
                }
            });

            // Create KOTItem records for each delta item — quantity is ONLY the pending delta
            const kotItemData = deltaItems.map(({ orderItem, pendingQty }) => ({
                kotId: newKot.id,
                orderItemId: orderItem.id,
                menuItemId: orderItem.menuItemId,
                quantity: pendingQty,
                price: orderItem.price,
                notes: orderItem.notes || null
            }));
            await tx.kOTItem.createMany({ data: kotItemData });

            // Update sentQuantity on each affected OrderItem to reflect the new total
            for (const { orderItem, historicalKOTQuantity, pendingQty } of deltaItems) {
                const newSent = historicalKOTQuantity + pendingQty;
                await tx.orderItem.update({
                    where: { id: orderItem.id },
                    data: { sentQuantity: newSent }
                });
            }

            return { kot: newKot, deltaItems };
        });

        // Fetch the created KOT with its items for the response
        const kotWithItems = await prisma.kOT.findFirst({
            where: { id: kot.kot.id },
            include: {
                kotItems: {
                    include: { menuItem: true }
                }
            }
        });

        try {
            await createNotification(prisma, {
                restaurantId: req.user.restaurantId,
                userId: req.user.id,
                title: "KOT Generated",
                message: `KOT ${kot.kot.kotNo} generated with ${kot.deltaItems.length} item(s).`,
                type: "INFO"
            });
        } catch (notifErr) {
            console.error("[KOT] Notification creation failed (non-critical):", notifErr.message);
        }

        try {
            emitKotEvent(req.user.restaurantId, "created", kotWithItems);
        } catch (sockErr) {}

        return successResponse(res, kotWithItems, "KOT Generated", 201);

    } catch (error) {
        // "NO_PENDING_ITEMS" is a normal idempotent state — return 200, not 400.
        // The browser must never log "POST /api/kot 400" for this case.
        if (error.isNoPending) {
            return successResponse(res, { created: false, kot: null, kotItems: [] }, "No new items to send to kitchen.", 200);
        }
        return errorResponse(res, error.message);
    }

};const getKOTList = async (req, res) => {
    const prisma = req.tenantDb;

    try {

        const kots = await prisma.kOT.findMany({
            where: {},

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

                },
                // Include KOTItem records so the Kitchen screen shows only
                // the delta items that belong to THIS specific KOT.
                kotItems: {
                    include: {
                        menuItem: true
                    }
                }

            },

            orderBy: [

                {

                    priority: "desc"

                },

                {

                    createdAt: "asc"

                }

            ]

        });

        return successResponse(
            res,
            kots,
            "Kitchen Queue"
        );

    } catch (error) {

        return errorResponse(
            res,
            error.message
        );

    }

};

const updateKOTStatus = async (req, res) => {
    const prisma = req.tenantDb;

    try {

        const { status } = req.body;        const existing = await prisma.kOT.findFirst({
            where: {
                id: Number(req.params.id)
            }

        });

        if (!existing) {

            return errorResponse(
                res,
                "KOT not found",
                404
            );

        }

        const kot = await prisma.kOT.update({

            where: {

                id: existing.id

            },

            data: {

                status

            }

        });

        try {
            emitKotEvent(req.user.restaurantId, "updated", kot);
        } catch (sockErr) {}
        return successResponse(
            res,
            kot,
            "KOT Updated"
        );

    }

    catch (error) {

        return errorResponse(
            res,
            error.message
        );

    }

};
const updateKOT = async (req, res) => {
    const prisma = req.tenantDb;

    try {

        const { notes, priority } = req.body;        const existing = await prisma.kOT.findFirst({
            where: {
                id: Number(req.params.id)
            }

        });

        if (!existing) {

            return errorResponse(

                res,

                "KOT not found",

                404

            );

        }

        const kot = await prisma.kOT.update({

            where: {

                id: existing.id

            },

            data: {

                notes,

                priority

            }

        });

        return successResponse(

            res,

            kot,

            "KOT Updated Successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};const reprintKOT = async (req, res) => {
    const prisma = req.tenantDb;

    try {
        const existing = await prisma.kOT.findFirst({
            where: {
                id: Number(req.params.id)
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

                },
                kotItems: {
                    include: {
                        menuItem: true
                    }
                }

            }

        });

        if (!existing) {

            return errorResponse(
                res,
                "KOT not found",
                404
            );

        }

        const kot = await prisma.kOT.update({
            where: {
                id: existing.id
            },
            data: {
                printCount: {
                    increment: 1
                },
                lastPrintedAt: new Date()
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

                },
                kotItems: {
                    include: {
                        menuItem: true
                    }
                }

            }

        });

        return successResponse(
            res,
            kot,
            "KOT Ready For Reprint"
        );

    }

    catch (error) {

        return errorResponse(
            res,
            error.message
        );

    }

};
const updatePriority = async (req, res) => {
    const prisma = req.tenantDb;

    try {

        const { priority } = req.body;        const existing = await prisma.kOT.findFirst({
            where: {
                id: Number(req.params.id)
            }

        });

        if (!existing) {

            return errorResponse(

                res,

                "KOT not found",

                404

            );

        }

        const kot = await prisma.kOT.update({

            where: {

                id: existing.id

            },

            data: {

                priority

            }

        });

        return successResponse(

            res,

            kot,

            "Priority updated successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const getKOTHistory = async (req, res) => {
    const prisma = req.tenantDb;

    try {

        const {

            page = 1,

            limit = 20,

            search,

            priority,

            date

        } = req.query;

        const where = {
            restaurantId: req.user.restaurantId
        };

        if (search) {

            where.kotNo = {

                contains: search,

                mode: "insensitive"

            };

        }

        if (priority !== undefined) {

            where.priority = Number(priority);

        }

        if (date) {

            const start = new Date(date);

            const end = new Date(date);

            end.setDate(end.getDate() + 1);

            where.createdAt = {

                gte: start,

                lt: end

            };

        }

        const total = await prisma.kOT.count({

            where

        });        const history = await prisma.kOT.findMany({
            where,
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
                },
                kotItems: {
                    include: {
                        menuItem: true
                    }
                }
            },
            orderBy: {
                createdAt: "desc"
            },
            skip:

                (Number(page) - 1) *
                Number(limit),
            take:
                Number(limit)
        });

        return successResponse(

            res,

            {

                total,

                page: Number(page),

                limit: Number(limit),

                records: history

            },

            "KOT History"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const cancelKOT = async (req, res) => {
    const prisma = req.tenantDb;

    try {

        const { reason } = req.body;

        const kot = await prisma.kOT.findFirst({

            where: {

                id: Number(req.params.id),

                restaurantId: req.user.restaurantId

            },

            include: {

                order: {

                    include: {

                        bill: true

                    }

                }

            }

        });

        if (!kot) {

            return errorResponse(

                res,

                "KOT not found",

                404

            );

        }

        if (kot.cancelledAt) {

            return errorResponse(

                res,

                "KOT already cancelled"

            );

        }

        if (kot.order.bill) {

            return errorResponse(

                res,

                "Cannot cancel KOT after bill generation"

            );

        }

        if (kot.order.status === "COMPLETED") {

            return errorResponse(

                res,

                "Completed order KOT cannot be cancelled"

            );

        }

        const updatedKOT = await prisma.kOT.update({

            where: {

                id: kot.id

            },

            data: {

                cancelledAt: new Date(),

                cancelReason: reason

            }

        });

        try {
            emitKotEvent(req.user.restaurantId, "cancelled", updatedKOT);
        } catch (sockErr) {}
        return successResponse(

            res,

            updatedKOT,

            "KOT cancelled successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

// ─── Cancel KOTs by Order ID ────────────────────────────────────────────────────
const cancelKOTByOrder = async (req, res) => {
    const prisma = req.tenantDb;
    try {
        const { orderId } = req.params;
        const { reason } = req.body;

        // Find all active (non-cancelled) KOTs for this order
        const kots = await prisma.kOT.findMany({
            where: {
                orderId: Number(orderId),
                restaurantId: req.user.restaurantId,
                cancelledAt: null,
            },
        });

        if (kots.length === 0) {
            return successResponse(res, [], "No KOTs to cancel");
        }

        // Cancel all found KOTs
        const kotIds = kots.map(k => k.id);
        await prisma.kOT.updateMany({
            where: { id: { in: kotIds } },
            data: {
                cancelledAt: new Date(),
                cancelReason: reason || "Order cancelled",
            },
        });

        // Emit socket event for each cancelled KOT
        kots.forEach(kot => {
            try {
                emitKotEvent(req.user.restaurantId, "cancelled", {
                    ...kot,
                    cancelledAt: new Date(),
                    cancelReason: reason || "Order cancelled",
                });
            } catch (sockErr) {}
        });

        return successResponse(
            res,
            { cancelled: kots.length },
            `${kots.length} KOT(s) cancelled successfully`
        );
    } catch (error) {
        return errorResponse(res, error.message);
    }
};

// ─── Reprint KOT by Order ID (finds latest KOT for the order) ─────────────────
const reprintKOTByOrder = async (req, res) => {
    const prisma = req.tenantDb;
    try {
        const { orderId } = req.params;

        // Find the latest non-cancelled KOT for this order
        const kot = await prisma.kOT.findFirst({
            where: {
                orderId: Number(orderId),
                restaurantId: req.user.restaurantId,
                cancelledAt: null,
            },
            orderBy: { createdAt: "desc" },
            include: {
                order: {
                    include: {
                        table: true,
                        orderItems: {
                            include: { menuItem: true },
                        },
                    },
                },
                kotItems: {
                    include: { menuItem: true }
                },
            },
        });

        if (!kot) {
            return errorResponse(res, "No KOT found for this order. Please create a KOT first.", 404);
        }

        // Increment print count and update last printed timestamp
        const updatedKot = await prisma.kOT.update({
            where: { id: kot.id },
            data: {
                printCount: { increment: 1 },
                lastPrintedAt: new Date(),
            },
            include: {
                order: {
                    include: {
                        table: true,
                        orderItems: {
                            include: { menuItem: true },
                        },
                    },
                },
                kotItems: {
                    include: { menuItem: true }
                },
            },
        });

        return successResponse(res, updatedKot, "KOT Ready For Reprint");
    } catch (error) {
        return errorResponse(res, error.message);
    }
};

module.exports = {

    createKOT,

    getKOTList,

    updateKOTStatus,
    updateKOT,
    reprintKOT,
    reprintKOTByOrder,
    updatePriority,
    getKOTHistory,
    cancelKOT,
    cancelKOTByOrder

};