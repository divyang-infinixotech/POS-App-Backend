const prisma = require("../config/prisma");
const { successResponse, errorResponse } = require("../utils/response");

const createTable = async (req, res) => {
  try {

    const { tableNo: rawTableNo, name, capacity, shape, floorId } = req.body;
    const tableNo = String(rawTableNo);

    const exists =
      await prisma.restaurantTable.findFirst({

        where: {
          restaurantId: req.user.restaurantId,
          tableNo
        }

      });

    if (exists) {
      return res.status(400).json({
        success: false,
        message: "Table already exists"
      });
    }

    const updateData = { restaurantId: req.user.restaurantId, tableNo, capacity: Number(capacity) };
    if (name !== undefined) updateData.name = name;
    if (shape !== undefined) updateData.shape = shape;
    if (floorId !== undefined) updateData.floorId = Number(floorId);

    const table = await prisma.restaurantTable.create({ data: updateData });

    res.status(201).json({
      success: true,
      table
    });

  } catch (error) {return errorResponse(res, error.message);}
};

const getTables = async (req, res) => {
  try {

    if (!req.user.restaurantId) {
      return res.json({
        success: true,
        tables: []
      });
    }

    const tables =
      await prisma.restaurantTable.findMany({
        where: {
          restaurantId: req.user.restaurantId
        },
        orderBy: {
          tableNo: "asc"
        }
      });

    res.json({
      success: true,
      tables
    });

  } catch (error) {return errorResponse(res, error.message);}
};

const updateTableStatus = async (req, res) => {

  try {

    const { id } = req.params;

    const { status } = req.body;

    const existingTable =
      await prisma.restaurantTable.findFirst({

        where: {
          id: Number(id),
          restaurantId: req.user.restaurantId
        }

      });

    if (!existingTable) {

      return res.status(404).json({

        success: false,

        message: "Table not found"

      });

    }

    const table =
      await prisma.restaurantTable.update({

        where: {
          id: existingTable.id
        },

        data: {
          status
        }

      });

    res.json({

      success: true,

      table

    });

  }

  catch (error) {return errorResponse(res, error.message);}

};
const updateTable = async (req, res) => {
  try {
    const { id } = req.params;
    const { tableNo: rawTableNo, name, capacity, shape, floorId } = req.body;
    const tableNo = rawTableNo !== undefined ? String(rawTableNo) : undefined;

    const existingTable =
      await prisma.restaurantTable.findFirst({
        where: {
          id: Number(id),
          restaurantId: req.user.restaurantId
        }
      });

    if (!existingTable) {
      return res.status(404).json({
        success: false,
        message: "Table not found"
      });
    }

    const updateData = {};
    if (tableNo !== undefined) updateData.tableNo = tableNo;
    if (name !== undefined) updateData.name = name;
    if (capacity !== undefined) updateData.capacity = Number(capacity);
    if (shape !== undefined) updateData.shape = shape;
    if (floorId !== undefined) updateData.floorId = Number(floorId);

    const table = await prisma.restaurantTable.update({
      where: { id: existingTable.id },
      data: updateData
    });

    res.json({
      success: true,
      table
    });
  } catch (error) {return errorResponse(res, error.message);}
};

const deleteTable = async (req, res) => {
  try {
    const { id } = req.params;

    const existingTable = await prisma.restaurantTable.findFirst({
      where: {
        id: Number(id),
        restaurantId: req.user.restaurantId
      }
    });

    if (!existingTable) {
      return res.status(404).json({
        success: false,
        message: "Table not found"
      });
    }

    // Check if table has active orders (scoped to restaurant)
    const activeOrders = await prisma.order.count({
      where: {
        tableId: existingTable.id,
        restaurantId: req.user.restaurantId,
        isDeleted: false,
        status: { notIn: ["COMPLETED", "CANCELLED"] }
      }
    });

    if (activeOrders > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete table with active orders. Please complete or cancel all orders first."
      });
    }

    await prisma.restaurantTable.delete({
      where: { id: existingTable.id }
    });

    res.json({
      success: true,
      message: "Table deleted successfully"
    });
  } catch (error) {return errorResponse(res, error.message);}
};

module.exports = {
  createTable,
  getTables,
  updateTableStatus,
  updateTable,
  deleteTable
};