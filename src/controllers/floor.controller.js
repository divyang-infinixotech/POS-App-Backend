// tenantDb is available as req.tenantDb (attached by auth middleware)
const { successResponse, errorResponse } = require("../utils/response");

// ─── Get All Floors ────────────────────────────────────────────────────────────
const getFloors = async (req, res) => {
  try {
    if (!req.user.restaurantId) {
      return res.json({ success: true, floors: [] });
    }
    const floors = await req.tenantDb.floor.findMany({
      where: {},
      orderBy: { sortOrder: "asc" },
    });
    res.json({ success: true, floors });
  } catch (error) {return errorResponse(res, error.message);}
};

// ─── Get Single Floor ──────────────────────────────────────────────────────────
const getFloorById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid floor ID" });
    }
    const floor = await req.tenantDb.floor.findFirst({
      where: { id },
    });
    if (!floor) {
      return res.status(404).json({ success: false, message: "Floor not found" });
    }
    res.json({ success: true, floor });
  } catch (error) {return errorResponse(res, error.message);}
};

// ─── Create Floor ───────────────────────────────────────────────────────────────
const createFloor = async (req, res) => {
  try {
    const { name, floorCode, description, isActive, sortOrder } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "Floor name is required" });
    }
    const exists = await req.tenantDb.floor.findFirst({
      where: { name },
    });
    if (exists) {
      return res.status(400).json({ success: false, message: "Floor already exists" });
    }
    const floor = await req.tenantDb.floor.create({
      data: {
        name,
        floorCode: floorCode || null,
        description: description || null,
        isActive: isActive !== undefined ? isActive : true,
        sortOrder: sortOrder || 0,
        restaurantId: req.user.restaurantId,
      },
    });
    res.status(201).json({ success: true, floor });
  } catch (error) {return errorResponse(res, error.message);}
};

// ─── Update Floor ───────────────────────────────────────────────────────────────
const updateFloor = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, floorCode, description, isActive, sortOrder } = req.body;
    const existing = await req.tenantDb.floor.findFirst({
      where: { id: Number(id) },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Floor not found" });
    }
    const data = {};
    if (name !== undefined) data.name = name;
    if (floorCode !== undefined) data.floorCode = floorCode || null;
    if (description !== undefined) data.description = description || null;
    if (isActive !== undefined) data.isActive = isActive;
    if (sortOrder !== undefined) data.sortOrder = sortOrder;
    const floor = await req.tenantDb.floor.update({
      where: { id: existing.id },
      data,
    });
    res.json({ success: true, floor });
  } catch (error) {return errorResponse(res, error.message);}
};

// ─── Delete Floor ───────────────────────────────────────────────────────────────
const deleteFloor = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.tenantDb.floor.findFirst({
      where: { id: Number(id) },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Floor not found" });
    }
    // Check if floor has tables
    const tableCount = await req.tenantDb.restaurantTable.count({
      where: { floorId: existing.id },
    });
    if (tableCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete floor. It has ${tableCount} table(s) assigned. Move or delete them first.`,
      });
    }
    await req.tenantDb.floor.delete({ where: { id: existing.id } });
    res.json({ success: true, message: "Floor deleted successfully" });
  } catch (error) {return errorResponse(res, error.message);}
};

module.exports = {
  getFloors,
  getFloorById,
  createFloor,
  updateFloor,
  deleteFloor,
};
