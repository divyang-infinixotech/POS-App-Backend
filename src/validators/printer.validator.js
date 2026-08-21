const Joi=require("joi");

const printerSchema=Joi.object({

printerName:Joi.string().required(),

printerWidth:Joi.number()

.valid(58,80)

.required(),

autoPrintBill:Joi.boolean(),

autoPrintKOT:Joi.boolean(),

showLogo:Joi.boolean(),

showGST:Joi.boolean(),

showQRCode:Joi.boolean(),

billHeader:Joi.string()

.allow("",null),

billFooter:Joi.string()

.allow("",null)

});

module.exports={

printerSchema

};