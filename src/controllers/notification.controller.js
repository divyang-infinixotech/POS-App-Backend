const {

    getNotifications,

    markAsRead,

    markAllAsRead,

    deleteNotification

} = require("../services/notification.service");

const {

    successResponse,

    errorResponse

} = require("../utils/response");

const getAllNotifications = async (req, res) => {

    try {

        const notifications = await getNotifications(

            req.user.restaurantId

        );

        return successResponse(

            res,

            notifications,

            "Notifications fetched successfully."

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const readNotification = async (req, res) => {

    try {

        const notification = await markAsRead(

            req.user.restaurantId,

            req.params.id

        );

        return successResponse(

            res,

            notification,

            "Notification marked as read."

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const readAllNotifications = async (req, res) => {

    try {

        await markAllAsRead(

            req.user.restaurantId

        );

        return successResponse(

            res,

            null,

            "All notifications marked as read."

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const removeNotification = async (req, res) => {

    try {

        await deleteNotification(

            req.user.restaurantId,

            req.params.id

        );

        return successResponse(

            res,

            null,

            "Notification deleted successfully."

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
module.exports = {

    getAllNotifications,

    readNotification,

    readAllNotifications,

    removeNotification

};