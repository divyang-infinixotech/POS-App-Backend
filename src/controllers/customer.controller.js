const prisma = require("../config/prisma");

const {

    successResponse,

    errorResponse

} = require("../utils/response");

const getCustomers = async (req, res) => {

    try {

        if (!req.user.restaurantId) {
            return successResponse(
                res,
                [],
                "Customer List"
            );
        }

        const customers = await prisma.customer.findMany({

    where: {

        restaurantId: req.user.restaurantId

    },

    orderBy: [

        { type: "asc" },

        { name: "asc" }

    ]

});

        return successResponse(

            res,

            customers,

            "Customer List"

        );

    }

    catch (error) {

        return errorResponse(

            res,

            error.message

        );

    }

};

const createWalkInCustomer = async (req, res) => {

    try {

        const existing = await prisma.customer.findFirst({

           where: {

    restaurantId: req.user.restaurantId,

    type: "WALK_IN"

}

        });

        if (existing) {

            return successResponse(

                res,

                existing,

                "Walk-in Customer Already Exists"

            );

        }

        const customer = await prisma.customer.create({

            data: {
                restaurantId: req.user.restaurantId,
                name: "Walk-in Customer",

                type: "WALK_IN"

            }

        });

        return successResponse(

            res,

            customer,

            "Walk-in Customer Created",

            201

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

    getCustomers,

    createWalkInCustomer

};