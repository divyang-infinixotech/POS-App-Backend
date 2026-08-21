const express = require("express");

const router = express.Router();

const protect =
require("../middleware/auth.middleware");

const {

    getAllNotifications,

    readNotification,

    readAllNotifications,

    removeNotification

} = require("../controllers/notification.controller");

router.get(

    "/",

    protect,

    getAllNotifications

);

router.patch(

    "/:id/read",

    protect,

    readNotification

);

router.patch(

    "/read-all",

    protect,

    readAllNotifications

);

router.delete(

    "/:id",

    protect,

    removeNotification

);

module.exports = router;