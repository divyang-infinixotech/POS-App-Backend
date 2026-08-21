const prisma = require("../config/prisma");
const { randomUUID } = require("crypto");
const { generateBillNumber } = require("../utils/numberGenerator");
const { successResponse, errorResponse } = require("../utils/response");
const { createNotification } = require("../services/notification.service");
const { emitOrderEvent, emitToRestaurant } = require("../services/socket");
const { calculateDiscountAmount } = require("../utils/discount");
// NOTE: Inventory is reserved at ORDER PLACEMENT (see order.controller.js), not at
// payment. Payment must never touch stock — no deductOrderStock calls here.

// ─── Audit helper ───
const createAuditLogEntry = async (data) => {
  try {
    const { createAuditLog } = require("../services/audit.service");
    await createAuditLog(data);
  } catch (err) {
    console.error("Audit log error:", err.message);
  }
};

// ─── Collect Payment (Combined: Bill + Payment + Complete Order + Release Table) ───
const collectPayment = async (req, res) => {
  try {
    const {
      orderId,
      payments,       // [{ paymentMethod, amount, transactionId, notes }]
      discount = 0,
      discountType,
      discountValue = 0,
      discountReason,
      serviceCharge = 0,
      roundOff = 0,
    } = req.body;

    const restaurantId = req.user.restaurantId;

    // Validate order
    const order = await prisma.order.findFirst({
      where: { id: Number(orderId), restaurantId, isDeleted: false },
      include: {
        orderItems: { include: { menuItem: true } },
        table: true,
        kot: true,
      },
    });

    if (!order) return errorResponse(res, "Order not found", 404);
    if (order.status === "COMPLETED" || order.status === "CANCELLED") {
      return errorResponse(res, `Order is already ${order.status.toLowerCase()}`, 400);
    }
    if (!payments || payments.length === 0) {
      return errorResponse(res, "At least one payment method is required", 400);
    }

    // Discount resolution — single source of truth (shared util, clamped to subtotal)
    const effectiveDiscountType = discountType !== undefined
      ? discountType
      : (order.discountType || null);
    const effectiveDiscountValue = discountValue !== undefined
      ? discountValue
      : (order.discountValue || 0);
    const discountAmount = effectiveDiscountType
      ? calculateDiscountAmount(effectiveDiscountType, effectiveDiscountValue, order.subtotal)
      // Legacy flat `discount` — clamp so a bill can never go negative
      : Math.min(Math.max(0, Number(discount) || 0), order.subtotal);

    // Calculate totals — payable can never go below zero
    const subtotal = order.subtotal;
    const taxAmount = order.taxAmount;
    const totalPayments = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const grandTotal = Math.max(0, subtotal - discountAmount + Number(serviceCharge) + taxAmount + Number(roundOff));

    if (Math.abs(totalPayments - grandTotal) > 0.01) {
      return errorResponse(
        res,
        `Payment total (₹${totalPayments.toFixed(2)}) does not match grand total (₹${grandTotal.toFixed(2)})`,
        400
      );
    }

    // Check for existing paid bill
    const existingBill = await prisma.bill.findFirst({
      where: { orderId: order.id, isCancelled: false },
    });
    if (existingBill && existingBill.paymentStatus === "PAID") {
      return errorResponse(res, "This order has already been paid", 400);
    }

    // ── Execute everything in a transaction ──
    // Concurrent collect calls race past the checks above; the DB unique
    // constraint on Bill.orderId is the final guard. A P2002 here means another
    // request already paid this order — surface it as a clean 400, never a 500
    // (and never a duplicate bill/payment: the loser's transaction rolls back).
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
      // 1. Create or update bill
      let bill;
      const billDiscountData = discountType ? {
        discount: discountAmount,
        discountType,
        discountValue: Number(discountValue),
        discountReason: discountReason || null,
        discountedBy: req.user.id,
        discountedAt: new Date(),
      } : { discount: discountAmount };

      if (existingBill && !existingBill.isCancelled) {
        bill = await tx.bill.update({
          where: { id: existingBill.id },
          data: {
            subtotal, ...billDiscountData, serviceCharge, taxAmount, roundOff, grandTotal,
            paidAmount: totalPayments,
            balanceAmount: Math.max(0, grandTotal - totalPayments),
            paymentStatus: totalPayments >= grandTotal ? "PAID" : "PARTIAL",
            status: totalPayments >= grandTotal ? "PAID" : "UNPAID",
          },
        });
      } else {
        bill = await tx.bill.create({
          data: {
            restaurantId,
            billNo: await generateBillNumber(),
            orderId: order.id,
            subtotal, ...billDiscountData, serviceCharge, taxAmount, roundOff, grandTotal,
            paidAmount: totalPayments,
            balanceAmount: Math.max(0, grandTotal - totalPayments),
            paymentStatus: totalPayments >= grandTotal ? "PAID" : "PARTIAL",
            status: totalPayments >= grandTotal ? "PAID" : "UNPAID",
          },
        });
      }

      // 2. Create payment records with all payment details
      const createdPayments = [];
      for (const pmt of payments) {
        const paymentData = {
          restaurantId,
          paymentNo: `TMP-${randomUUID().slice(0, 8)}`,
          billId: bill.id,
          amount: Number(pmt.amount),
          paymentMethod: pmt.paymentMethod,
          transactionId: pmt.transactionId || null,
          gatewayRef: pmt.gatewayRef || null,
          notes: pmt.notes || null,
          createdBy: req.user.id,
          status: "PAID",
        };

        // Add card-specific fields
        if (pmt.paymentMethod === "CARD") {
          paymentData.cardNumber = pmt.cardNumber || null;
          paymentData.cardType = pmt.cardType || null;
          paymentData.last4Digits = pmt.last4Digits || null;
          paymentData.approvalCode = pmt.approvalCode || null;
        }

        // Add UPI-specific fields
        if (pmt.paymentMethod === "UPI") {
          paymentData.upiTransactionId = pmt.upiTransactionId || pmt.transactionId || null;
          paymentData.upiVerifiedAt = new Date();
        }

        const payment = await tx.payment.create({
          data: paymentData,
        });
        const payNo = `PAY-${String(payment.id).padStart(6, "0")}`;
        await tx.payment.update({
          where: { id: payment.id },
          data: { paymentNo: payNo },
        });
        createdPayments.push({ ...payment, paymentNo: payNo });
      }

      // 3. Mark order COMPLETED & release table if fully paid
      if (totalPayments >= grandTotal) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            // Keep the order discount in sync with the final bill so order
            // details, history and receipts all agree with the persisted bill.
            discount: discountAmount,
            discountType: effectiveDiscountType,
            discountValue: effectiveDiscountType ? Number(effectiveDiscountValue) : 0,
          },
        });
        if (order.tableId) {
          await tx.restaurantTable.update({
            where: { id: order.tableId },
            data: { status: "AVAILABLE" },
          });
        }

        // 3b. Stock was already reserved when the order was placed — payment
        // does NOT deduct again (no duplicate deduction).
      }

      // 4. Update KOT status (multiple KOTs possible per order)
      if (order.kot?.length > 0) {
        for (const kot of order.kot) {
          await tx.kOT.update({
            where: { id: kot.id },
            data: { status: "SERVED" },
          });
        }
      }

        return { bill, payments: createdPayments };
      });
    } catch (err) {
      if (err && err.code === "P2002") {
        return errorResponse(res, "This order has already been paid", 400);
      }
      throw err;
    }

    // ── Post-transaction side effects ──
    await createNotification({
      restaurantId, userId: req.user.id,
      title: "Payment Received",
      message: `₹${totalPayments.toFixed(2)} received for Order ${order.orderNo}`,
      type: "PAYMENT",
    });

    try {
      emitOrderEvent(restaurantId, "payment", {
        orderId: order.id, orderNo: order.orderNo,
        billNo: result.bill.billNo, amount: totalPayments,
        payments: result.payments,
      });
      if (order.tableId) {
        emitToRestaurant(restaurantId, "table:updated", {
          tableId: order.tableId, status: "AVAILABLE",
        });
      }
    } catch (err) { console.error("Socket emit error:", err.message); }

    await createAuditLogEntry({
      userId: req.user.id, restaurantId,
      module: "PAYMENT", action: "PAYMENT",
      description: `Payment collected ₹${totalPayments} for Order ${order.orderNo} (Bill ${result.bill.billNo})`,
      referenceId: result.bill.id, referenceNo: result.bill.billNo,
    });

    // Fetch the complete result with relations
    const completeBill = await prisma.bill.findUnique({
      where: { id: result.bill.id },
      include: {
        payments: { orderBy: { createdAt: "desc" } },
        order: {
          include: {
            table: true,
            customer: true,
            orderItems: { include: { menuItem: true } },
          },
        },
      },
    });

    return successResponse(res, completeBill, "Payment collected successfully", 201);
  } catch (error) {
    console.error("collectPayment error:", error);
    return errorResponse(res, error.message);
  }
};

