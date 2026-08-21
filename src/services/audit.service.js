const prisma = require("../config/prisma");

const createAuditLog = async ({

    restaurantId,

    userId,

    module,

    action,

    description,

    referenceId,

    referenceNo,

    ipAddress,

    userAgent

},

    tx = prisma) => {

    return await tx.auditLog.create({

        data:{

    restaurantId,

    userId,

    module,

    action,

    description,

    referenceId,

    referenceNo,

    ipAddress,

    userAgent

}

    });

};
const getAuditLogs = async (restaurantId) => {

    const where = restaurantId ? { restaurantId } : {};

    return await prisma.auditLog.findMany({

        where,

        include: {

            user: {

                select: {

                    id: true,

                    name: true,

                    email: true,

                    role: true

                }

            }

        },

        orderBy: {

            createdAt: "desc"

        }

    });

};

module.exports = {

    createAuditLog,

    getAuditLogs

};