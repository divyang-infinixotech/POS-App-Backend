const {

    savePrinterSettings,

    getPrinterSettings,
    getBillPrintData,
    getKOTPrintData,
    reprintBill

} = require("../services/printer.service");

const {

    successResponse,

    errorResponse

} = require("../utils/response");

const saveSettings = async (req, res) => {

    try {

        const printer =

            await savePrinterSettings(req.user.restaurantId, req.body);

        return successResponse(

            res,

            printer,

            "Printer settings saved"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

const getSettings = async (req, res) => {

    try {

        const printer =

            await getPrinterSettings(req.user.restaurantId);

        return successResponse(

            res,

            printer,

            "Printer settings"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

const printBill = async (req, res) => {

    try {

        const data =

            await getBillPrintData(
                req.user.restaurantId,
                req.params.id

            );

        return successResponse(

            res,

            data,

            "Bill Print Data"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

const printKOT = async (req, res) => {

    try {

        const data = await getKOTPrintData(
            req.user.restaurantId,
            req.params.id

        );

        return successResponse(

            res,

            data,

            "KOT Print Data"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};
const printReprint = async (req, res) => {

    try {

        const data = await reprintBill(
            req.user.restaurantId,
            req.params.id

        );

        return successResponse(

            res,

            data,

            "Bill Reprint"

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

    saveSettings,

    getSettings,
    printBill,
    printKOT,
    printReprint

};