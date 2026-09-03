#!/usr/bin/env node
/**
 * Verify Incremental KOT Schema
 *
 * Checks that every tenant schema has:
 *   - OrderItem.sentQuantity column
 *   - KOTItem table with correct structure
 *
 * Usage:
 *   node scripts/verify-kot-schema.js
 *   node scripts/verify-kot-schema.js --restaurant-id=5
 */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({ log: ["warn", "error"] });

const args = process.argv.slice(2);
const restaurantIdArg = args.find(a => a.startsWith("--restaurant-id="));
const SINGLE_RESTAURANT = restaurantIdArg
  ? parseInt(restaurantIdArg.split("=")[1], 10)
  : null;

async function verifySchema() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Verify Incremental KOT Schema");
  console.log("═══════════════════════════════════════════════════════════\n");

  const where = SINGLE_RESTAURANT
    ? { id: SINGLE_RESTAURANT, tenantSchema: { not: null } }
    : { deletedAt: null, tenantSchema: { not: null } };

  const restaurants = await prisma.restaurant.findMany({
    where,
    select: { id: true, name: true, tenantSchema: true },
    orderBy: { id: "asc" },
  });

  console.log(`Checking ${restaurants.length} tenant schema(s)...\n`);

  let okCount = 0;
  let fixCount = 0;
  let errCount = 0;

  for (const restaurant of restaurants) {
    const schemaName = restaurant.tenantSchema;
    process.stdout.write(`  #${restaurant.id} "${restaurant.name}" (${schemaName})... `);

    try {
      const client = new PrismaClient({
        datasources: { db: { url: `${process.env.DATABASE_URL}?schema=${schemaName}` } },
        log: ["error"],
      });

      // Check sentQuantity column
      const sentQtyCheck = await client.$queryRaw`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = ${schemaName}
          AND table_name = 'OrderItem'
          AND column_name = 'sentQuantity'
        ) AS exists
      `;
      const hasSentQty = sentQtyCheck[0]?.exists;

      // Check KOTItem table
      const kotItemCheck = await client.$queryRaw`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = ${schemaName}
          AND table_name = 'KOTItem'
        ) AS exists
      `;
      const hasKotItem = kotItemCheck[0]?.exists;

      if (hasSentQty && hasKotItem) {
        // Count KOTs without KOTItems (legacy)
        const legacyKots = await client.$queryRaw`
          SELECT COUNT(*)::int AS count
          FROM "KOT" k
          WHERE k."cancelledAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "KOTItem" ki WHERE ki."kotId" = k."id"
          )
        `;
        const legacyCount = legacyKots[0]?.count || 0;

        // Count NULL sentQuantity
        const nullSentQty = await client.$queryRaw`
          SELECT COUNT(*)::int AS count
          FROM "OrderItem"
          WHERE "sentQuantity" IS NULL
        `;
        const nullCount = nullSentQty[0]?.count || 0;

        const issues = [];
        if (legacyCount > 0) issues.push(`${legacyCount} legacy KOT(s) without KOTItems`);
        if (nullCount > 0) issues.push(`${nullCount} OrderItem(s) with NULL sentQuantity`);

        if (issues.length > 0) {
          console.log(`OK (with issues: ${issues.join(", ")})`);
        } else {
          console.log("OK ✓");
        }
        okCount++;
      } else {
        const missing = [];
        if (!hasSentQty) missing.push("sentQuantity");
        if (!hasKotItem) missing.push("KOTItem table");
        console.log(`MISSING: ${missing.join(", ")}`);
        errCount++;
      }

      await client.$disconnect();
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      errCount++;
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  ✅ OK: ${okCount}  ❌ Errors: ${errCount}  🔧 Needs Fix: ${fixCount}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("\nTo fix missing schemas, run:");
  console.log("  node scripts/tenant-migration-runner.js --sql-file=scripts/sql/ensure_incremental_kot.sql");
  console.log("  (Add --restaurant-id=N to target a single restaurant)\n");

  await prisma.$disconnect();
}

verifySchema().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
