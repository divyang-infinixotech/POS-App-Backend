/**
 * Apply the Barcode Scanner tenant toggle (Part 11) to EXISTING tenant schemas.
 *
 * New schemas get `"barcodeScannerEnabled"` from TENANT_TABLES_SQL automatically;
 * this one-off script backfills every existing schema:
 *   1. add the column if missing (default FALSE — safe default, scanner off)
 *   2. normalize NULLs to FALSE
 *   3. report the resulting value per schema
 *
 * Idempotent — safe to run repeatedly. No data is deleted or overwritten.
 * Plan entitlement (requireFeature "barcode_scanner") still gates access on top
 * of this per-restaurant flag.
 *
 * Run: node scripts/migrate-tenant-barcode-scanner.js
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

      // 1. Add the column when missing (idempotent). Default FALSE = scanner off.
      await exec(
        `ALTER TABLE "${schema}"."RestaurantSetting"
         ADD COLUMN IF NOT EXISTS "barcodeScannerEnabled" BOOLEAN NOT NULL DEFAULT false`
      );
      // 2. Normalize any NULLs (rows created before the default existed).
      await exec(
        `UPDATE "${schema}"."RestaurantSetting"
         SET "barcodeScannerEnabled" = false
         WHERE "barcodeScannerEnabled" IS NULL`
      );
      // 3. Report.
      const rows = await platformPrisma.$queryRawUnsafe(
        `SELECT "restaurantId", "barcodeScannerEnabled" FROM "${schema}"."RestaurantSetting"`
      );
      for (const row of rows) {
        console.log(`✅ ${schema}: restaurantId=${row.restaurantId} barcodeScannerEnabled=${row.barcodeScannerEnabled}`);
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
    console.error("Fatal:", e);
    process.exit(1);
  })
  .finally(async () => {
    await platformPrisma.$disconnect();
  });
