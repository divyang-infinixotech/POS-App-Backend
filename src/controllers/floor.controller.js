const prisma = require("../config/prisma");
const { successResponse, errorResponse } = require("../utils/response");

// ─── Get All Floors ────────────────────────────────────────────────────────────
const getFloors = async (req, res) => {
  try {
    if (!req.user.restaurantId) {
      return res.json({ success: true, floors: [] });
    }
    const floors = await prisma.floor.findMany({
      where: { restaurantId: req.user.restaurantId },
      orderBy: { sortOrder: "asc" },
    });
    res.json({ success: true, floors });
  } catch (error) {return errorResponse(res, error.message);}
};

// ─── Get Single Floor ──────────────────────────────────────────────────────────
const getFloorById = async (req, res) => {
  try {
    const { id } = req.params;
    const floor = await prisma.floor.findFirst({
      where: { id: Number(id), restaurantId: req.user.restaurantId },
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
    const exists = await prisma.floor.findFirst({
      where: { restaurantId: req.user.restaurantId, name },
    });
    if (exists) {
      return res.status(400).json({ success: false, message: "Floor already exists" });
    }
    const floor = await prisma.floor.create({
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
    const existing = await prisma.floor.findFirst({
      where: { id: Number(id), restaurantId: req.user.restaurantId },
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
    const floor = await prisma.floor.update({
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
    const existing = await prisma.floor.findFirst({
      where: { id: Number(id), restaurantId: req.user.restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Floor not found" });
    }
    // Check if floor has tables
    const tableCount = await prisma.restaurantTable.count({
      where: { floorId: existing.id },
    });
    if (tableCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete floor. It has ${tableCount} table(s) assigned. Move or delete them first.`,
      });
    }
    await prisma.floor.delete({ where: { id: existing.id } });
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
