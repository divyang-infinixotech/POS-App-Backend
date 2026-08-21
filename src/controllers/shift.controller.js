// const prisma = require("../config/prisma");

// const {

//     successResponse,

//     errorResponse

// } = require("../utils/response");

// const openShift = async (req, res) => {

//     try {

//         const {

//             openingCash

//         } = req.body;

//         const existingShift = await prisma.shift.findFirst({

//             where: {

//                 status: "OPEN"

//             }

//         });

//         if (existingShift) {

//             return errorResponse(

//                 res,

//                 "A shift is already open"

//             );

//         }

//         const lastShift = await prisma.shift.findFirst({

//             orderBy: {

//                 id: "desc"

//             }

//         });

//         const shiftNo = `SHIFT-${String((lastShift?.id || 0) + 1).padStart(6, "0")}`;

//         const shift = await prisma.shift.create({

//             data: {

//                 shiftNo,

//                 openedBy: req.user.id,

//                 openingCash

//             }

//         });

//         return successResponse(

//             res,

//             shift,

//             "Shift opened successfully",

//             201

//         );

//     }

//     catch (error) {

//         return errorResponse(

//             res,

//             error.message

//         );

//     }

// };
// const getCurrentShift = async (req, res) => {

//     try {

//         const shift = await prisma.shift.findFirst({

//             where: {

//                 status: "OPEN"

//             }

//         });

//         if (!shift) {

//             return errorResponse(

//                 res,

//                 "No active shift found",

//                 404

//             );

//         }

//         return successResponse(

//             res,

//             shift,

//             "Current Shift"

//         );

//     }

//     catch (error) {

//         return errorResponse(

//             res,

//             error.message

//         );

//     }

// };
// const closeShift = async (req, res) => {

//     try {

//         const {

//             closingCash

//         } = req.body;

//         const shift = await prisma.shift.findFirst({

//             where: {

//                 status: "OPEN"

//             }

//         });

//         if (!shift) {

//             return errorResponse(

//                 res,

//                 "No active shift found",

//                 404

//             );

//         }

//         const payments = await prisma.payment.findMany({

//             where: {

//                 createdAt: {

//                     gte: shift.openedAt

//                 }

//             }

//         });

//         let cashSales = 0;
//         let cardSales = 0;
//         let upiSales = 0;
//         let otherSales = 0;

//         for (const payment of payments) {

//             switch (payment.paymentMethod) {

//                 case "CASH":

//                     cashSales += payment.amount;

//                     break;

//                 case "CARD":

//                     cardSales += payment.amount;

//                     break;

//                 case "UPI":

//                     upiSales += payment.amount;

//                     break;

//                 default:

//                     otherSales += payment.amount;

//             }

//         }

//         const totalSales =

//             cashSales +

//             cardSales +

//             upiSales +

//             otherSales;

//         const totalBills = await prisma.bill.count({

//             where: {

//                 createdAt: {

//                     gte: shift.openedAt

//                 },

//                 isCancelled: false

//             }

//         });

//         const expectedCash =

//             shift.openingCash +

//             cashSales;

//         const cashDifference =

//             closingCash -

//             expectedCash;

//         const updatedShift = await prisma.shift.update({

//             where: {

//                 id: shift.id

//             },

//             data: {

//                 closingCash,

//                 expectedCash,

//                 cashDifference,

//                 totalSales,

//                 totalBills,

//                 cashSales,

//                 cardSales,

//                 upiSales,

//                 otherSales,

//                 closedBy: req.user.id,

//                 closedAt: new Date(),

//                 status: "CLOSED"

//             }

//         });

//         return successResponse(

//             res,

//             updatedShift,

//             "Shift closed successfully"

//         );

//     }

//     catch (error) {

//         return errorResponse(

//             res,

//             error.message

//         );

//     }

// };
// module.exports = {

//     openShift,

//     getCurrentShift,
//     closeShift

// };