const prisma = require("../config/prisma");

const createNotification = async (

    {

        restaurantId,

        userId = null,

        title,

        message,

        type = "INFO"

    },

    tx = prisma

) => {

    return await tx.notification.create({

        data: {

            restaurantId,

            userId,

            title,

            message,

            type

        }

    });

};
const getNotifications = async (

    restaurantId,

    userId = null

) => {

    return await prisma.notification.findMany({

        where: {

            restaurantId,

            ...(userId && { userId })

        },

        orderBy: {

            createdAt: "desc"

        },
        take: 50

    });

};

const markAsRead = async (

    restaurantId,

    id

) => {

    const notification = await prisma.notification.findFirst({

        where: {

            id: Number(id),

            restaurantId

        }

    });

    if (!notification) {

        throw new Error("Notification not found.");

    }

    return await prisma.notification.update({

        where: {

            id: notification.id

        },

        data: {

            isRead: true

        }

    });

};

const markAllAsRead = async (

    restaurantId,

    userId = null

) => {

    return await prisma.notification.updateMany({

        where: {

            restaurantId,

            ...(userId && { userId }),

            isRead: false

        },

        data: {

            isRead: true

        }

    });

};

const deleteNotification = async (

    restaurantId,

    id

) => {

    const notification = await prisma.notification.findFirst({

        where: {

            id: Number(id),

            restaurantId

        }

    });

    if (!notification) {

        throw new Error("Notification not found.");

    }

    return await prisma.notification.delete({

        where: {

            id: notification.id

        }

    });

};
module.exports = {

    createNotification,

    getNotifications,

    markAsRead,

    markAllAsRead,

    deleteNotification

};