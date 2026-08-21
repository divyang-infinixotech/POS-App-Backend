const getPagination = (

    page = 1,

    limit = 10

) => {

    page = Number(page);

    limit = Number(limit);

    return {

        skip: (page - 1) * limit,

        take: limit

    };

};

module.exports = getPagination;