#!/usr/bin/env node
/**
 * Fix Tenant Sequences — Idempotent PostgreSQL Sequence Repair
 *
 * Discovers all restaurant tenant schemas and resets every auto-increment
 * sequence to MAX(id) + 1 so new inserts never collide with migrated rows.
 *
 * Uses raw pg_attrdef / pg_class queries instead of pg_get_serial_sequence
 * to avoid type-casting issues with Prisma's $queryRawUnsafe.
 *
 * USAGE:
 *   node scripts/fix-tenant-sequences.js
 *   node scripts/fix-tenant-sequences.js --dry-run
 *   node scripts/fix-tenant-sequences.js --verbose
 *
 * SAFETY:
 *   - Never deletes, updates, or modifies business data
 *   - Safe to run multiple times (idempotent)
 *   - Only adjusts PostgreSQL sequence values
 */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({ log: ["warn", "error"] });

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Discover all tenant schemas from the public Restaurant table.
 */
async function discoverTenantSchemas() {
  const restaurants = await prisma.restaurant.findMany({
    where: { tenantSchema: { not: null } },
    select: { id: true, name: true, tenantSchema: true },
    orderBy: { id: "asc" },
  });
  return restaurants;
}

/**
 * Check if a schema exists in PostgreSQL.
 */
async function schemaExists(schemaName) {
  const result = await prisma.$queryRawUnsafe(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) as exists`,
    schemaName
  );
  return result[0]?.exists || false;
}

/**
 * Get all tables in a given schema.
 */
async function getTablesInSchema(schemaName) {
  const result = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    schemaName
  );
  return result.map((r) => r.table_name);
}

/**
 * For a given schema, find all integer autoincrement primary-key columns
 * and their associated sequences by querying pg_attrdef + pg_class directly.
 *
 * Returns array of: { table, pkColumn, seqName, seqSchema }
 */
async function findAutoincrementColumns(schemaName) {
  // Find columns whose default is nextval('schema.seqname'::regclass)
  // The adbin is an internal representation, but pg_get_expr gives us a readable string.
  const result = await prisma.$queryRawUnsafe(`
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      a.attname AS column_name,
      s.relname AS sequence_name,
      sn.nspname AS sequence_schema
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    JOIN pg_class s ON s.oid = regexp_replace(
      pg_get_expr(ad.adbin, ad.adrelid),
      $$nextval\\('([^']+)'::regclass\\)$$,
      '\\1'
    )::regclass
    JOIN pg_namespace sn ON sn.oid = s.relnamespace
    WHERE n.nspname = $1
      AND c.relkind = 'r'
      AND a.atttypid IN (23, 20)  -- 23=int4, 20=int8
      AND pg_get_expr(ad.adbin, ad.adrelid) ~ 'nextval\\('
    ORDER BY c.relname, a.attnum
  `, schemaName);

  return result.map(r => ({
    table: r.table_name,
    pkColumn: r.column_name,
    seqName: r.sequence_name,
    seqSchema: r.sequence_schema,
    fqSequence: `${r.sequence_schema}.${r.sequence_name}`,
  }));
}

/**
 * Get current max(id) for a table column.
 */
async function getMaxId(schemaName, tableName, pkColumn) {
  const result = await prisma.$queryRawUnsafe(
    `SELECT MAX("${pkColumn}")::bigint as max_id FROM "${schemaName}"."${tableName}"`
  );
  const maxId = result[0]?.max_id;
  return maxId !== null && maxId !== undefined ? Number(maxId) : null;
}

/**
 * Get current sequence value.
 */
async function getCurrentSequenceValue(schemaName, seqName) {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT last_value, is_called FROM "${schemaName}"."${seqName}"`
    );
    if (result.length > 0) {
      return {
        lastValue: Number(result[0].last_value),
        isCalled: result[0].is_called,
      };
    }
  } catch (e) {
    // Sequence might not exist or be inaccessible
  }
  return null;
}

/**
 * Set sequence value.
 * setval(seq, value, true) => next call returns value + 1
 */
