const express = require("express");

const router = express.Router();

const protect = require("../middleware/auth.middleware");

const authorize = require("../middleware/role.middleware");

const requireFeature = require("../middleware/feature.middleware");

const {

    getCustomers,

    createWalkInCustomer

} = require("../controllers/customer.controller");

router.get(
    "/",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature("customers"),
    getCustomers
);

router.post(
    "/walk-in",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature("customers"),
    createWalkInCustomer
);

module.exports = router;