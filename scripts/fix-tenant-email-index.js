/**
 * Apply the case-insensitive staff-email index to EXISTING tenant schemas.
 *
 * New schemas get `idx_user_email_lower` from TENANT_TABLES_SQL automatically;
 * this one-off script backfills every existing schema:
 *   1. normalize existing staff emails (trim + lowercase)
 *   2. verify no case-collisions remain (reports them, changes nothing else)
 *   3. CREATE UNIQUE INDEX IF NOT EXISTS ... ON lower(email)
 *
 * Run: node scripts/fix-tenant-email-index.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

(async () => {
  const restaurants = await platformPrisma.restaurant.findMany({
    where: { tenantSchema: { not: null } },
    select: { id: true, tenantSchema: true },
  });
  console.log(`Checking ${restaurants.length} tenant schemas...`);

  let changed = 0;
  for (const r of restaurants) {
    const schema = r.tenantSchema;
    if (!/^restaurant_\d+$/.test(schema)) continue;
    try {
      // 1. Normalize (trim + lowercase) — only touches rows that differ.
      const norm = await platformPrisma.$executeRawUnsafe(
        `UPDATE "${schema}"."User" SET "email" = lower(btrim("email")) WHERE "email" IS NOT NULL AND "email" <> lower(btrim("email"))`
      );
      if (norm > 0) console.log(`  [${schema}] normalized ${norm} staff email(s)`);

      // 2. Verify no case-collisions remain BEFORE adding the index.
      const dups = await platformPrisma.$queryRawUnsafe(
        `SELECT lower("email") AS le, count(*)::int AS n, string_agg("email"::text, ', ') AS samples FROM "${schema}"."User" GROUP BY lower("email") HAVING count(*) > 1`
      );
      if (dups.length > 0) {
        console.warn(`  [${schema}] SKIPPED — case-collisions found (resolve manually):`);
        dups.forEach((d) => console.warn(`    ${d.le} x${d.n} → [${d.samples}]`));
        continue;
      }

      // 3. Add the functional unique index (idempotent).
      await platformPrisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_lower ON "${schema}"."User" (lower("email"))`
      );
      changed++;
      if (norm === 0) console.log(`  [${schema}] index verified`);
    } catch (e) {
      console.error(`  [${schema}] ERROR: ${e.message}`);
    }
  }
  console.log(`\nDone — index applied/verified on ${changed}/${restaurants.length} schemas.`);
  await platformPrisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
