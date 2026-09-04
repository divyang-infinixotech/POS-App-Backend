const express=require("express");

const router=express.Router();
const audit = require("../middleware/audit.middleware");

const protect=require("../middleware/auth.middleware");
const authorize=require("../middleware/role.middleware");
const { BILLING_ROLES } = require("../utils/billing-roles");

const{

printReceipt,

printInvoice

}=require("../controllers/print.controller");

// Receipt / invoice rendering is part of the billing workflow — restricted to
// billing-capable roles (ADMIN/MANAGER/CASHIER). KITCHEN and WAITER are denied.
router.get(

"/receipt/:id",

protect,

authorize(...BILLING_ROLES),

printReceipt

);

router.get(

"/invoice/:id",

protect,

authorize(...BILLING_ROLES),

printInvoice

);


module.exports=router;