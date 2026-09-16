/**
 * Apply the restaurant-level dietary mode column to EXISTING tenant schemas.
 *
 * New schemas get `"dietaryMode"` from TENANT_TABLES_SQL automatically; this
 * one-off script backfills every existing schema:
 *   1. add the column if missing (default VEG_AND_NON_VEG — preserves behavior)
 *   2. backfill NULLs to the default
 *   3. report the resulting mode per schema
 *
 * Existing data (staff dietaryAccess, menu dietaryType/isVeg) is untouched —
 * a switch to VEG_ONLY later only changes visibility, never deletes data.
 *
 * Run: node scripts/migrate-tenant-dietary-mode.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

const DEFAULT_MODE = "VEG_AND_NON_VEG";

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
         ADD COLUMN IF NOT EXISTS "dietaryMode" TEXT NOT NULL DEFAULT '${DEFAULT_MODE}'`
      );
      // 2. Normalize any NULLs (rows created before the default existed).
      await exec(
        `UPDATE "${schema}"."RestaurantSetting"
         SET "dietaryMode" = '${DEFAULT_MODE}'
         WHERE "dietaryMode" IS NULL`
      );
      // 3. Report.
      const rows = await platformPrisma.$queryRawUnsafe(
        `SELECT "restaurantId", "dietaryMode" FROM "${schema}"."RestaurantSetting"`
      );
      for (const row of rows) {
        console.log(`✅ ${schema}: restaurantId=${row.restaurantId} dietaryMode=${row.dietaryMode}`);
      }
    } catch (err) {
      console.error(`❌ ${schema}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nDone — ${schemas.length} schema(s) processed. No data was deleted.`);
}

main()
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  })
  .finally(async () => {
    await platformPrisma.$disconnect();
  });
