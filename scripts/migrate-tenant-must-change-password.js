/**
 * Backfill "mustChangePassword" onto the User table of EVERY EXISTING tenant
 * schema (additive, idempotent, non-destructive).
 *
 * Why: the email/onboarding feature added User.mustChangePassword to the
 * Prisma schema and public.User, but new-tenant DDL (utils/tenantSchema.js)
 * and existing tenant schemas were not updated. Prisma's User model includes
 * the field, so ANY user.update() against a tenant schema failed with:
 *   "The column `User.mustChangePassword` does not exist in the current
 *    database."
 * (e.g. PATCH /api/users/:id/password → 500 for tenant staff.)
 *
 * What it does per schema (safe for re-runs):
 *   1. ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustChangePassword"
 *      BOOLEAN NOT NULL DEFAULT false;
 *   2. report the resulting column state
 *
 * No rows are updated, deleted or reset. No migration history is touched.
 * New schemas get the column automatically from the updated TENANT_TABLES_SQL.
 *
 * Run: node scripts/migrate-tenant-must-change-password.js
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

  let added = 0;
  let alreadyPresent = 0;
  let failed = 0;

  for (const schema of schemas) {
    try {
      const before = await platformPrisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = '${schema}' AND table_name = 'User' AND column_name = 'mustChangePassword'`
      );
      if (before.length > 0) {
        alreadyPresent++;
        console.log(`⏭  ${schema}: column already exists`);
        continue;
      }
      await platformPrisma.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."User"
         ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false`
      );
      // Verify the column is actually there before counting success.
      const after = await platformPrisma.$queryRawUnsafe(
        `SELECT column_name, column_default, is_nullable FROM information_schema.columns
         WHERE table_schema = '${schema}' AND table_name = 'User' AND column_name = 'mustChangePassword'`
      );
      if (after.length === 0) throw new Error("column still missing after ALTER");
      added++;
      console.log(`✅ ${schema}: mustChangePassword added (BOOLEAN NOT NULL DEFAULT false)`);
    } catch (err) {
      failed++;
      console.error(`❌ ${schema}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\nDone — ${schemas.length} schema(s) processed: ${added} added, ${alreadyPresent} already present, ${failed} failed.`);
  console.log("No data was modified, deleted or reset. Public.User already had the column.");
}

main()
  .catch((e) => { console.error("FATAL:", e.message); process.exit(1); })
  .finally(async () => { await platformPrisma.$disconnect(); });
