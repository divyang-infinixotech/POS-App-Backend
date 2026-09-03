#!/usr/bin/env node
/**
 * Data Migration Script: Move existing restaurant data from shared public tables
 * to per-tenant PostgreSQL schemas.
 *
 * USAGE:
 *   node scripts/migrate-existing-restaurants.js [--dry-run] [--restaurant-id=123]
 *
 * WHAT IT DOES:
 *   1. Lists all restaurants in the public schema
 *   2. For each restaurant, creates a tenant schema (restaurant_{id})
 *   3. Copies data from shared public tables into the tenant schema
 *   4. Updates the Restaurant record with tenantSchema
 *   5. Does NOT drop the old shared tables (manual cleanup after verification)
 *
 * SAFETY:
 *   - Idempotent: can be run multiple times without duplicating data
 *   - --dry-run mode shows what would happen without making changes
 *   - --restaurant-id=N migrates only a single restaurant
 *   - No existing data is deleted during migration
 */
const { PrismaClient } = require("@prisma/client");
const { generateSchemaName, initializeTenantSchema, TENANT_TABLES_SQL, TENANT_INDEXES_SQL, TENANT_FKS_SQL } = require("../src/utils/tenantSchema");

const prisma = new PrismaClient({ log: ["warn", "error"] });

// ─── Parse CLI arguments ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const restaurantIdArg = args.find(a => a.startsWith("--restaurant-id="));
const SINGLE_RESTAURANT = restaurantIdArg ? parseInt(restaurantIdArg.split("=")[1], 10) : null;

// Tenant tables to migrate (public schema → tenant schema)
// Maps: public table name → columns to copy
const TENANT_TABLES = [
  { table: "RestaurantSetting", hasRestaurantId: true },
  { table: "Floor", hasRestaurantId: true },
  { table: "RestaurantTable", hasRestaurantId: true },
  { table: "Category", hasRestaurantId: true },
  { table: "MenuItem", hasRestaurantId: true },
  { table: "Customer", hasRestaurantId: true },
  { table: "Order", hasRestaurantId: true },
  { table: "OrderItem", hasRestaurantId: false, dependsOn: "Order" },
  { table: "StockMovement", hasRestaurantId: true },
  { table: "KOT", hasRestaurantId: true },
  { table: "Bill", hasRestaurantId: true },
  { table: "Payment", hasRestaurantId: true },
  { table: "PrinterSetting", hasRestaurantId: true },
  { table: "AuditLog", hasRestaurantId: true },
  { table: "Notification", hasRestaurantId: true },
];

/**
 * Check if a table exists in a given schema
 */
async function tableExists(schemaName, tableName) {
  const result = await prisma.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) as exists
  `, schemaName, tableName);
  return result[0]?.exists || false;
}

/**
 * Get row count for a table, optionally filtered by restaurantId
 */
async function getRowCount(tableName, restaurantId, inSchema = "public") {
  const schemaPrefix = inSchema === "public" ? "" : `"${inSchema}".`;
  const whereClause = restaurantId ? `WHERE "restaurantId" = ${restaurantId}` : "";
  const result = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int as count FROM ${schemaPrefix}"${tableName}" ${whereClause}`
  );
  return result[0]?.count || 0;
}

/**
 * Get column names for a table in a schema
 */
