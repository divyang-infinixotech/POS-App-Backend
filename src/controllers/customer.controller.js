// tenantDb is available as req.tenantDb (attached by auth middleware)

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

        const customers = await req.tenantDb.customer.findMany({

    where: {},

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

        const existing = await req.tenantDb.customer.findFirst({

           where: {

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

        const customer = await req.tenantDb.customer.create({

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