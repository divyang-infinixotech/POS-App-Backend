const express = require("express");
const audit = require("../middleware/audit.middleware");

const router = express.Router();

const protect = require(
  "../middleware/auth.middleware"
);

const authorize = require(
  "../middleware/role.middleware"
);

router.get(
  "/dashboard",
  protect,
  authorize("ADMIN"),
  (req, res) => {

    res.json({
      success: true,
      message: "Welcome Admin"
    });

  }
);

module.exports = router;