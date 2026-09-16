/**
 * Tenant-schema migration: Staff Permissions + Dietary Access + Subcategories.
 *
 * Applies to EVERY existing tenant schema (restaurant_N). New tenants get the
 * same objects automatically from TENANT_TABLES_SQL in utils/tenantSchema.js.
 *
 * SAFE / IDEMPOTENT — safe to re-run:
 *   1. Adds dietaryType TEXT column, then backfills it from the existing
 *      isVeg flag (isVeg=true → VEG, isVeg=false → NON_VEG) — existing menu
 *      data is never deleted; isVeg is kept for backward compatibility.
 *   2. Adds subcategoryId (nullable — subcategory is OPTIONAL for old items).
 *   3. Creates Subcategory + UserPermission tables.
 *   4. Adds User.dietaryAccess (defaults VEG_AND_NON_VEG — existing staff
 *      keep their current access; nothing is restricted by the migration).
 *
 * Run: node scripts/migrate-tenant-permissions-dietary-subcategories.js
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

      // ── MenuItem: dietaryType + backfill from isVeg (no data loss) ──
      await exec(`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = '${schema}'
        AND table_name = 'MenuItem'
        AND column_name = 'dietaryType'
    ) THEN
      ALTER TABLE "${schema}"."MenuItem"
      ADD COLUMN "dietaryType" "${schema}"."DietaryType"
      DEFAULT 'VEG'::"${schema}"."DietaryType";
    END IF;
  END $$;
`);
      const backfilled = await exec(
  `UPDATE "${schema}"."MenuItem"
   SET "dietaryType" = CASE
     WHEN "isVeg" THEN 'VEG'::"${schema}"."DietaryType"
     ELSE 'NON_VEG'::"${schema}"."DietaryType"
   END
   WHERE "dietaryType" IS NULL
      OR ("dietaryType" = 'VEG'::"${schema}"."DietaryType" AND "isVeg" = false)`
);

      // ── MenuItem: optional subcategory link ──
      await exec(`ALTER TABLE "${schema}"."MenuItem" ADD COLUMN IF NOT EXISTS "subcategoryId" INTEGER`);

      // ── Subcategory table ──
      // NOTE: UNIQUE() columns inside CREATE TABLE are unqualified — adding
      // schema prefixes here (and stripping them with .replace) previously
      // broke the statement so the table was never created per-schema.
      await exec(`CREATE TABLE IF NOT EXISTS "${schema}"."Subcategory" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        "isActive" BOOLEAN DEFAULT true,
        "sortOrder" INTEGER DEFAULT 0,
        "categoryId" INTEGER NOT NULL,
        "restaurantId" INTEGER NOT NULL,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW(),
        UNIQUE("restaurantId", "categoryId", name)
      )`);

      // ── UserPermission table ──
      await exec(`CREATE TABLE IF NOT EXISTS "${schema}"."UserPermission" (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "permissionKey" TEXT NOT NULL,
        "enabled" BOOLEAN DEFAULT true,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW(),
        UNIQUE("userId", "permissionKey")
      )`);

      // ── User: dietaryAccess (existing staff default to full access) ──
      await exec(`ALTER TABLE "${schema}"."User" ADD COLUMN IF NOT EXISTS "dietaryAccess" TEXT DEFAULT 'VEG_AND_NON_VEG'`);

      // ── Indexes (idempotent) ──
      await exec(`CREATE INDEX IF NOT EXISTS idx_menuitem_dietary ON "${schema}"."MenuItem"("dietaryType")`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_menuitem_subcategory ON "${schema}"."MenuItem"("subcategoryId")`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_subcategory_restaurant ON "${schema}"."Subcategory"("restaurantId")`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_subcategory_category ON "${schema}"."Subcategory"("categoryId")`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_userpermission_user ON "${schema}"."UserPermission"("userId")`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_userpermission_key ON "${schema}"."UserPermission"("permissionKey")`);

      console.log(`  [${schema}] OK${backfilled > 0 ? ` — dietaryType backfilled for ${backfilled} item(s)` : ""}`);
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
