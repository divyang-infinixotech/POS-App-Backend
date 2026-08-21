const buildKOTTemplate = (restaurant, kot, order, items) => {

    return {

        restaurant: restaurant.restaurantName,

        kotNo: kot.kotNo,

        table: order.table.tableNo,

        orderNo: order.orderNo,

        notes: kot.notes,

        items

    };

};

module.exports = {

    buildKOTTemplate

};