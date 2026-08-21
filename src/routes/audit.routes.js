const express = require("express");
const audit = require("../middleware/audit.middleware");
const router = express.Router();

const protect = require("../middleware/auth.middleware");

const {

    getLogs

} = require("../controllers/audit.controller");

router.get(

    "/",

    protect,

    getLogs

);

module.exports = router;