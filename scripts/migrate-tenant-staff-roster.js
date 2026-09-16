/**
 * Apply the Staff Roster module-visibility toggle to EXISTING tenant schemas.
 *
 * New schemas get `"enableStaffRoster"` from TENANT_TABLES_SQL automatically;
 * this one-off script backfills every existing schema:
 *   1. add the column if missing (default TRUE — preserves current behavior)
 *   2. backfill NULLs to TRUE (rows created before the default existed)
 *   3. report the resulting value per schema
 *
 * Idempotent — safe to run repeatedly. No data is deleted or overwritten:
 * an already-configured (non-NULL) value is never changed.
 *
 * Run: node scripts/migrate-tenant-staff-roster.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

async function main() {
  const restaurants = await platformPrisma.restaurant.findMany({
    where: { tenantSchema: { not: null } },
    select: { id: true, tenantSchema: true },
    orderBy: { id: "asc" },
  });
  const schemas = restaurants.map((r) => r.tenantSchema).filter((s) => /^restaurant_\d+$/.test(s));
  if (schemas.length === 0) {
    console.log("No tenant schemas found. Nothing to do.");
    return;
  }

  for (const schema of schemas) {
    try {
      const exec = (sql) => platformPrisma.$executeRawUnsafe(sql);

      // 1. Add the column when missing (idempotent).
      await exec(
        `ALTER TABLE "${schema}"."RestaurantSetting"
         ADD COLUMN IF NOT EXISTS "enableStaffRoster" BOOLEAN NOT NULL DEFAULT true`
      );
      // 2. Normalize any NULLs (rows created before the default existed).
      await exec(
        `UPDATE "${schema}"."RestaurantSetting"
         SET "enableStaffRoster" = true
         WHERE "enableStaffRoster" IS NULL`
      );
      // 3. Report.
      const rows = await platformPrisma.$queryRawUnsafe(
        `SELECT "restaurantId", "enableStaffRoster" FROM "${schema}"."RestaurantSetting"`
      );
      for (const row of rows) {
        console.log(`✅ ${schema}: restaurantId=${row.restaurantId} enableStaffRoster=${row.enableStaffRoster}`);
      }
    } catch (err) {
      console.error(`❌ ${schema}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nDone — ${schemas.length} schema(s) processed. No data was deleted or overwritten.`);
}

main()
  .catch((e) => {
    console.error("Migration failed:", e);
    process.exitCode = 1;
  })
  .finally(() => platformPrisma.$disconnect());
