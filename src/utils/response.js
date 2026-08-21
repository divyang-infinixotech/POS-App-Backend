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

};

const errorResponse = (

    res,

    message = "Something went wrong",

    statusCode = 500

) => {

    // Prisma client-side validation failures (e.g. a non-numeric :id parameter
    // reaching Number(req.params.id) → NaN, or a malformed filter value) are
    // client-input problems — return a clean 400, never a 500 with the raw
    // Prisma invocation details. The full error is still logged upstream.
    let safeMessage = message;
    let safeStatus = statusCode;
    if (typeof message === "string" && message.includes("Invalid `prisma.")) {
        safeMessage = "Invalid request parameters";
        safeStatus = 400;
    } else if (safeStatus >= 500 && process.env.NODE_ENV === "production") {
        // Never echo internal error details (Prisma internals, file paths,
        // SQL) to clients in production — the full error is logged server-side.
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