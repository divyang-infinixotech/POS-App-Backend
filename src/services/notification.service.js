const { platformPrisma } = require("../config/tenantPrisma");

/**
 * Detect whether a value is a PrismaClient instance.
 * Checks for the `.notification` delegate which every Prisma client exposes.
 * This avoids fragile internal-property checks like `_runtimeClientVersion`
 * which may not exist in all Prisma versions.
 */
function isPrismaClient(obj) {
  return obj != null && typeof obj === 'object' && typeof obj.notification === 'object';
}

const createNotification = async (
    dbOrData,
    dataOrUndefined,
    txOverride
) => {
    // Support two call signatures:
    // 1. createNotification(tenantDb, { restaurantId, userId, title, message, type }, tx?)
    // 2. createNotification({ restaurantId, userId, title, message, type }, tx?) [legacy]
    let db, data, tx;
    if (isPrismaClient(dbOrData)) {
        // First arg is a PrismaClient instance
        db = dbOrData;
        data = dataOrUndefined || {};
        tx = txOverride;
    } else {
        // Legacy: first arg is data object
        data = dbOrData || {};
        tx = dataOrUndefined;
    }
    const client = tx || db || platformPrisma;

    // Defensive: if client is not a valid Prisma delegate, skip silently
    if (!client || typeof client.notification !== 'object') {
        console.error('[Notification] No valid Prisma client available — skipping notification');
        return null;
    }

    return await client.notification.create({
        data: {
            restaurantId: data.restaurantId,
            userId: data.userId,
            title: data.title,
            message: data.message,
            type: data.type || 'INFO'
        }
    });

};const getNotifications = async (
    restaurantId,
    userId = null,
    db = null
) => {
    const client = isPrismaClient(db) ? db : platformPrisma;
    return await client.notification.findMany({
        where: {
            ...(userId && { userId })
        },

        orderBy: {

            createdAt: "desc"

        },
        take: 50

    });

};const markAsRead = async (
    restaurantId,
    id,
    db = null
) => {
    const client = isPrismaClient(db) ? db : platformPrisma;
    const notification = await client.notification.findFirst({
        where: {
            id: Number(id)
        }
    });

    if (!notification) {

        throw new Error("Notification not found.");

    }    return await client.notification.update({
        where: {
            id: notification.id
        },
        data: {
            isRead: true
        }
    });

};const markAllAsRead = async (
    restaurantId,
    userId = null,
    db = null
) => {
    const client = isPrismaClient(db) ? db : platformPrisma;
    return await client.notification.updateMany({
        where: {
            ...(userId && { userId }),

            isRead: false

        },

        data: {

            isRead: true

        }

    });

};const deleteNotification = async (
    restaurantId,
    id,
    db = null
) => {
    const client = isPrismaClient(db) ? db : platformPrisma;
    const notification = await client.notification.findFirst({
        where: {
            id: Number(id)
        }
    });

    if (!notification) {

        throw new Error("Notification not found.");

    }    return await client.notification.delete({
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