/**
 * Tenant-schema migration: Staff Floor Assignment (UserFloorAssignment).
 *
 * Applies to EVERY existing tenant schema (restaurant_N). New tenants get the
 * table automatically from TENANT_TABLES_SQL in utils/tenantSchema.js.
 *
 * SAFE / IDEMPOTENT — safe to re-run:
 *   - Creates the UserFloorAssignment table only if missing.
 *   - Preserves all existing floors, tables, staff, permissions and menu data.
 *   - No backfill is performed: existing staff intentionally keep their current
 *     (unassigned = restaurant-wide) behavior until an Admin assigns floors.
 *
 * Run: node scripts/migrate-tenant-floor-assignments.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

(async () => {
  const restaurants = await platformPrisma.restaurant.findMany({
    where: { tenantSchema: { not: null } },
    select: { id: true, tenantSchema: true },
  });
  console.log(`Migrating ${restaurants.length} tenant schema(s)...`);

  let ok = 0;
  for (const r of restaurants) {
    const schema = r.tenantSchema;
    if (!/^restaurant_\d+$/.test(schema)) continue;
    try {
      const exec = (sql) => platformPrisma.$executeRawUnsafe(sql);

      await exec(`CREATE TABLE IF NOT EXISTS "${schema}"."UserFloorAssignment" (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "floorId" INTEGER NOT NULL,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        UNIQUE("userId", "floorId")
      )`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_ufa_user ON "${schema}"."UserFloorAssignment"("userId")`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_ufa_floor ON "${schema}"."UserFloorAssignment"("floorId")`);

      console.log(`  [${schema}] OK`);
      ok++;
    } catch (e) {
      console.error(`  [${schema}] ERROR: ${e.message}`);
    }
  }
  console.log(`\nDone — ${ok}/${restaurants.length} schema(s) migrated.`);
  await platformPrisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
