const express=require("express");

const router=express.Router();
const audit = require("../middleware/audit.middleware");

const protect=require("../middleware/auth.middleware");
const authorize=require("../middleware/role.middleware");
const validate=require("../middleware/validate.middleware");
const { BILLING_ROLES } = require("../utils/billing-roles");

const{

printerSchema

}=require("../validators/printer.validator");

const{

saveSettings,

getSettings,
printBill,
printKOT,
printReprint

}=require("../controllers/printer.controller");

router.post("/settings",
    protect,
    authorize("ADMIN", "SUPER_ADMIN"),
    validate(printerSchema),
    saveSettings
);

router.get("/settings",
    protect,
    authorize("ADMIN", "SUPER_ADMIN"),
    getSettings
);

// Bill print data is part of the billing workflow — restricted to
// billing-capable roles (ADMIN/MANAGER/CASHIER). KITCHEN and WAITER are denied.
router.get(

    "/bill/:id",

    protect,

    authorize(...BILLING_ROLES),

    printBill

);

// KOT print data is needed by the kitchen — ADMIN/MANAGER/KITCHEN only.
// WAITER and CASHIER do not print kitchen tickets.
router.get(

    "/kot/:id",

    protect,

    authorize("ADMIN", "MANAGER", "KITCHEN"),

    printKOT

);

// Bill reprint increments the reprint counter — billing-capable roles only.
router.get(

    "/reprint/:id",

    protect,

    authorize(...BILLING_ROLES),

    printReprint

);

module.exports=router;