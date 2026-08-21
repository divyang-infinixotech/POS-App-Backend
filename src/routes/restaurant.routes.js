const express = require("express");

const router = express.Router();

const {

    createRestaurant,

    getRestaurants,

    getRestaurant,

    updateRestaurant,

    deleteRestaurant

} = require("../controllers/restaurant.controller");

const validate = require("../middleware/validate.middleware");

const {

    restaurantSchema

} = require("../validators/restaurant.validator");

router.post(
    "/",
    validate(restaurantSchema),
    createRestaurant
);

router.get("/", getRestaurants);

router.get("/:id", getRestaurant);

router.put(
    "/:id",
    validate(restaurantSchema),
    updateRestaurant
);

router.delete("/:id", deleteRestaurant);

module.exports = router;