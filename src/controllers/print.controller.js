const { successResponse, errorResponse } = require("../utils/response");

const {
    generateReceipt
} = require("../services/receipt.service");

const {
    generateInvoice
} = require("../services/invoice.service");

const printReceipt = async (req, res) => {
  try {
    const prisma = req.tenantDb;
    if (!prisma) {
      return errorResponse(res, "Tenant database not available", 503);
    }

    const restaurantSetting = await prisma.restaurantSetting.findUnique({
      where: { restaurantId: req.user.restaurantId }
    });

    const bill = await prisma.bill.findFirst({
      where: {
        id: Number(req.params.id)
      },
      include: {
        payments: true,
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
      return res.status(404).json({
        success: false,
        message: "Bill not found"
      });
    }

    const billData = {
      ...bill,
      restaurant: restaurantSetting || null,
      restaurantName: restaurantSetting?.restaurantName || "Restaurant",
      address: restaurantSetting?.address || "",
      phone: restaurantSetting?.phone || "",
      gstNumber: restaurantSetting?.gstNumber || "",
      fssaiNumber: restaurantSetting?.fssaiNumber || "",
      email: restaurantSetting?.email || "",
      receiptFooter: restaurantSetting?.receiptFooter || "Thank You! Visit Again.",
      logo: restaurantSetting?.logo || ""
    };

    return generateReceipt(billData, res);
  } catch (error) {
    console.error("printReceipt error:", error);
    return errorResponse(res, error.message);
  }
};

const printInvoice = async (req, res) => {
  try {
    const prisma = req.tenantDb;
    if (!prisma) {
      return errorResponse(res, "Tenant database not available", 503);
    }

    const restaurantSetting = await prisma.restaurantSetting.findUnique({
      where: { restaurantId: req.user.restaurantId }
    });

    const bill = await prisma.bill.findFirst({
      where: {
        id: Number(req.params.id)
      },
      include: {
        payments: true,
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
      return res.status(404).json({
        success: false,
        message: "Bill not found"
      });
    }

    await prisma.bill.update({
      where: { id: bill.id },
      data: {
        reprintCount: { increment: 1 },
        printedAt: new Date()
      }
    });

    const billData = {
      ...bill,
      restaurant: restaurantSetting || null,
      restaurantName: restaurantSetting?.restaurantName || "Restaurant",
      address: restaurantSetting?.address || "",
      phone: restaurantSetting?.phone || "",
      gstNumber: restaurantSetting?.gstNumber || "",
      fssaiNumber: restaurantSetting?.fssaiNumber || "",
      email: restaurantSetting?.email || "",
      receiptFooter: restaurantSetting?.receiptFooter || "Thank You! Visit Again.",
      logo: restaurantSetting?.logo || ""
    };

    return generateInvoice(billData, res);
  } catch (error) {
    console.error("printInvoice error:", error);
    return errorResponse(res, error.message);
  }
};

module.exports = {
    printReceipt,
    printInvoice
};
