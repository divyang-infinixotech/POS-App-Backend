const express=require("express");

const router=express.Router();
const audit = require("../middleware/audit.middleware");

const protect=require("../middleware/auth.middleware");
const authorize=require("../middleware/role.middleware");
const validate=require("../middleware/validate.middleware");

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

router.get(

    "/bill/:id",

    protect,

    printBill

);

router.get(

    "/kot/:id",

    protect,

    printKOT

);
router.get(

    "/reprint/:id",

    protect,

    printReprint

);

module.exports=router;