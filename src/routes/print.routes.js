const express=require("express");

const router=express.Router();
const audit = require("../middleware/audit.middleware");

const protect=require("../middleware/auth.middleware");

const{

printReceipt,

printInvoice

}=require("../controllers/print.controller");

router.get(

"/receipt/:id",

protect,

printReceipt

);

router.get(

"/invoice/:id",

protect,

printInvoice

);


module.exports=router;