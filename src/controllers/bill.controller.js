const prisma = require("../config/prisma");
const {
    generateBillNumber
} = require("../utils/numberGenerator");
const {
    successResponse,
    errorResponse
} = require("../utils/response");
const {
    createNotification
} = require("../services/notification.service");
const {
    calculateDiscountAmount
} = require("../utils/discount");

// ─── Audit helper ───
const createAuditLogEntry = async (data) => {
  try {
    const { createAuditLog } = require("../services/audit.service");
    await createAuditLog(data);
  } catch (err) {
    console.error("Audit log error:", err.message);
  }
};

const createBill = async (req, res) => {

    try {

        const {
            orderId,
            discount,
            discountType,
            discountValue,
            discountReason,
            serviceCharge = 0,
            roundOff = 0
        } = req.body;

        const order = await prisma.order.findFirst({

            where: {

                id: Number(orderId),

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

        const existingBill = await prisma.bill.findFirst({

            where: {
                orderId: Number(orderId),
                isCancelled: false
            }

        });

        if (existingBill) {
            return errorResponse(
                res,
                "An active bill already exists for this order",
                400
            );
        }

        if (order.status === "CANCELLED") {
            return errorResponse(res, "Cannot bill a cancelled order", 400);
        }

        if (order.status !== "COMPLETED") {
            return errorResponse(
                res,
                "Only completed orders can be billed",
                400
            );
        }

        // Discount resolution: if the request explicitly provides discount data it
        // wins; otherwise inherit the order's already-applied discount so the bill
        // always matches what the customer is charged (never silently drops it).
        const effectiveDiscountType = discountType !== undefined
            ? discountType
            : (order.discountType || null);
        const effectiveDiscountValue = discountValue !== undefined
            ? discountValue
            : (order.discountValue || 0);
        const effectiveDiscountReason = discountReason !== undefined
            ? discountReason
            : (order.cancelReason && order.discountType ? order.cancelReason : null);

        // Calculate discount amount if discountType/discountValue provided.
        // Legacy flat `discount` is clamped to the subtotal so a bill can
        // never go negative — payable is always >= 0.
        const discountAmount = effectiveDiscountType
            ? calculateDiscountAmount(effectiveDiscountType, effectiveDiscountValue, order.subtotal)
            : Math.min(
                Math.max(0, discount !== undefined ? Number(discount) : (order.discount || 0)),
                order.subtotal || 0
              );

        const grandTotal = Math.max(
            0,
            (order.subtotal || 0) -
            discountAmount +
            (serviceCharge || 0) +
            (order.taxAmount || 0) +
            (roundOff || 0)
        );

        // Bill.orderId is unique — two concurrent bill requests for the same
        // order race past the existingBill check above; the unique constraint
        // is the final guard. P2002 → clean 400, never a 500 or duplicate bill.
        let bill;
        try {
            bill = await prisma.bill.create({
                data: {
                    restaurantId: req.user.restaurantId,
                    billNo: await generateBillNumber(),
                    orderId,
                    subtotal: order.subtotal,
                    discount: discountAmount,
                    discountType: effectiveDiscountType,
                    discountValue: effectiveDiscountType ? effectiveDiscountValue : 0,
                    discountReason: effectiveDiscountReason || null,
                    discountedBy: effectiveDiscountType ? req.user.id : null,
                    discountedAt: effectiveDiscountType ? new Date() : null,
                    serviceCharge,
                    taxAmount: order.taxAmount,
                    roundOff,
                    grandTotal
                }
            });
        } catch (err) {
            if (err && err.code === "P2002") {
                return errorResponse(
                    res,
                    "An active bill already exists for this order",
                    400
                );
            }
            throw err;
        }

        await createNotification({
            restaurantId: req.user.restaurantId,
            userId: req.user.id,
            title: "Bill Generated",
            message: `Bill ${bill.billNo} generated.`,
            type: "SUCCESS"
        });

        return successResponse(
            res,
            bill,
            "Bill Generated",
            201
        );

    }

    catch (error) {

        return errorResponse(
            res,
            error.message
        );

    }

};
const updateBillDiscount = async (req, res) => {
  try {
    const billId = Number(req.params.id);
    const { discountType, discountValue, discountReason } = req.body;

    const bill = await prisma.bill.findFirst({
      where: { id: billId, restaurantId: req.user.restaurantId }
    });

    if (!bill) {
      return errorResponse(res, "Bill not found", 404);
    }

    if (bill.status === "PAID") {
      return errorResponse(res, "Cannot modify discount on a paid bill", 400);
    }

    if (bill.paymentStatus === "PAID") {
      return errorResponse(res, "Cannot modify discount on a paid bill", 400);
    }

    if (bill.isCancelled) {
      return errorResponse(res, "Cannot modify discount on a cancelled bill", 400);
    }

    // Validate discount value
    if (discountType === "PERCENTAGE") {
      if (discountValue < 0 || discountValue > 100) {
        return errorResponse(res, "Percentage discount must be between 0 and 100", 400);
      }
    } else if (discountType === "FLAT") {
      if (discountValue < 0) {
        return errorResponse(res, "Flat discount cannot be negative", 400);
      }
    }

    const subtotal = Number(bill.subtotal || 0);
    const discountAmount = calculateDiscountAmount(discountType, discountValue, subtotal);

    // Recalculate grand total with new discount
    const grandTotal =
      subtotal -
      discountAmount +
      Number(bill.serviceCharge || 0) +
      Number(bill.taxAmount || 0) +
      Number(bill.roundOff || 0);

    const updatedBill = await prisma.bill.update({
      where: { id: bill.id },
      data: {
        discount: discountAmount,
        discountType,
        discountValue,
        discountReason: discountReason || null,
        discountedBy: req.user.id,
        discountedAt: new Date(),
        grandTotal
      }
    });

    // Audit log
    await createAuditLogEntry({
      userId: req.user.id,
      restaurantId: req.user.restaurantId,
      module: "BILL",
      action: "APPLY_DISCOUNT",
      description: `Applied ${discountType === "PERCENTAGE" ? discountValue + "%" : "₹" + discountValue} discount on Bill ${bill.billNo}. Amount: ₹${discountAmount}`,
      referenceId: updatedBill.id,
      referenceNo: updatedBill.billNo,
    });

    return successResponse(res, updatedBill, "Discount applied successfully");
  } catch (error) {
    console.error("updateBillDiscount error:", error);
    return errorResponse(res, error.message);
  }
};

const getBills = async (req, res) => {

    try {

        const {

            status,

            paymentStatus,

            fromDate,

            toDate

        } = req.query;

        const where = {
            restaurantId: req.user.restaurantId,
        };

        if (status) {

            where.status = status;

        }

        if (paymentStatus) {

            where.paymentStatus = paymentStatus;

        }

        if (fromDate || toDate) {

            where.createdAt = {};

            if (fromDate) {

                where.createdAt.gte = new Date(fromDate);

            }

            if (toDate) {

                const endDate = new Date(toDate);
                endDate.setHours(23, 59, 59, 999);

                where.createdAt.lte = endDate;

            }

        }

        const bills = await prisma.bill.findMany({

            where,

            include: {

                order: {

                    include: {

                        table: true

                    }

                }

            },

            orderBy: {

                createdAt: "desc"

            }

        });

        return successResponse(

            res,

            bills,

            "Bills Loaded"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

const getBillById = async (req, res) => {

    try {

        const bill = await prisma.bill.findFirst({

            where: {

                id: Number(req.params.id),

                restaurantId: req.user.restaurantId

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

            return errorResponse(

                res,

                "Bill not found",

                404

            );

        }

        return successResponse(

            res,

            bill,

            "Bill Details"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

const cancelBill = async (req, res) => {

    try {

        const billId = Number(req.params.id);

        const { reason } = req.body;

        const bill = await prisma.bill.findFirst({

            where: {

                id: billId,

                restaurantId: req.user.restaurantId

            },

            include: {

                order: true

            }

        });
        if (!bill) {

            return errorResponse(

                res,

                "Bill not found",

                404

            );

        }

        if (bill.isCancelled) {

            return errorResponse(

                res,

                "Bill already cancelled"

            );

        }

        await prisma.$transaction(async (tx) => {

            await tx.bill.update({

                where: {

                    id: bill.id

                },

                data: {

                    status: "CANCELLED",

                    isCancelled: true,

                    cancelReason: reason,

                    cancelledAt: new Date(),

                    cancelledBy: req.user.id

                }

            });

            await tx.order.update({

                where: {

                    id: bill.orderId

                },

                data: {

                    status: "PENDING"

                }

            });

        });

        return successResponse(

            res,

            null,

            "Bill cancelled successfully"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
module.exports = {

    createBill,
    getBills,
    getBillById,
    cancelBill,
    updateBillDiscount

};