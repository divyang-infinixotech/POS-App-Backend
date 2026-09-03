const { platformPrisma } = require("../config/tenantPrisma");

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
    db
) => {
    // AuditLog is a TENANT model — caller must pass the tenant client.
    // Fall back to platformPrisma for backward compatibility (platform-level audits).
    const client = db || platformPrisma;

    return await client.auditLog.create({
        data: {
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

const getAuditLogs = async (restaurantId, db) => {
    // AuditLog is a TENANT model — caller must pass the tenant client.
    const client = db || platformPrisma;
    const where = {};

    return await client.auditLog.findMany({
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