const createPayment = async (req, res) => {

    try {

        const {

            billId,

            amount,

            paymentMethod,

            transactionId,

            notes

        } = req.body;

        const bill = await prisma.bill.findFirst({

            where: {

                id: Number(billId),

                restaurantId: req.user.restaurantId

            }

        });

        if (!bill) {

            return errorResponse(

                res,

                "Bill not found",

                404

            );

        }

        // Already-paid guard: a settled bill can never accept another payment
        if (bill.paymentStatus === "PAID") {
            return errorResponse(res, "This bill has already been paid", 400);
        }

        const payment = await prisma.payment.create({

            data: {
                restaurantId: req.user.restaurantId,

                paymentNo: "",

                billId,

                amount,

                paymentMethod,

                transactionId,

                notes

            }

        });
        await createNotification({

            restaurantId: req.user.restaurantId,

            userId: req.user.id,

            title: "Payment Received",

            message: `₹${payment.amount} received via ${payment.paymentMethod}.`,

            type: "SUCCESS"

        });
        // const shift = await prisma.shift.findFirst({

        //     where: {

        //         status: "OPEN"

        //     }

        // });

        // if (shift) {

        //     const updateData = {

        //         totalSales: {

        //             increment: Number(payment.amount)

        //         }

        //     };

        //     switch (payment.paymentMethod) {

        //         case "CASH":

        //             updateData.cashSales = {

        //                 increment: Number(payment.amount)

        //             };

        //             break;

        //         case "CARD":

        //             updateData.cardSales = {

        //                 increment: Number(payment.amount)

        //             };

        //             break;

        //         case "UPI":

        //             updateData.upiSales = {

        //                 increment: Number(payment.amount)

        //             };

        //             break;

        //         default:

        //             updateData.otherSales = {

        //                 increment: Number(payment.amount)

        //             };

        //     }

        //     await prisma.shift.update({

        //         where: {

        //             id: shift.id

        //         },

        //         data: updateData

        //     });

        // }

        const updatedPayment = await prisma.payment.update({

            where: {
                id: payment.id
            },

            data: {
                paymentNo:
                    `PAY-${String(payment.id).padStart(6, "0")}`
            }

        });

        const paid = bill.paidAmount + Number(amount);

        const balance = bill.grandTotal - paid;

        // ── Bill update + stock deduction run atomically: if the deduction fails
        // the bill update rolls back too, so stock is never silently skipped ──
        await prisma.$transaction(async (tx) => {
          await tx.bill.update({
            where: { id: bill.id },
            data: {
              paidAmount: paid,
              balanceAmount: balance,
              paymentStatus: balance <= 0 ? "PAID" : "PARTIAL",
              // Keep status in sync with paymentStatus so a fully-paid bill
              // reads as PAID everywhere (reports, dashboard, UI badges).
              ...(balance <= 0 ? { status: "PAID" } : {}),
            },
          });

          // Stock was already reserved when the order was placed — the bill
          // update is the only thing needed here. Payment never deducts again.
        });

        return successResponse(

            res,

            updatedPayment,

            "Payment Successful",

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
const partialPayment = async (req, res) => {

    return createPayment(req, res);

};
const splitPayment = async (req, res) => {

    try {

        const {

            billId,

            payments

        } = req.body;

        const bill = await prisma.bill.findFirst({

            where: {

                id: Number(billId),

                restaurantId: req.user.restaurantId

            }

        });

        if (!bill) {

            return errorResponse(

                res,

                "Bill not found",

                404

            );

        }

        let totalPaid = 0;

        await prisma.$transaction(async (tx) => {

            for (const payment of payments) {

                totalPaid += Number(payment.amount);

                const createdPayment = await tx.payment.create({

                    data: {
                        restaurantId: req.user.restaurantId,

                        paymentNo: `TMP-${randomUUID()}`,

                        billId: Number(billId),

                        amount: payment.amount,

                        paymentMethod: payment.paymentMethod,

                        transactionId: payment.transactionId,

                        notes: payment.notes

                    }

                });
                // const shift = await tx.shift.findFirst({

                //     where: {

                //         status: "OPEN"

                //     }

                // });

                // if (shift) {

                //     const updateData = {

                //         totalSales: {

                //             increment: Number(createdPayment.amount)

                //         }

                //     };

                //     switch (createdPayment.paymentMethod) {

                //         case "CASH":

                //             updateData.cashSales = {

                //                 increment: Number(createdPayment.amount)

                //             };

                //             break;

                //         case "CARD":

                //             updateData.cardSales = {

                //                 increment: Number(createdPayment.amount)

                //             };

                //             break;

                //         case "UPI":

                //             updateData.upiSales = {

                //                 increment: Number(createdPayment.amount)

                //             };

                //             break;

                //         default:

                //             updateData.otherSales = {

                //                 increment: Number(createdPayment.amount)

                //             };

                //     }

                //     await tx.shift.update({

                //         where: {

                //             id: shift.id

                //         },

                //         data: updateData

                //     });

                // }

                await tx.payment.update({

                    where: {
                        id: createdPayment.id
                    },

                    data: {
                        paymentNo:
                            `PAY-${String(createdPayment.id).padStart(6, "0")}`
                    }

                });

            }

            const paidAmount =

                bill.paidAmount + totalPaid;

            const balanceAmount =

                bill.grandTotal - paidAmount;

            await tx.bill.update({

                where: {

                    id: bill.id

                },

                data: {

                    paidAmount,

                    balanceAmount,

                    paymentStatus:

                        balanceAmount <= 0

                            ? "PAID"

                            : "PARTIAL",

                    // Keep status in sync so a fully-paid bill reads as PAID
                    // everywhere (reports, dashboard, UI badges).
                    ...(balanceAmount <= 0 ? { status: "PAID" } : {})

                }

            });

            // Stock was already reserved when the order was placed — split
            // payment never deducts again (no duplicate deduction).

        });

        const result = await prisma.payment.findMany({

            where: {

                billId: Number(billId),
                restaurantId: req.user.restaurantId

            },

            orderBy: {

                createdAt: "desc"

            }

        });

        return successResponse(

            res,

            result,

            "Split payment completed"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const getPayments = async (req, res) => {

    try {

        const payments =

            await prisma.payment.findMany({
                where: {

                    restaurantId: req.user.restaurantId

                },

                include: {

                    bill: true

                },

                orderBy: {

                    createdAt: "desc"

                }

            });

        successResponse(

            res,

            payments,

            "Payments Loaded"

        );

    }

    catch (error) {

        errorResponse(

            res,

            error.message

        );

    }

};


// ─── Reprint Receipt (increment reprint count) ───
const reprintReceipt = async (req, res) => {
  try {
    const billId = Number(req.params.id);
    const bill = await prisma.bill.findFirst({
      where: { id: billId, restaurantId: req.user.restaurantId },
    });
    if (!bill) {
      return errorResponse(res, "Bill not found", 404);
    }
    await prisma.bill.update({
      where: { id: bill.id },
      data: { reprintCount: { increment: 1 }, printedAt: new Date() },
    });
    return successResponse(res, { billId: bill.id, billNo: bill.billNo }, "Receipt reprint logged");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Mark Bill as Printed ───
const markPrinted = async (req, res) => {
  try {
    const billId = Number(req.params.id);
    const bill = await prisma.bill.findFirst({
      where: { id: billId, restaurantId: req.user.restaurantId },
    });
    if (!bill) {
      return errorResponse(res, "Bill not found", 404);
    }
    await prisma.bill.update({
      where: { id: bill.id },
      data: { printedAt: new Date() },
    });
    return successResponse(res, null, "Bill marked as printed");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Send Receipt via Email (placeholder for future implementation) ───
const emailReceipt = async (req, res) => {
  try {
    const billId = Number(req.params.id);
    const bill = await prisma.bill.findFirst({
      where: { id: billId, restaurantId: req.user.restaurantId },
    });
    if (!bill) {
      return errorResponse(res, "Bill not found", 404);
    }
    // Email integration placeholder - email service will be added in future update
    return successResponse(res, { billId: bill.id, billNo: bill.billNo }, "Receipt email queued");
  } catch (error) {
    return errorResponse(res, error.message);
  }
};

// ─── Generate UPI QR Code Data ───
const generateUPIQrData = async (req, res) => {
  try {
    const { amount, orderNo } = req.body;
    const restaurantId = req.user.restaurantId;

    // Fetch restaurant settings for UPI ID
    const setting = await prisma.restaurantSetting.findFirst({
      where: { restaurantId },
    });

    const upiId = setting?.upiId || process.env.DEFAULT_UPI_ID || "restaurant@upi";
    const restaurantName = setting?.restaurantName || "Restaurant";

    if (!amount || amount <= 0) {
      return errorResponse(res, "Valid amount is required", 400);
    }

    // Generate UPI deep link
    // Format: upi://pay?pa={upiId}&pn={name}&am={amount}&tn={orderNo}&cu=INR
    const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(restaurantName)}&am=${Number(amount).toFixed(2)}&tn=${encodeURIComponent(orderNo || "Payment")}&cu=INR`;

    return successResponse(res, {
      upiLink,
      upiId,
      amount: Number(amount),
      orderNo: orderNo || "",
      merchantName: restaurantName,
    }, "UPI QR data generated");
  } catch (error) {
    console.error("generateUPIQrData error:", error);
    return errorResponse(res, error.message);
  }
};

// ─── Verify UPI Payment ───
const verifyUPIPayment = async (req, res) => {
  try {
    const { paymentId, upiTransactionId } = req.body;

    const payment = await prisma.payment.findFirst({
      where: {
        id: Number(paymentId),
        restaurantId: req.user.restaurantId,
      },
    });

    if (!payment) {
      return errorResponse(res, "Payment not found", 404);
    }

    if (payment.paymentMethod !== "UPI") {
      return errorResponse(res, "Not a UPI payment", 400);
    }

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        upiTransactionId: upiTransactionId || payment.upiTransactionId,
        transactionId: upiTransactionId || payment.transactionId,
        upiVerifiedAt: new Date(),
        status: "PAID",
      },
    });

    return successResponse(res, updated, "UPI payment verified successfully");
  } catch (error) {
    console.error("verifyUPIPayment error:", error);
    return errorResponse(res, error.message);
  }
};

module.exports = {
  collectPayment,
  createPayment,
  partialPayment,
  splitPayment,
  getPayments,
  reprintReceipt,
  markPrinted,
  emailReceipt,
  generateUPIQrData,
  verifyUPIPayment,
};