async function getTableColumns(schemaName, tableName) {
  const result = await prisma.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    ORDER BY ordinal_position
  `, schemaName, tableName);
  return result.map(r => r.column_name);
}

/**
 * Count rows in a public-schema table for a given restaurant.
 * Always queries "public" schema explicitly (never relies on search_path).
 */
async function countPublicRows(table, restaurantId) {
  if (table === "OrderItem") {
    const result = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int as count FROM "public"."${table}" WHERE "orderId" IN (SELECT id FROM "public"."Order" WHERE "restaurantId" = ${restaurantId})`
    );
    return result[0]?.count || 0;
  }
  const result = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int as count FROM "public"."${table}" WHERE "restaurantId" = ${restaurantId}`
  );
  return result[0]?.count || 0;
}

/**
 * Migrate data for one restaurant from public tables to tenant schema.
 * All source queries explicitly prefix "public" to avoid search_path confusion.
 */
async function migrateRestaurantData(restaurantId, schemaName) {
  const log = (msg) => console.log(`  [${schemaName}] ${msg}`);

  for (const { table, hasRestaurantId } of TENANT_TABLES) {
    // Check if source table exists in public schema
    const sourceExists = await tableExists("public", table);
    if (!sourceExists) {
      log(`SKIP ${table}: source table not found in public`);
      continue;
    }

    // Check if target table exists in tenant schema
    const targetExists = await tableExists(schemaName, table);
    if (!targetExists) {
      log(`SKIP ${table}: target table not found in ${schemaName}`);
      continue;
    }

    // Count rows to migrate (always from public schema)
    const count = await countPublicRows(table, restaurantId);
    if (count === 0) {
      log(`SKIP ${table}: no rows to migrate`);
      continue;
    }

    log(`Migrating ${count} rows from ${table}...`);

    // Get column names from target table
    const targetColumns = await getTableColumns(schemaName, table);
    const sourceColumns = await getTableColumns("public", table);

    // Use only columns that exist in both source and target
    const commonColumns = targetColumns.filter(c => sourceColumns.includes(c));
    if (commonColumns.length === 0) {
      log(`  WARNING: No common columns for ${table}, skipping`);
      continue;
    }

    const colsList = commonColumns.map(c => `"${c}"`).join(", ");

    // Build INSERT ... SELECT with conflict handling
    // All source queries explicitly prefix "public" schema
    let selectWhere = "";
    if (hasRestaurantId) {
      selectWhere = `WHERE "public"."${table}"."restaurantId" = ${restaurantId}`;
    } else if (table === "OrderItem") {
      selectWhere = `WHERE "public"."${table}"."orderId" IN (SELECT id FROM "public"."Order" WHERE "restaurantId" = ${restaurantId})`;
    }

    // Use ON CONFLICT DO NOTHING to handle re-runs
    const sql = `
      INSERT INTO "${schemaName}"."${table}" (${colsList})
      SELECT ${commonColumns.map(c => `"public"."${table}"."${c}"`).join(", ")}
      FROM "public"."${table}"
      ${selectWhere}
      ON CONFLICT DO NOTHING
    `;

    try {
      const result = await prisma.$executeRawUnsafe(sql);
      log(`  Migrated ${result} rows`);
    } catch (err) {
      log(`  ERROR migrating ${table}: ${err.message}`);
    }
  }
}

/**
 * Main migration function
 */
async function migrate() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Restaurant POS — Schema-per-Tenant Data Migration");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE MIGRATION"}`);
  console.log(`  Target: ${SINGLE_RESTAURANT ? `Restaurant #${SINGLE_RESTAURANT}` : "All restaurants"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (DRY_RUN) {
    console.log("⚠ DRY RUN — no changes will be made to the database.\n");
  }

  // 1. Get all restaurants
  const where = SINGLE_RESTAURANT ? { id: SINGLE_RESTAURANT } : { deletedAt: null };
  const restaurants = await prisma.restaurant.findMany({
    where,
    select: { id: true, name: true, tenantSchema: true },
    orderBy: { id: "asc" },
  });

  console.log(`Found ${restaurants.length} restaurant(s) to migrate.\n`);

  let successCount = 0;
  let errorCount = 0;
  let skipCount = 0;

  for (const restaurant of restaurants) {
    const schemaName = generateSchemaName(restaurant.id);
    console.log(`\n─────────────────────────────────────────────────────────`);
    console.log(`Restaurant #${restaurant.id}: "${restaurant.name}" → ${schemaName}`);
    console.log(`─────────────────────────────────────────────────────────`);

    // Check if already migrated
    if (restaurant.tenantSchema === schemaName) {
      console.log(`  Already has tenantSchema = ${schemaName}, checking schema...`);
      const schemaExists = await prisma.$queryRawUnsafe(
        `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) as exists`,
        schemaName
      );
      if (schemaExists[0]?.exists) {
        console.log(`  Schema ${schemaName} exists. Re-running data migration for idempotency...`);
      } else {
        console.log(`  WARNING: tenantSchema is set but schema doesn't exist. Creating...`);
      }
    }

    try {
      if (DRY_RUN) {
        // Show what would be migrated
        console.log(`  Would create schema: ${schemaName}`);
        for (const { table, hasRestaurantId } of TENANT_TABLES) {
          let count;
          if (table === "OrderItem") {
            // OrderItem has no restaurantId — filter via parent Order
            const result = await prisma.$queryRawUnsafe(
              `SELECT COUNT(*)::int as count FROM "public"."${table}" WHERE "orderId" IN (SELECT id FROM "public"."Order" WHERE "restaurantId" = ${restaurant.id})`
            );
            count = result[0]?.count || 0;
          } else {
            count = await getRowCount(table, hasRestaurantId ? restaurant.id : null);
          }
          if (count > 0) {
            console.log(`  Would migrate ${count} rows from ${table}`);
          }
        }
        skipCount++;
        continue;
      }

      // 2. Create the tenant schema with all tables
      const { client: tenantDb } = await getOrCreateTenantClient(restaurant.id, schemaName);

      // 3. Migrate data
      await migrateRestaurantData(restaurant.id, schemaName);

      // 4. Update Restaurant.tenantSchema
      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: { tenantSchema: schemaName },
      });

      console.log(`  ✅ Migration complete for ${schemaName}`);
      successCount++;
    } catch (err) {
      console.error(`  ❌ Migration failed: ${err.message}`);
      console.error(err);
      errorCount++;
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Migration Summary");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ✅ Successful: ${successCount}`);
  console.log(`  ⏭  Skipped:    ${skipCount}`);
  console.log(`  ❌ Failed:     ${errorCount}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (!DRY_RUN && successCount > 0) {
    console.log("\n⚠ IMPORTANT NEXT STEPS:");
    console.log("  1. Verify data in tenant schemas matches source data");
    console.log("  2. Run the application against the migrated data");
    console.log("  3. After verification, drop old shared tables from public schema:");
    console.log("     (Only after confirming the tenant architecture works correctly)\n");
    TENANT_TABLES.forEach(({ table }) => {
      console.log(`     DROP TABLE IF EXISTS "public"."${table}" CASCADE;`);
    });
  }

  await prisma.$disconnect();
}

// Split multi-statement SQL into individual statements for $executeRawUnsafe.
// Respects $$ delimiters (plpgsql dollar-quoting) so DO blocks stay intact.
function splitSQL(sql) {
  const stmts = [];
  let current = "";
  let inDollarQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '$' && sql[i + 1] === '$') {
      inDollarQuote = !inDollarQuote;
      current += '$$';
      i++;
    } else if (ch === ';' && !inDollarQuote) {
      const trimmed = current.trim();
      if (trimmed.length > 0) stmts.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) stmts.push(trimmed);
  return stmts;
}

// Execute a multi-statement SQL block via individual $executeRawUnsafe calls
async function execMultiSQL(client, sql) {
  const stmts = splitSQL(sql);
  for (const stmt of stmts) {
    await client.$executeRawUnsafe(stmt);
  }
}

// Create FK constraints with explicit schema-qualified table names.
// This avoids the DO $$ block's IF NOT EXISTS finding public-schema FKs and skipping creation.
async function createTenantFKs(client, schema) {
  const S = schema; // alias
  const fks = [
    `ALTER TABLE "${S}"."RestaurantTable" ADD CONSTRAINT "RestaurantTable_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "${S}"."Floor"(id) ON DELETE SET NULL ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "${S}"."Category"(id) ON DELETE RESTRICT ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."Order" ADD CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "${S}"."RestaurantTable"(id) ON DELETE SET NULL ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "${S}"."Customer"(id) ON DELETE SET NULL ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "${S}"."Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "${S}"."MenuItem"(id) ON DELETE RESTRICT ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."StockMovement" ADD CONSTRAINT "StockMovement_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "${S}"."MenuItem"(id) ON DELETE RESTRICT ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."StockMovement" ADD CONSTRAINT "StockMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "${S}"."Order"(id) ON DELETE SET NULL ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."KOT" ADD CONSTRAINT "KOT_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "${S}"."Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."Bill" ADD CONSTRAINT "Bill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "${S}"."Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE`,
    `ALTER TABLE "${S}"."Payment" ADD CONSTRAINT "Payment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "${S}"."Bill"(id) ON DELETE RESTRICT ON UPDATE CASCADE`,
  ];
  for (const sql of fks) {
    try {
      await client.$executeRawUnsafe(sql);
    } catch (err) {
      // Ignore duplicate constraint errors (idempotent re-runs)
      if (err.code !== '42710') {
        console.warn(`  FK warning: ${err.message}`);
      }
    }
  }
}

// Helper to get or create tenant client (simplified for migration script)
async function getOrCreateTenantClient(restaurantId, schemaName) {
  // Prisma 6.x with prisma.config.ts requires { url: "..." } for datasources.
  // Append ?schema=tenantSchema to the DATABASE_URL to set search_path.
  const baseUrl = process.env.DATABASE_URL;
  const separator = baseUrl.includes("?") ? "&" : "?";
  const tenantUrl = `${baseUrl}${separator}schema=${schemaName}`;
  const client = new PrismaClient({
    datasources: { db: { url: tenantUrl } },
    log: ["warn", "error"],
  });

  // Create schema if not exists
  await client.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  // Create tables — must split multi-statement SQL into individual calls
  await client.$executeRawUnsafe(`SET search_path TO "${schemaName}"`);
  await execMultiSQL(client, TENANT_TABLES_SQL);
  await execMultiSQL(client, TENANT_INDEXES_SQL);
  // Create FKs with explicit schema-qualified table names to avoid
  // resolving to the public schema tables (which would be skipped by IF NOT EXISTS).
  await createTenantFKs(client, schemaName);
  await client.$executeRawUnsafe(`SET search_path TO public`);

  return { client, schemaName };
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
