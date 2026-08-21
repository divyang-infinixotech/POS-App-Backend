const asyncHandler = require("../utils/asyncHandler");

const {

    getAuditLogs

} = require("../services/audit.service");

const {

    successResponse

} = require("../utils/response");

const getLogs = asyncHandler(

    async (req, res) => {
        // Super Admin sees all logs; restaurant users see only their own
        const restaurantId =
            req.user.role === "SUPER_ADMIN"
                ? null
                : req.user.restaurantId;
        const logs = await getAuditLogs(restaurantId);

        return successResponse(

            res,

            logs,

            "Audit Logs"

        );

    }

);

module.exports = {

    getLogs

};