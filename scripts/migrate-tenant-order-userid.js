/**
 * Backfill "userId" onto the Order table of EVERY EXISTING tenant schema
 * (additive, idempotent, non-destructive).
 *
 * Order.userId records the authenticated user who placed the order — derived
 * from the JWT in createOrder; never client-supplied. New schemas get the
 * column from TENANT_TABLES_SQL automatically; this one-off backfills the rest.
 *
 * Run: node scripts/migrate-tenant-order-userid.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

async function main() {
  // Discover tenant schemas from pg_namespace (authoritative) and fall back to
  // the Restaurant table — orphaned schemas (no Restaurant row) must still be
  // migrated so no tenant drifts.
  const nsRows = await platformPrisma.$queryRawUnsafe(
    "SELECT nspname FROM pg_namespace WHERE nspname ~ '^restaurant_[0-9]+$' ORDER BY nspname"
  );
  const schemas = nsRows.map((r) => r.nspname);
  if (schemas.length === 0) {
    console.log("No tenant schemas found. Nothing to do.");
    return;
  }

  let added = 0;
  let alreadyPresent = 0;
  let failed = 0;

  for (const schema of schemas) {
    try {
      const before = await platformPrisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = '${schema}' AND table_name = 'Order' AND column_name = 'userId'`
      );
      if (before.length > 0) {
        alreadyPresent++;
        console.log(`⏭  ${schema}: column already exists`);
        continue;
      }
      // Half-initialized schemas (created by tests, no tables) — skip quietly
      const orderTable = await platformPrisma.$queryRawUnsafe(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = '${schema}' AND table_name = 'Order'`
      );
      if (orderTable.length === 0) {
        console.log(`⏭  ${schema}: no Order table (uninitialized schema) — skipped`);
        continue;
      }
      await platformPrisma.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."Order" ADD COLUMN IF NOT EXISTS "userId" INTEGER`
      );
      const after = await platformPrisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = '${schema}' AND table_name = 'Order' AND column_name = 'userId'`
      );
      if (after.length === 0) throw new Error("column still missing after ALTER");
      added++;
      console.log(`✅ ${schema}: Order.userId added (INTEGER, nullable)`);
    } catch (err) {
      failed++;
      console.error(`❌ ${schema}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\nDone — ${schemas.length} schema(s) processed: ${added} added, ${alreadyPresent} already present, ${failed} failed.`);
  console.log("No data was modified, deleted or reset. Existing rows keep userId = NULL (pre-attribution orders).");
}

main()
  .catch((e) => { console.error("FATAL:", e.message); process.exit(1); })
  .finally(async () => { await platformPrisma.$disconnect(); });
