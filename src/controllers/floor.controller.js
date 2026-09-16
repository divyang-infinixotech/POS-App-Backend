// tenantDb is available as req.tenantDb (attached by auth middleware)
const { successResponse, errorResponse } = require("../utils/response");
const { getAssignedFloorIds } = require("../utils/floorAccess");

// ─── Get All Floors ────────────────────────────────────────────────────────────
const getFloors = async (req, res) => {
  try {
    if (!req.user.restaurantId) {
      return res.json({ success: true, floors: [] });
    }
    // Floor-restricted staff (with assignments) see only their floors;
    // ADMIN/MANAGER and unassigned staff see everything (unchanged).
    const assignedIds = await getAssignedFloorIds(req.tenantDb, req.user.id, req.user.role);
    const where = assignedIds === null ? {} : { id: { in: assignedIds.length ? assignedIds : [-1] } };
    const floors = await req.tenantDb.floor.findMany({
      where,
      orderBy: { sortOrder: "asc" },
    });
    // Attached assigned staff per floor (Part 11: light display only — id + name).
    let assignments = [];
    try {
      assignments = await req.tenantDb.userFloorAssignment.findMany({
        where: floors.length ? { floorId: { in: floors.map((f) => f.id) } } : { floorId: { in: [] } },
        select: { floorId: true, user: { select: { id: true, name: true, role: true } } },
      });
    } catch (e) {
      console.warn("[floors] assignment enrich skipped:", e.message);
    }
    const staffByFloor = new Map();
    for (const a of assignments) {
      if (!staffByFloor.has(a.floorId)) staffByFloor.set(a.floorId, []);
      staffByFloor.get(a.floorId).push({ id: a.user.id, name: a.user.name, role: a.user.role });
    }
    const floorsWithStaff = floors.map((f) => ({
      ...f,
      assignedStaff: staffByFloor.get(f.id) || [],
    }));
    res.json({ success: true, floors: floorsWithStaff });
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
    // Floor-restricted staff cannot fetch unassigned floors directly.
    const _assigned = await getAssignedFloorIds(req.tenantDb, req.user.id, req.user.role);
    if (_assigned !== null && !_assigned.includes(floor.id)) {
      return res.status(403).json({ success: false, message: "You are not assigned to this floor." });
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
