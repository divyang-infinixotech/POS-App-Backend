const successResponse = (
    res,
    data = null,
    message = "Success",
    statusCode = 200
) => {

    return res.status(statusCode).json({

        success: true,

        message,

        data

    });

};const errorResponse = (
    res,
    message = "Something went wrong",
    statusCode = 500
) => {

    let safeMessage = message;
    let safeStatus = statusCode;

    // Only mask truly client-input validation errors, not Prisma runtime errors
    if (typeof message === "string" && message.includes("Invalid request parameters")) {
        safeStatus = 400;
    } else if (safeStatus >= 500 && process.env.NODE_ENV === "production") {
        safeMessage = "Internal Server Error";
    }

    return res.status(safeStatus).json({
        success: false,
        message: safeMessage
    });

};

module.exports = {

    successResponse,

    errorResponse

};