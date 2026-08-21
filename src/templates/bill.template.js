const buildBillTemplate = (restaurant, bill, order, items) => {

    return {

        restaurant: {

            name: restaurant.restaurantName,

            address: restaurant.address,

            phone: restaurant.phone,

            gst: restaurant.gstNumber

        },

        bill: {

            billNo: bill.billNo,

            date: bill.createdAt,

            subtotal: bill.subtotal,

            tax: bill.taxAmount,

            discount: bill.discount,
            discountType: bill.discountType,
            discountValue: bill.discountValue,
            discountReason: bill.discountReason,
            discountedBy: bill.discountedBy,
            discountedAt: bill.discountedAt,

            serviceCharge: bill.serviceCharge,

            roundOff: bill.roundOff,

            total: bill.grandTotal

        },

        order: {

            orderNo: order.orderNo,

            table: order.table.tableNo,

            type: order.orderType

        },

        items

    };

};

module.exports = {

    buildBillTemplate

};