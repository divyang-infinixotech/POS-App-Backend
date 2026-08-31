const Joi = require("joi");

const settingSchema = Joi.object({
    restaurantName: Joi.string().min(2).max(200).required(),
    gstNumber: Joi.string().allow(null, "").max(50),
    fssaiNumber: Joi.string().allow(null, "").max(50),
    phone: Joi.string().allow(null, "").max(20),
    email: Joi.string().email().allow(null, ""),
    website: Joi.string().allow(null, "").uri({ allowRelative: true }),
    address: Joi.string().allow(null, "").max(500),
    logo: Joi.string().allow(null, ""),
    currency: Joi.string().default("INR").max(10),
    timezone: Joi.string().default("Asia/Kolkata").max(50),
    language: Joi.string().default("en").max(20),
    taxPercentage: Joi.number().min(0).max(100).default(0),
    serviceCharge: Joi.number().min(0).max(100).default(0),
    roundOffEnabled: Joi.boolean().default(true),
    billPrefix: Joi.string().default("BILL").max(20),
    billNumberStart: Joi.number().integer().min(1).default(1),
    invoicePrefix: Joi.string().default("INV").max(20),
    kotPrefix: Joi.string().default("KOT").max(20),
    enableKitchenDisplay: Joi.boolean().default(false),
    enableKotStatusTracking: Joi.boolean().default(false),
    receiptFooter: Joi.string().allow(null, "").max(500),
    // Module Visibility Settings
    enableKitchen: Joi.boolean().default(true),
    enableBilling: Joi.boolean().default(true),
    enableHoldOrders: Joi.boolean().default(true),
    enableAddItem: Joi.boolean().default(true),
    enableSplitBill: Joi.boolean().default(true),
    enableTransferTable: Joi.boolean().default(true),
    enableMergeTables: Joi.boolean().default(true),
    enableFloorManagement: Joi.boolean().default(true),
    enableReports: Joi.boolean().default(true),
    enableMenu: Joi.boolean().default(true),
    enableStock: Joi.boolean().default(true),
    enableActiveOrders: Joi.boolean().default(true),
    enableTableReservations: Joi.boolean().default(false),
    // Billing Behavior Settings
    autoPrintBill: Joi.boolean().default(false),
    autoPrintKOT: Joi.boolean().default(false),
    autoGenerateKOT: Joi.boolean().default(false),
    multiplePayments: Joi.boolean().default(false),
    askCustomerBeforePrint: Joi.boolean().default(false),
    autoReleaseTable: Joi.boolean().default(true),
    // POS Ordering / Layout Settings
    enablePosOrdering: Joi.boolean().default(true),
    posLayout: Joi.string().valid("basic", "standard", "quick").default("basic"),
    // businessMode is derived from the subscription plan — removed from admin input
    enableCounterSale: Joi.boolean().default(false),
    taxType: Joi.string().valid("Inclusive", "Exclusive").default("Inclusive"),
    taxesAndCharges: Joi.array().items(Joi.object({
        id: Joi.string(),
        name: Joi.string(),
        rate: Joi.number(),
        isEnabled: Joi.boolean(),
        isDefault: Joi.boolean(),
        type: Joi.string().allow("", null)
    })).optional(),
    uiSettings: Joi.object().pattern(Joi.string(), Joi.any()).optional(),
    printers: Joi.array().items(Joi.object({
        id: Joi.string(),
        name: Joi.string(),
        type: Joi.string(),
        connection: Joi.string(),
        ipOrAddress: Joi.string(),
        port: Joi.number(),
        status: Joi.string(),
        addedAt: Joi.string()
    })).optional()
}).min(1); // At least one field required

module.exports = {
    settingSchema
};
