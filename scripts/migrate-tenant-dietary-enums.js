/**
 * Tenant repair migration: dietary PostgreSQL enums + hierarchy/floor objects.
 *
 * Root cause fixed here: tenant schemas were created with TEXT columns for
 * dietary fields, but the Prisma client (generated from schema.prisma, run
 * with ?schema=restaurant_X) resolves enum types against the TENANT schema —
 * e.g. `restaurant_1."DietaryType"` — for MenuItem.dietaryType,
 * RestaurantSetting.dietaryMode and User.dietaryAccess. Missing tenant enums
 * made every query touching those fields fail with PostgreSQL 42704
 * ("type restaurant_X.DietaryType does not exist"), which surfaced as:
 *   GET /api/settings  → 500
 *   POST /api/menu     → 500 (42704)
 *   PUT  /api/menu/:id → 500 (42704)
 *
 * This script repairs EVERY tenant schema discovered from public.Restaurant:
 *   1. Create missing enum types (DietaryType, DietaryMode, DietaryAccess)
 *      in the TENANT schema (pg_type/pg_namespace existence check, Part 3).
 *   2. Convert TEXT columns — or columns typed against the public enum — to
 *      the tenant enum types (data preserved via ::text cast; same pattern as
 *      scripts/upgrade-tenant-enums.js).
 *   3. Backfill dietaryType from the legacy isVeg flag, then verify zero
 *      mismatches (Part 5). isVeg is kept in sync, never deleted.
 *   4. Normalize dietaryMode / dietaryAccess NULLs to VEG_AND_NON_VEG
 *      (existing restaurants keep their current effective behavior; Part 4/6).
 *   5. Verify Subcategory, UserFloorAssignment, UserPermission, the
 *      subcategoryId column, and enableStaffRoster exist (create if missing;
 *      enableStaffRoster is only added with default true — existing config
 *      is never overwritten).
 *
 * IMPORTANT: every enum reference in DDL here is schema-qualified with the
 * tenant schema. An unqualified reference would resolve to public via the
 * connection search_path and create a SECOND, distinct type — the exact
 * mismatch this script exists to remove.
 *
 * SAFE / IDEMPOTENT — safe to re-run. No data is deleted, no tables reset.
 * Run: node scripts/migrate-tenant-dietary-enums.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

const ENUM_DEFINITIONS = [
  { name: "DietaryType", values: "'VEG', 'NON_VEG'" },
  { name: "DietaryMode", values: "'VEG_ONLY', 'VEG_AND_NON_VEG'" },
  { name: "DietaryAccess", values: "'VEG_ONLY', 'VEG_AND_NON_VEG'" },
];

// Columns created as TEXT (or typed against the public enum) before the
// tenant enums existed → convert to the tenant enum types.
const ENUM_COLUMN_MAPPINGS = [
  { table: "MenuItem", column: "dietaryType", enumType: "DietaryType", default: "'VEG'" },
  { table: "RestaurantSetting", column: "dietaryMode", enumType: "DietaryMode", default: "'VEG_AND_NON_VEG'" },
  { table: "User", column: "dietaryAccess", enumType: "DietaryAccess", default: "'VEG_AND_NON_VEG'" },
];

async function enumTypeExists(client, schemaName, enumName) {
  const rows = await client.$queryRawUnsafe(
    `SELECT 1 AS ok FROM pg_type t
     JOIN pg_namespace n ON t.typnamespace = n.oid
     WHERE n.nspname = $1 AND t.typname = $2 LIMIT 1`,
    schemaName, enumName
  );
  return rows.length > 0;
}

async function getColumnType(client, schemaName, tableName, columnName) {
  const rows = await client.$queryRawUnsafe(
    `SELECT data_type, udt_name, udt_schema FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    schemaName, tableName, columnName
  );
  return rows[0] || null;
}

async function tableExists(client, schemaName, tableName) {
  const rows = await client.$queryRawUnsafe(
    `SELECT 1 AS ok FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
    schemaName, tableName
  );
  return rows.length > 0;
}

async function repairSchema(schema) {
  const exec = (sql) => platformPrisma.$executeRawUnsafe(sql);
  const actions = [];

  // ── 1. Create missing enum types IN THE TENANT SCHEMA (idempotent) ──
  for (const def of ENUM_DEFINITIONS) {
    if (await enumTypeExists(platformPrisma, schema, def.name)) continue;
    await exec(
      `DO $$ BEGIN
         CREATE TYPE "${schema}"."${def.name}" AS ENUM (${def.values});
       EXCEPTION WHEN duplicate_object THEN null; END $$;`
    );
    actions.push(`created enum ${schema}."${def.name}"`);
  }

  // ── 2. Convert columns to the TENANT enum types (preserves existing data) ──
  for (const mapping of ENUM_COLUMN_MAPPINGS) {
    const col = await getColumnType(platformPrisma, schema, mapping.table, mapping.column);
    if (col) {
      // NOTE: udt_name preserves the declared case ("DietaryType") — compare exactly.
      const isTenantEnum =
        col.data_type === "USER-DEFINED" && col.udt_name === mapping.enumType && col.udt_schema === schema;
      if (isTenantEnum) continue; // already correct — nothing to do
      if (
        col.data_type !== "text" &&
        col.data_type !== "character varying" &&
        !(col.data_type === "USER-DEFINED" && col.udt_name === mapping.enumType)
      ) {
        actions.push(`SKIP ${mapping.table}.${mapping.column}: unexpected type ${col.data_type}(${col.udt_name})`);
        continue;
      }
      // Drop the existing default first (a TEXT or other-enum default cannot
      // be cast automatically to the tenant enum).
      await exec(`ALTER TABLE "${schema}"."${mapping.table}" ALTER COLUMN "${mapping.column}" DROP DEFAULT`);
      // Normalize NULL/invalid values — only possible/needed while TEXT.
      if (col.data_type === "text" || col.data_type === "character varying") {
        if (mapping.table === "MenuItem") {
          await exec(
            `UPDATE "${schema}"."MenuItem"
             SET "dietaryType" = CASE WHEN "isVeg" THEN 'VEG' ELSE 'NON_VEG' END
             WHERE "dietaryType" IS NULL OR "dietaryType" NOT IN ('VEG', 'NON_VEG')`
          );
        } else {
          await exec(
            `UPDATE "${schema}"."${mapping.table}"
             SET "${mapping.column}" = ${mapping.default}
             WHERE "${mapping.column}" IS NULL OR "${mapping.column}" NOT IN ('VEG_ONLY', 'VEG_AND_NON_VEG')`
          );
        }
      }
      // Cast to the TENant-qualified enum type (USING text → enum), then
      // restore the default (an untyped literal coerces to the column type).
      await exec(
        `ALTER TABLE "${schema}"."${mapping.table}"
         ALTER COLUMN "${mapping.column}" TYPE "${schema}"."${mapping.enumType}"
         USING "${mapping.column}"::text::"${schema}"."${mapping.enumType}"`
      );
      await exec(
        `ALTER TABLE "${schema}"."${mapping.table}"
         ALTER COLUMN "${mapping.column}" SET DEFAULT ${mapping.default}`
      );
      actions.push(`converted ${mapping.table}.${mapping.column} ${col.udt_name} → ${schema}."${mapping.enumType}"`);
    } else {
      // Column missing entirely (older schema) — add with the tenant enum type.
      await exec(
        `ALTER TABLE "${schema}"."${mapping.table}"
         ADD COLUMN IF NOT EXISTS "${mapping.column}" "${schema}"."${mapping.enumType}" DEFAULT ${mapping.default}`
      );
      actions.push(`added ${mapping.table}.${mapping.column} (${schema}."${mapping.enumType}")`);
    }
  }

  // ── 3. Backfill dietaryType from legacy isVeg (Part 5), keep isVeg in sync ──
  const backfilled = await exec(
    `UPDATE "${schema}"."MenuItem"
     SET "dietaryType" = (CASE WHEN "isVeg" THEN 'VEG' ELSE 'NON_VEG' END)::"${schema}"."DietaryType"
     WHERE "isVeg" IS NOT NULL AND ("isVeg" = true AND "dietaryType" <> 'VEG' OR "isVeg" = false AND "dietaryType" <> 'NON_VEG')`
  );
  if (backfilled > 0) actions.push(`backfilled dietaryType from isVeg (${backfilled} row(s))`);

  // ── 4. Normalize NULL dietaryMode / dietaryAccess to the default ──
  await exec(
    `UPDATE "${schema}"."RestaurantSetting"
     SET "dietaryMode" = 'VEG_AND_NON_VEG' WHERE "dietaryMode" IS NULL`
  );
  await exec(
    `UPDATE "${schema}"."User"
     SET "dietaryAccess" = 'VEG_AND_NON_VEG' WHERE "dietaryAccess" IS NULL`
  );

  // ── 5. Hierarchy / floor / permissions / staff-roster objects ──
  const missingTables = [];
  for (const t of ["Subcategory", "UserFloorAssignment", "UserPermission"]) {
    if (!(await tableExists(platformPrisma, schema, t))) missingTables.push(t);
  }
  if (missingTables.length > 0) {
    // Reuse the canonical tenant DDL (everything is CREATE TABLE IF NOT EXISTS)
    // executed on a single transaction connection with search_path pointed at
    // the tenant schema, so bare table/type names resolve inside the tenant.
    const ts = require("../src/utils/tenantSchema");
    const ddl = ts.getTenantDDLForSchema(schema);
    await platformPrisma.$transaction(async (ddlTx) => {
      await ddlTx.$executeRawUnsafe(`SET search_path TO "${schema}"`);
      for (const stmt of ts.splitSQL(ddl)) {
        await ddlTx.$executeRawUnsafe(stmt).catch(() => null);
      }
      await ddlTx.$executeRawUnsafe(`RESET search_path`);
    });
    actions.push(`created missing table(s): ${missingTables.join(", ")}`);
  }
  // MenuItem.subcategoryId (nullable — subcategory is OPTIONAL for old items).
  const subCol = await getColumnType(platformPrisma, schema, "MenuItem", "subcategoryId");
  if (!subCol) {
    await exec(`ALTER TABLE "${schema}"."MenuItem" ADD COLUMN IF NOT EXISTS "subcategoryId" INTEGER`);
    await exec(
      `ALTER TABLE "${schema}"."MenuItem"
       ADD CONSTRAINT fk_menuitem_subcategory_${schema}
       FOREIGN KEY ("subcategoryId") REFERENCES "${schema}"."Subcategory"(id)`
    );
    actions.push("added MenuItem.subcategoryId");
  }
  // enableStaffRoster (Part 4/8): only added when missing, default true —
  // an existing configured value is never overwritten.
  const rosterCol = await getColumnType(platformPrisma, schema, "RestaurantSetting", "enableStaffRoster");
  if (!rosterCol) {
    await exec(
      `ALTER TABLE "${schema}"."RestaurantSetting"
       ADD COLUMN IF NOT EXISTS "enableStaffRoster" BOOLEAN NOT NULL DEFAULT true`
    );
    actions.push("added RestaurantSetting.enableStaffRoster (default true)");
  }

  return actions;
}

async function verifySchema(schema) {
  const problems = [];
  for (const def of ENUM_DEFINITIONS) {
    if (!(await enumTypeExists(platformPrisma, schema, def.name))) problems.push(`missing enum ${def.name}`);
  }
  for (const mapping of ENUM_COLUMN_MAPPINGS) {
    const col = await getColumnType(platformPrisma, schema, mapping.table, mapping.column);
    if (!col) {
      problems.push(`missing ${mapping.table}.${mapping.column}`);
    } else if (col.udt_name !== mapping.enumType || col.udt_schema !== schema) {
      problems.push(`${mapping.table}.${mapping.column} is ${col.udt_schema}.${col.udt_name}, expected ${schema}.${mapping.enumType}`);
    }
  }
  for (const t of ["Subcategory", "UserFloorAssignment", "UserPermission"]) {
    if (!(await tableExists(platformPrisma, schema, t))) problems.push(`missing table ${t}`);
  }
  const rosterCol = await getColumnType(platformPrisma, schema, "RestaurantSetting", "enableStaffRoster");
  if (!rosterCol) problems.push("missing RestaurantSetting.enableStaffRoster");
  // dietaryType/isVeg mismatch count (Part 22) — must be 0.
  const mism = await platformPrisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "${schema}"."MenuItem"
     WHERE "isVeg" IS NOT NULL AND ("isVeg" = true AND "dietaryType" <> 'VEG' OR "isVeg" = false AND "dietaryType" <> 'NON_VEG')`
  );
  if (mism[0].n !== 0) problems.push(`${mism[0].n} dietaryType/isVeg mismatch(es)`);
  // NULL dietary values (Part 19/22) — must be 0.
  const invalid = await platformPrisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::int FROM "${schema}"."MenuItem" WHERE "dietaryType" IS NULL) +
       (SELECT COUNT(*)::int FROM "${schema}"."RestaurantSetting" WHERE "dietaryMode" IS NULL) +
       (SELECT COUNT(*)::int FROM "${schema}"."User" WHERE "dietaryAccess" IS NULL) AS n`
  );
  if (invalid[0].n !== 0) problems.push(`${invalid[0].n} NULL dietary value(s)`);
  return problems;
}

async function main() {
  const restaurants = await platformPrisma.restaurant.findMany({
    where: { tenantSchema: { not: null } },
    select: { id: true, tenantSchema: true, status: true },
    orderBy: { id: "asc" },
  });
  const schemas = [...new Set(restaurants.map((r) => r.tenantSchema).filter((s) => /^restaurant_\d+$/.test(s)))];
  console.log(`Discovered ${schemas.length} tenant schema(s) from public.Restaurant.\n`);

  let failed = 0;
  for (const schema of schemas) {
    try {
      const actions = await repairSchema(schema);
      const problems = await verifySchema(schema);
      if (problems.length === 0) {
        console.log(`${schema}  OK${actions.length ? "  (" + actions.join("; ") + ")" : ""}`);
      } else {
        failed++;
        console.log(`${schema}  FAILED:`);
        for (const p of problems) console.log(`  - ${p}`);
      }
    } catch (err) {
      failed++;
      console.log(`${schema}  ERROR: ${err.message.split("\n").slice(0, 3).join(" ")}`);
    }
  }
  console.log(`\nDone — ${schemas.length} schema(s) processed, ${failed} failure(s). No data was deleted.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  })
  .finally(async () => {
    await platformPrisma.$disconnect();
  });
