// const express = require("express");

// const router = express.Router();

// const protect = require("../middleware/auth.middleware");

// const authorize = require("../middleware/role.middleware");

// const validate = require("../middleware/validate.middleware");

// const {

//     openShiftSchema,
//     closeShiftSchema

// } = require("../validators/shift.validator");

// const {

//     openShift,

//     getCurrentShift,
//     closeShift

// } = require("../controllers/shift.controller");

// router.post(

//     "/open",

//     protect,

//     authorize("ADMIN", "MANAGER"),

//     validate(openShiftSchema),

//     openShift

// );

// router.get(

//     "/current",

//     protect,

//     getCurrentShift

// );
// router.post(

//     "/close",

//     protect,

//     authorize("ADMIN", "MANAGER"),

//     validate(closeShiftSchema),

//     closeShift

// );

// module.exports = router;