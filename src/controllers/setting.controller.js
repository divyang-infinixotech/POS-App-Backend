// tenantDb is available as req.tenantDb (attached by auth middleware)
const { Prisma } = require("@prisma/client");
const { successResponse, errorResponse } = require("../utils/response");

const createOrUpdateSetting = async (req, res) => {
  const prisma = req.tenantDb;
  try {
    // PHASE 1/17 — tenant authority: the restaurant context comes ONLY from the
    // authenticated user. Any restaurantId sent by the browser is ignored (and
    // never spread into Prisma data). Fields are whitelisted in FIELDS below —
    // req.body is NEVER spread into the Prisma payload.
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
      enableStaffRoster,
      // Barcode Scanner tenant toggle (Part 11) — plan entitlement (upper
      // limit) is enforced by requireFeature on the barcode lookup route.
      barcodeScannerEnabled,
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
      // Staff Roster visibility (plan entitlement still applies first — see feature.middleware)
      ["enableStaffRoster", "enableStaffRoster", toBool],
      // Barcode Scanner (Part 11): restaurant-level ON/OFF. requireFeature
      // (plan entitlement) is checked separately on the lookup route.
      ["barcodeScannerEnabled", "barcodeScannerEnabled", toBool],
      // Billing behavior
      ["autoPrintBill", "autoPrintBill", toBool],
      ["autoPrintKOT", "autoPrintKOT", toBool],
      ["autoGenerateKOT", "autoGenerateKOT", toBool],
      ["multiplePayments", "multiplePayments", toBool],
      ["askCustomerBeforePrint", "askCustomerBeforePrint", toBool],
      ["autoReleaseTable", "autoReleaseTable", toBool],
      // Restaurant dietary mode (Part 6): VEG_ONLY | VEG_AND_NON_VEG — the
      // restaurant-wide maximum; individual staff can only be more restrictive.
      ["dietaryMode", "dietaryMode", (v) => (v === "VEG_ONLY" || v === "VEG_AND_NON_VEG" ? v : undefined)],
      // POS Ordering / Layout
      // Part 10: enablePosOrdering is NOT writable here — POS Ordering is
      // always enabled and is force-set to true below, so a stale client
      // payload can never disable the only order-entry workflow.
      ["posLayout", "posLayout", (v) => v || "basic"],
      // businessMode is derived from the subscription plan — admins cannot override it
      ["enableCounterSale", "enableCounterSale", toBool],
      ["taxType", "taxType", (v) => v || "Inclusive"],
      ["taxesAndCharges", "taxesAndCharges", (v) => (Array.isArray(v) ? v : undefined)],
      ["uiSettings", "uiSettings", (v) => (v && typeof v === "object" ? v : undefined)],
    ];

    const tenantRestaurantId = req.user.restaurantId;
    if (!tenantRestaurantId) {
      return errorResponse(res, "Restaurant context missing.", 403);
    }

    // PHASE 17 — EXPLICIT WHITELIST. `data` starts EMPTY and only receives the
    // whitelisted, transformed fields above. Protected fields (id, restaurantId,
    // createdAt, updatedAt, subscription-controlled values) can never enter the
    // Prisma payload because they are not in FIELDS — req.body is never spread.
    //   - `restaurantId` stays in `where` ONLY (it is a @unique non-PK column:
    //     Prisma rejects it inside update `data` with "Invalid invocation".
    //     CREATE is the one place it belongs, bound to the authenticated tenant).
    //   - `enablePosOrdering` is force-set true (Part 10) — not client-writable.
    //   - `businessMode` is subscription-derived and read-only here.
    const data = {};
    FIELDS.forEach(([bodyKey, field, transform]) => {
      if (bodyKey in req.body) {
        const val = transform(req.body[bodyKey]);
        if (val !== undefined) data[field] = val;
      }
    });
    if (Object.keys(data).length === 0 && !("printers" in req.body)) {
      // Nothing editable was submitted — a malformed/empty payload is a client
      // error (400), never a 500.
      return errorResponse(res, "No valid settings fields provided.", 400);
    }
    // Part 10: POS Ordering screen is mandatory — always ON.
    data.enablePosOrdering = true;

    const existing = await prisma.restaurantSetting.findUnique({
      where: {
        restaurantId: tenantRestaurantId
      }
    });

    let setting;

    if (existing) {
      setting = await prisma.restaurantSetting.update({
        where: {
          restaurantId: tenantRestaurantId
        },
        data
      });
    } else {
      setting = await prisma.restaurantSetting.create({
        data: { ...data, restaurantId: tenantRestaurantId }
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
    // PHASE 1 req.10 — log full detail server-side; return a SAFE message.
    // Raw Prisma internals ("Invalid invocation", "Unknown argument …") must    // never leak to the frontend.
    console.error("[settings] save failed:", error);
    if (error instanceof Prisma.PrismaClientValidationError) {
      return errorResponse(res, "Invalid settings payload.", 400);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return errorResponse(res, "Settings could not be saved.", 400);
    }
    return errorResponse(res, "Failed to save settings.", 500);
  }
};

const getSetting = async (req, res) => {
  const prisma = req.tenantDb;

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

    // Derive the effective businessMode from the subscription plan (authoritative source)
    // Subscription is a PLATFORM model (public schema) — must use platformPrisma
    let effectiveBusinessMode = (setting && setting.businessMode) || 'restaurant';
    try {
      const { platformPrisma } = require('../config/tenantPrisma');
      const subscription = await platformPrisma.subscription.findFirst({
        where: { restaurantId: req.user.restaurantId },
        select: { id: true, businessMode: true, status: true, planId: true }
      });
      if (subscription && subscription.businessMode) {
        effectiveBusinessMode = subscription.businessMode === 'BASIC_POS' ? 'counter' : 'restaurant';
      }
    } catch (subErr) {
      console.error('[Settings] Subscription lookup failed:', subErr.message);
    }

    if (!setting) {
      return res.json({
        success: true,
        setting: null,
        printers: []
      });
    }

    // Override businessMode with the subscription-derived value
    const settingWithMode = { ...setting, businessMode: effectiveBusinessMode };

    return res.json({
      success: true,
      setting: settingWithMode,
      printers
    });

  } catch (error) {
    // PHASE 1 req.10 — same safe-error rule as the save path: no Prisma    // internals in the response body.
    console.error("[settings] fetch failed:", error);
    return errorResponse(res, "Failed to load settings.", 500);
  }

};

module.exports = {
  createOrUpdateSetting,
  getSetting
};