async function setSequenceValue(schemaName, seqName, value) {
  if (DRY_RUN) return;
  await prisma.$queryRawUnsafe(
    `SELECT setval('"${schemaName}"."${seqName}"', $1, true)`,
    value
  );
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Fix Tenant Sequences — PostgreSQL Auto-Increment Repair");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  Verbose: ${VERBOSE}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // 1. Discover all tenant schemas
  const restaurants = await discoverTenantSchemas();
  console.log(`Found ${restaurants.length} restaurant(s) with tenant schemas.\n`);

  let totalFixed = 0;
  let totalAlreadyOk = 0;
  let totalErrors = 0;

  for (const restaurant of restaurants) {
    const schemaName = restaurant.tenantSchema;
    console.log(`─────────────────────────────────────────────────────────`);
    console.log(`Restaurant #${restaurant.id}: "${restaurant.name}" → ${schemaName}`);
    console.log(`─────────────────────────────────────────────────────────`);

    // Verify schema exists
    const exists = await schemaExists(schemaName);
    if (!exists) {
      console.log(`  ⚠ Schema ${schemaName} does not exist — skipping\n`);
      continue;
    }

    // Find all autoincrement columns in this schema
    let autoColumns;
    try {
      autoColumns = await findAutoincrementColumns(schemaName);
    } catch (err) {
      console.error(`  ❌ Failed to discover sequences: ${err.message}`);
      totalErrors++;
      console.log("");
      continue;
    }

    if (autoColumns.length === 0) {
      console.log(`  No autoincrement columns found.\n`);
      continue;
    }

    console.log(`  Found ${autoColumns.length} autoincrement column(s).\n`);

    for (const { table, pkColumn, seqName } of autoColumns) {
      try {
        const maxId = await getMaxId(schemaName, table, pkColumn);
        const seqInfo = await getCurrentSequenceValue(schemaName, seqName);

        const maxIdStr = maxId !== null ? String(maxId) : "NULL (empty table)";
        const seqStr = seqInfo ? `${seqInfo.lastValue} (is_called=${seqInfo.isCalled})` : "unknown";

        // Target: nextval should return maxId + 1, so setval(last_value=maxId, is_called=true)
        // If table is empty, set to 0 so nextval returns 1
        const targetValue = maxId !== null ? maxId : 0;

        // Check if fix is needed
        let needsFix = false;
        if (!seqInfo) {
          needsFix = true;
        } else if (seqInfo.lastValue < targetValue) {
          needsFix = true; // Sequence is behind
        } else if (!seqInfo.isCalled && seqInfo.lastValue <= targetValue) {
          needsFix = true;
        }

        if (needsFix) {
          await setSequenceValue(schemaName, seqName, targetValue);
          const afterInfo = await getCurrentSequenceValue(schemaName, seqName);
          const finalStr = afterInfo ? `next → ${afterInfo.lastValue + 1}` : "set";

          console.log(`  ✅ ${table}.${pkColumn}`);
          console.log(`     max(id): ${maxIdStr}`);
          console.log(`     sequence: ${schemaName}.${seqName}`);
          console.log(`     was: ${seqStr}`);
          console.log(`     now: ${finalStr}`);
          totalFixed++;
        } else {
          if (VERBOSE) {
            console.log(`  ✓ ${table}.${pkColumn} — OK (max=${maxIdStr}, seq=${seqStr})`);
          }
          totalAlreadyOk++;
        }
      } catch (err) {
        console.error(`  ❌ ${table}.${pkColumn}: ${err.message}`);
        if (VERBOSE) console.error(err);
        totalErrors++;
      }
    }
    console.log("");
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ✅ Fixed:    ${totalFixed}`);
  console.log(`  ✓  OK:       ${totalAlreadyOk}`);
  console.log(`  ❌ Errors:   ${totalErrors}`);
  console.log("═══════════════════════════════════════════════════════════");

  await prisma.$disconnect();

  if (totalErrors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Script failed:", err);
  prisma.$disconnect();
  process.exit(1);
});
