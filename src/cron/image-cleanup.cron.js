/**
 * Orphan menu-image cleanup (local storage driver only).
 *
 * The upload flow is two-step (upload → reference → bind on save), so a user
 * who abandons the Add/Edit form can leave an unreferenced file behind. This
 * job deletes locally-stored images that:
 *   - are older than 24 hours, AND
 *   - are not referenced by any MenuItem (imagePublicId).
 *
 * Cloudinary deployments should rely on Cloudinary's own lifecycle policies.
 *
 * Iterates all active tenant schemas to check for references.
 */
const cron = require("node-cron");
const { platformPrisma } = require("../config/tenantPrisma");
const { localDriver, UPLOADS_ROOT } = require("../services/storage.service");

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const cleanupOrphanImages = async () => {
  const logger = require("../logger/logger");
  const keys = localDriver.listKeys();
  if (!keys.length) return;

  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
  const candidates = keys.filter(({ key, mtime }) => mtime < cutoff);

  // Get all active restaurants to iterate their tenant schemas
  const restaurants = await platformPrisma.restaurant.findMany({
    where: { status: "ACTIVE", tenantSchema: { not: null } },
    select: { tenantSchema: true }
  });

  let removed = 0;
  for (const { key } of candidates) {
    let referenced = 0;
    // Check if any tenant schema references this image
    for (const { tenantSchema } of restaurants) {
      try {
        const { getTenantClient } = require("../config/tenantPrisma");
        const tenantDb = getTenantClient(tenantSchema);
        const count = await tenantDb.menuItem.count({ where: { imagePublicId: key } });
        referenced += count;
        if (referenced > 0) break; // no need to check further
      } catch (err) {
        logger.warn(`Image cleanup: could not check ${tenantSchema} for ${key}: ${err.message}`);
      }
    }
    if (referenced === 0) {
      try {
        const deleted = await localDriver.remove(key);
        if (deleted) removed++;
      } catch (err) {
        logger.warn(`Image cleanup: could not remove ${key}: ${err.message}`);
      }
    }
  }
  if (removed > 0) {
    logger.info(`Image cleanup: removed ${removed} orphaned image(s)`);
  }
};

const imageCleanupJob = () => {
  cron.schedule("0 3 * * *", async () => {
    try {
      await cleanupOrphanImages();
    } catch (err) {
      console.warn("⚠ Image cleanup cron error:", err.message);
    }
  });
  // Also expose for one-off runs / tests
  return { cleanupOrphanImages, UPLOADS_ROOT };
};

module.exports = imageCleanupJob;
