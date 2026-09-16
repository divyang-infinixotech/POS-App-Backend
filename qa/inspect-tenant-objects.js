/**
 * Read-only inspection: for every tenant schema discovered from public.Restaurant,
 * report which dietary/subcategory/floor objects exist.
 * Run: node qa/inspect-tenant-objects.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

const ENUMS = ["DietaryType", "DietaryMode", "DietaryAccess"];
const COLUMNS = [
  ["MenuItem", "dietaryType"],
  ["MenuItem", "subcategoryId"],
  ["RestaurantSetting", "dietaryMode"],
  ["RestaurantSetting", "enableStaffRoster"],
  ["User", "dietaryAccess"],
];
const TABLES = ["Subcategory", "UserFloorAssignment", "UserPermission"];

async function main() {
  const restaurants = await platformPrisma.restaurant.findMany({
    where: { tenantSchema: { not: null } },
    select: { id: true, tenantSchema: true, status: true },
    orderBy: { id: "asc" },
  });
  const schemas = [...new Set(restaurants.map((r) => r.tenantSchema).filter((s) => /^restaurant_\d+$/.test(s)))];
  console.log(`Discovered ${schemas.length} tenant schema(s): ${schemas.join(", ")}\n`);

  for (const schema of schemas) {
    const enums = await platformPrisma.$queryRawUnsafe(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid
       WHERE n.nspname = $1 AND t.typname = ANY($2)`, schema, ENUMS);
    const cols = await platformPrisma.$queryRawUnsafe(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = $1 AND (table_name || '.' || column_name) = ANY($2)`, schema, COLUMNS.map((c) => c.join(".")));
    const tabs = await platformPrisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = ANY($2)`, schema, TABLES);
    const haveE = new Set(enums.map((e) => e.typname));
    const haveC = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    const haveT = new Set(tabs.map((t) => t.table_name));

    // dietaryType/isVeg mismatch check (only where dietaryType column exists)
    let mismatch = "n/a";
    if (haveC.has("MenuItem.dietaryType")) {
      try {
        const m = await platformPrisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS n FROM "${schema}"."MenuItem"
           WHERE "isVeg" IS NOT NULL AND ("isVeg" = true AND "dietaryType" <> 'VEG' OR "isVeg" = false AND "dietaryType" <> 'NON_VEG')`);
        mismatch = m[0].n;
      } catch (e) { mismatch = `ERR ${e.message.slice(0, 60)}`; }
    }
    const missingE = ENUMS.filter((e) => !haveE.has(e));
    const missingC = COLUMNS.map((c) => c.join(".")).filter((c) => !haveC.has(c));
    const missingT = TABLES.filter((t) => !haveT.has(t));
    const ok = missingE.length === 0 && missingC.length === 0 && missingT.length === 0 && mismatch === 0;
    console.log(`${schema}: ${ok ? "OK" : "INCOMPLETE"}`);
    if (missingE.length) console.log(`  missing enums:   ${missingE.join(", ")}`);
    if (missingC.length) console.log(`  missing columns: ${missingC.join(", ")}`);
    if (missingT.length) console.log(`  missing tables:  ${missingT.join(", ")}`);
    if (mismatch !== 0 && mismatch !== "n/a") console.log(`  isVeg/dietaryType mismatches: ${mismatch}`);
  }
  await platformPrisma.$disconnect();
}

main().catch((e) => { console.error("Inspection failed:", e.message); process.exit(1); });
