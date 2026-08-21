const prisma = require("../config/prisma");
const { successResponse, errorResponse } = require("../utils/response");

const createOrUpdateSetting = async (req, res) => {
  try {
    // Destructure ALL possible fields from request body
    const {
      restaurantName,
      gstNumber,
      fssaiNumber,
      phone,
      email,
      website,
      address,
      logo,
      currency,
      timezone,
      language,
      taxPercentage,
      serviceCharge,
      roundOffEnabled,
      billPrefix,
      billNumberStart,
      invoicePrefix,
      kotPrefix,
      enableKitchenDisplay,
      enableKotStatusTracking,
      receiptFooter,
      // Module Visibility Settings
      enableKitchen,
      enableBilling,
      enableHoldOrders,
      enableAddItem,
      enableSplitBill,
      enableTransferTable,
      enableMergeTables,
      enableFloorManagement,
      enableReports,
      enableMenu,
      enableStock,
      enableActiveOrders,
      enableTableReservations,
      // Billing Behavior Settings
      autoPrintBill,
      autoPrintKOT,
      autoGenerateKOT,
      multiplePayments,
      askCustomerBeforePrint,
      autoReleaseTable,
      // POS Ordering / Layout Settings
      enablePosOrdering,
      posLayout,
      businessMode,
      enableCounterSale,
      taxType,
      taxesAndCharges,
      uiSettings,
      // Additional settings stored as JSON
      printers
    } = req.body;

    const toBool = (v) => v === true || v === "true";

    // Build data object with all supported Prisma fields.
    // IMPORTANT: only fields actually present in the request body are included,
    // so partial saves (e.g. logo-only updates) never clobber other settings
    // (previously, omitted booleans were converted to `false` and wiped modules).
    const FIELDS = [
      // [body key, prisma field, transform]
      ["restaurantName", "restaurantName", (v) => v],
      ["gstNumber", "gstNumber", (v) => v || null],
      ["fssaiNumber", "fssaiNumber", (v) => v || null],
      ["phone", "phone", (v) => v || null],
      ["email", "email", (v) => v || null],
      ["website", "website", (v) => v || null],
      ["address", "address", (v) => v || null],
      ["logo", "logo", (v) => v || null],
      ["currency", "currency", (v) => v || "INR"],
      ["timezone", "timezone", (v) => v || "Asia/Kolkata"],
      ["language", "language", (v) => v || "en"],
      ["taxPercentage", "taxPercentage", (v) => (v != null ? Number(v) : 0)],
      ["serviceCharge", "serviceCharge", (v) => (v != null ? Number(v) : 0)],
      ["roundOffEnabled", "roundOffEnabled", toBool],
      ["billPrefix", "billPrefix", (v) => v || "BILL"],
      ["billNumberStart", "billNumberStart", (v) => (v != null ? Number(v) : 1)],
      ["invoicePrefix", "invoicePrefix", (v) => v || "INV"],
      ["kotPrefix", "kotPrefix", (v) => v || "KOT"],
      ["enableKitchenDisplay", "enableKitchenDisplay", toBool],
      ["enableKotStatusTracking", "enableKotStatusTracking", toBool],
      ["receiptFooter", "receiptFooter", (v) => v || null],
      // Module visibility
      ["enableKitchen", "enableKitchen", toBool],
      ["enableBilling", "enableBilling", toBool],
      ["enableHoldOrders", "enableHoldOrders", toBool],
      ["enableAddItem", "enableAddItem", toBool],
      ["enableSplitBill", "enableSplitBill", toBool],
      ["enableTransferTable", "enableTransferTable", toBool],
      ["enableMergeTables", "enableMergeTables", toBool],
      ["enableFloorManagement", "enableFloorManagement", toBool],
      ["enableReports", "enableReports", toBool],
      ["enableMenu", "enableMenu", toBool],
      ["enableStock", "enableStock", toBool],
      ["enableActiveOrders", "enableActiveOrders", toBool],
      ["enableTableReservations", "enableTableReservations", toBool],
      // Billing behavior
      ["autoPrintBill", "autoPrintBill", toBool],
      ["autoPrintKOT", "autoPrintKOT", toBool],
      ["autoGenerateKOT", "autoGenerateKOT", toBool],
      ["multiplePayments", "multiplePayments", toBool],
      ["askCustomerBeforePrint", "askCustomerBeforePrint", toBool],
      ["autoReleaseTable", "autoReleaseTable", toBool],
      // POS Ordering / Layout
      ["enablePosOrdering", "enablePosOrdering", toBool],
      ["posLayout", "posLayout", (v) => v || "basic"],
      ["businessMode", "businessMode", (v) => v || "restaurant"],
      ["enableCounterSale", "enableCounterSale", toBool],
      ["taxType", "taxType", (v) => v || "Inclusive"],
      ["taxesAndCharges", "taxesAndCharges", (v) => (Array.isArray(v) ? v : undefined)],
      ["uiSettings", "uiSettings", (v) => (v && typeof v === "object" ? v : undefined)],
    ];

    const data = { restaurantId: req.user.restaurantId };
    FIELDS.forEach(([bodyKey, field, transform]) => {
      if (bodyKey in req.body) {
        const val = transform(req.body[bodyKey]);
        if (val !== undefined) data[field] = val;
      }
    });

    const existing = await prisma.restaurantSetting.findUnique({
      where: {
        restaurantId: req.user.restaurantId
      }
    });

    let setting;

    if (existing) {
      setting = await prisma.restaurantSetting.update({
        where: {
          restaurantId: req.user.restaurantId
        },
        data
      });
    } else {
      setting = await prisma.restaurantSetting.create({
        data
      });
    }

    // If printers data is provided, save to printer settings as well
    if (printers && Array.isArray(printers)) {
      try {
        const existingPrinter = await prisma.printerSetting.findFirst({
          where: { restaurantId: req.user.restaurantId }
        });

        // Store printers as JSON in a printerSettings JSON field
        // Since PrinterSetting model is 1:1, we serialize multiple printers
        const printerData = {
          printerName: printers[0]?.name || "Default Printer",
          ipAddress: printers[0]?.ipOrAddress || null,
          connectionType: printers[0]?.connection === "Network (TCP/IP)" ? "LAN" : printers[0]?.connection === "Bluetooth" ? "BLUETOOTH" : "USB",
          port: printers[0]?.port || 9100,
          printersJson: JSON.stringify(printers)
        };

        if (existingPrinter) {
          await prisma.printerSetting.update({
            where: { id: existingPrinter.id },
            data: printerData
          });
        } else {
          await prisma.printerSetting.create({
            data: {
              restaurantId: req.user.restaurantId,
              ...printerData
            }
          });
        }
      } catch (printerErr) {
        // Log but don't fail the main settings save
        console.error("Failed to save printer settings:", printerErr.message);
      }
    }

    return successResponse(
      res,
      setting,
      "Restaurant settings saved successfully"
    );

  } catch (error) {
    console.error(error);
    return errorResponse(
      res,
      error.message
    );
  }
};

const getSetting = async (req, res) => {

  try {

    if (!req.user.restaurantId) {
      return res.json({
        success: true,
        setting: null
      });
    }

    const setting = await prisma.restaurantSetting.findFirst({
      where: {
        restaurantId: req.user.restaurantId
      }
    });

    // Also fetch printer settings to return with the response
    let printers = [];
    try {
      const printerSetting = await prisma.printerSetting.findFirst({
        where: { restaurantId: req.user.restaurantId }
      });
      if (printerSetting && printerSetting.printersJson) {
        printers = JSON.parse(printerSetting.printersJson);
      }
    } catch (printerErr) {
      // Silent fail - printers are optional
    }

    if (!setting) {
      return res.json({
        success: true,
        setting: null,
        printers: []
      });
    }

    return res.json({
      success: true,
      setting,
      printers
    });

  } catch (error) {return errorResponse(res, error.message);}

};

module.exports = {
  createOrUpdateSetting,
  getSetting
};