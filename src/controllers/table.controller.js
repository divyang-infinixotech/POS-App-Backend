// tenantDb is available as req.tenantDb (attached by auth middleware)
const { successResponse, errorResponse } = require("../utils/response");

const createTable = async (req, res) => {
  try {

    const { tableNo: rawTableNo, name, capacity, shape, floorId } = req.body;
    const tableNo = String(rawTableNo);

    const exists =
      await req.tenantDb.restaurantTable.findFirst({

        where: {
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

    const table = await req.tenantDb.restaurantTable.create({ data: updateData });

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
      await req.tenantDb.restaurantTable.findMany({
        where: {},
        orderBy: {
          tableNo: "asc"
        },
        include: {
          mergeGroups: {
            where: { mergeGroup: { status: "ACTIVE" } },
            include: {
              mergeGroup: {
                select: {
                  id: true,
                  primaryOrderId: true,
                  status: true,
                  tables: {
                    select: { tableId: true, originalOrderId: true }
                  }
                }
              }
            }
          }
        }
      });

    // Resolve table numbers for merge-group enrichment.
    // Merge state is a persisted DB relationship (MergeGroup + MergeGroupTable)
    // — it is NEVER derived from an order/table status and must survive refresh.
    const tableById = new Map(tables.map(t => [t.id, t]));

    const enrichedTables = tables.map(t => {
      const activeMerge = t.mergeGroups?.[0]?.mergeGroup || null;
      // Every table always carries the merge fields (null/empty when not merged)
      // so callers never have to guess whether a missing key means "not merged".
      const base = {
        ...t,
        mergeGroupId: null,
        isMerged: false,
        primaryOrderId: null,
        primaryTableId: null,
        primaryTableNo: null,
        isPrimaryTable: false,
        mergedTableIds: [],
        mergedTableNos: [],
      };
      if (!activeMerge) return base;

      // All tables in the group, sorted by table number for stable display.
      const members = activeMerge.tables
        .map(mgt => ({ id: mgt.tableId, no: tableById.get(mgt.tableId)?.tableNo || null }))
        .filter(m => m.no != null)
        .sort((a, b) => String(a.no).localeCompare(String(b.no), undefined, { numeric: true }));

      // The primary table is the table whose ORIGINAL order is the group's
      // primary order (MergeGroupTable.originalOrderId === MergeGroup.primaryOrderId).
      const primaryLink = activeMerge.tables.find(mgt => mgt.originalOrderId === activeMerge.primaryOrderId);
      const primaryTableId = primaryLink?.tableId ?? null;

      return {
        ...base,
        mergeGroupId: activeMerge.id,
        isMerged: true,
        primaryOrderId: activeMerge.primaryOrderId,
        primaryTableId,
        primaryTableNo: primaryTableId ? (tableById.get(primaryTableId)?.tableNo || null) : null,
        isPrimaryTable: primaryTableId === t.id,
        mergedTableIds: members.map(m => m.id),
        mergedTableNos: members.map(m => m.no),
      };
    });

    res.json({
      success: true,
      tables: enrichedTables
    });

  } catch (error) {return errorResponse(res, error.message);}
};

const updateTableStatus = async (req, res) => {

  try {

    const { id } = req.params;

    const { status } = req.body;

    const existingTable =
      await req.tenantDb.restaurantTable.findFirst({

        where: {
          id: Number(id)
        }

      });

    if (!existingTable) {

      return res.status(404).json({

        success: false,

        message: "Table not found"

      });

    }

    const table =
      await req.tenantDb.restaurantTable.update({

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
      await req.tenantDb.restaurantTable.findFirst({
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

    const table = await req.tenantDb.restaurantTable.update({
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

    const existingTable = await req.tenantDb.restaurantTable.findFirst({
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
    const activeOrders = await req.tenantDb.order.count({
      where: {
        tableId: existingTable.id,
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

    await req.tenantDb.restaurantTable.delete({
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