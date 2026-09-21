/**
 * Backfill the Discounts & Promotions tables into EVERY EXISTING tenant schema
 * (additive, idempotent, non-destructive — mirrors prisma/migrations/
 * 20260918000000_add_discounts_promotions/migration.sql, which covers new
 * schemas via TENANT_TABLES_SQL in src/utils/tenantSchema.js and the
 * public-schema mirror).
 *
 * Uses the same execMultiSQL / schemaQualifySQL helpers as tenantSchema.js so
 * multi-statement DDL avoids PostgreSQL error 42601 (Prisma extended query
 * protocol cannot run multiple commands in one prepared statement).
 *
 * Schemas that exist but are EMPTY (no tables at all — e.g. leftover
 * placeholders from onboarding) are reported and skipped; they will receive
 * the full tenant DDL (including these tables) from initializeTenantSchema
 * when the tenant is actually provisioned.
 *
 * Run: node scripts/migrate-tenant-discounts.js [--restaurant-id=N] [--dry-run]
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");
const { execMultiSQL, schemaQualifySQL } = require("../src/utils/tenantSchema");

const TABLES = ["Discount", "DiscountCategory", "DiscountProduct", "PromoCode", "OrderDiscount"];

// Idempotent refinement columns (20260919000000 migration): promoMethod,
// staffUserIds, OrderDiscount.staffUserId/staffName + staff-user index.
const REFINE_SQL = `
ALTER TABLE "Discount" ADD COLUMN IF NOT EXISTS "promoMethod" TEXT;
ALTER TABLE "Discount" ADD COLUMN IF NOT EXISTS "staffUserIds" JSONB;
ALTER TABLE "OrderDiscount" ADD COLUMN IF NOT EXISTS "staffUserId" INTEGER;
ALTER TABLE "OrderDiscount" ADD COLUMN IF NOT EXISTS "staffName" TEXT;
CREATE INDEX IF NOT EXISTS idx_orderdiscount_staffuser ON "OrderDiscount"("staffUserId");
DO $$ BEGIN
  ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_staffUserId_fkey"
    FOREIGN KEY ("staffUserId") REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
`;

const DDL = `
CREATE TABLE IF NOT EXISTS "Discount" (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type "PromotionType" NOT NULL,
  "discountValue" DOUBLE PRECISION NOT NULL,
  "maximumDiscountAmount" DOUBLE PRECISION,
  "minimumOrderAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "startDate" TIMESTAMP NOT NULL,
  "endDate" TIMESTAMP NOT NULL,
  "startTime" TEXT,
  "endTime" TEXT,
  status "DiscountStatus" NOT NULL DEFAULT 'ACTIVE',
  scope TEXT NOT NULL DEFAULT 'ENTIRE_ORDER',
  "applicableDays" INTEGER NOT NULL DEFAULT 127,
  "customerEligibility" TEXT NOT NULL DEFAULT 'EVERYONE',
  "stackable" BOOLEAN NOT NULL DEFAULT false,
  "maxDiscountsPerOrder" INTEGER NOT NULL DEFAULT 1,
  "usageLimit" INTEGER,
  "usageCount" INTEGER NOT NULL DEFAULT 0,
  "perCustomerLimit" INTEGER,
  "staffRoles" TEXT,
  "staffRequireApproval" BOOLEAN NOT NULL DEFAULT false,
  "staffRoleMaxPercent" JSONB,
  "archivedAt" TIMESTAMP,
  "createdBy" INTEGER,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "DiscountCategory" (
  id SERIAL PRIMARY KEY,
  "discountId" INTEGER NOT NULL,
  "categoryId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "DiscountProduct" (
  id SERIAL PRIMARY KEY,
  "discountId" INTEGER NOT NULL,
  "menuItemId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "PromoCode" (
  id SERIAL PRIMARY KEY,
  "discountId" INTEGER NOT NULL,
  code TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "OrderDiscount" (
  id SERIAL PRIMARY KEY,
  "orderId" INTEGER NOT NULL,
  "discountId" INTEGER,
  "promoCodeId" INTEGER,
  "discountType" TEXT NOT NULL,
  "discountName" TEXT NOT NULL,
  "discountValue" DOUBLE PRECISION NOT NULL,
  "discountAmount" DOUBLE PRECISION NOT NULL,
  "discountLabel" TEXT,
  reason TEXT,
  "appliedBy" INTEGER,
  "approvedBy" INTEGER,
  "isManual" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discountcategory_unique ON "DiscountCategory"("discountId", "categoryId");
CREATE INDEX IF NOT EXISTS idx_discountcategory_discount ON "DiscountCategory"("discountId");
CREATE INDEX IF NOT EXISTS idx_discountcategory_category ON "DiscountCategory"("categoryId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_discountproduct_unique ON "DiscountProduct"("discountId", "menuItemId");
CREATE INDEX IF NOT EXISTS idx_discountproduct_discount ON "DiscountProduct"("discountId");
CREATE INDEX IF NOT EXISTS idx_discountproduct_menu ON "DiscountProduct"("menuItemId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_promocode_code ON "PromoCode"(code);
CREATE INDEX IF NOT EXISTS idx_promocode_discount ON "PromoCode"("discountId");
CREATE INDEX IF NOT EXISTS idx_promocode_active ON "PromoCode"("isActive");
CREATE INDEX IF NOT EXISTS idx_discount_status ON "Discount"(status);
CREATE INDEX IF NOT EXISTS idx_discount_start ON "Discount"("startDate");
CREATE INDEX IF NOT EXISTS idx_discount_end ON "Discount"("endDate");
CREATE INDEX IF NOT EXISTS idx_discount_type ON "Discount"(type);
CREATE INDEX IF NOT EXISTS idx_discount_archived ON "Discount"("archivedAt");
CREATE INDEX IF NOT EXISTS idx_orderdiscount_order ON "OrderDiscount"("orderId");
CREATE INDEX IF NOT EXISTS idx_orderdiscount_discount ON "OrderDiscount"("discountId");
CREATE INDEX IF NOT EXISTS idx_orderdiscount_created ON "OrderDiscount"("createdAt");

DO $$ BEGIN
  ALTER TABLE "DiscountCategory" ADD CONSTRAINT "DiscountCategory_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "DiscountProduct" ADD CONSTRAINT "DiscountProduct_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"(id) ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
`;

// Enum types must exist before the tables that reference them. These DO $$
// blocks create the types in the current search_path (set per-schema below),
// the same pattern as TENANT_ENUMS_SQL.
const ENUMS = `
DO $$ BEGIN
  CREATE TYPE "PromotionType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'STAFF', 'PROMO_CODE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE "DiscountStatus" AS ENUM ('ACTIVE', 'SCHEDULED', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
ALTER TYPE "AuditModule" ADD VALUE IF NOT EXISTS 'DISCOUNT';
`;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyId = args.find((a) => a.startsWith("--restaurant-id="));

  // Authoritative discovery from pg_namespace, same as the other backfills
  const nsRows = await platformPrisma.$queryRawUnsafe(
    "SELECT nspname FROM pg_namespace WHERE nspname ~ '^restaurant_[0-9]+$' ORDER BY nspname"
  );
  let schemas = nsRows.map((r) => r.nspname);
  if (onlyId) {
    const wanted = `restaurant_${Number(onlyId.split("=")[1])}`;
    schemas = schemas.filter((s) => s === wanted);
  }
  if (schemas.length === 0) {
    console.log("No tenant schemas found. Nothing to do.");
    return;
  }

  let ok = 0, skipped = 0, failed = 0, empty = 0;
  for (const schema of schemas) {
    try {
      // Idempotency: skip table creation when the core table already exists,
      // but still run the refinement ALTERs (newer columns may be missing).
      const existing = await platformPrisma.$queryRawUnsafe(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = '${schema}' AND table_name = 'Discount'`
      );
      if (existing.length > 0) {
        await platformPrisma.$transaction(async (ddlTx) => {
          await ddlTx.$executeRawUnsafe(`SET search_path TO "${schema}", public`);
          await execMultiSQL(ddlTx, REFINE_SQL, `${schema}:refine`);
        });
        skipped++;
        console.log(`⏭  ${schema}: tables present — refinement columns ensured`);
        continue;
      }

      // Skip empty placeholder schemas — a real tenant always has at least the
      // Order table. Creating discount tables in a schema without its base
      // tables would fail the OrderDiscount → Order foreign key anyway.
      const hasBase = await platformPrisma.$queryRawUnsafe(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = '${schema}' AND table_name = 'Order'`
      );
      if (hasBase.length === 0) {
        empty++;
        console.log(`⏭  ${schema}: empty placeholder schema (no base tables) — skipped; will be provisioned by initializeTenantSchema`);
        continue;
      }

      if (dryRun) {
        console.log(`(dry-run) ${schema}: would create ${TABLES.join(", ")}`);
        ok++;
        continue;
      }

      // Enums first (search_path-scoped, like TENANT_ENUMS_SQL), then the
      // schema-qualified tables/indexes/FKs — one statement per prepared call.
      await platformPrisma.$transaction(async (ddlTx) => {
        await ddlTx.$executeRawUnsafe(`SET search_path TO "${schema}", public`);
        await execMultiSQL(ddlTx, ENUMS, `${schema}:enums`);
        const qualifiedTables = schemaQualifySQL(DDL, schema);
        await execMultiSQL(ddlTx, qualifiedTables, `${schema}:tables`);
      });
      ok++;
      console.log(`✅ ${schema}: created ${TABLES.join(", ")}`);
    } catch (err) {
      failed++;
      console.error(`❌ ${schema}: ${err.message.split("\n")[0]}`);
    }
  }

  console.log(
    `\nDone — ${schemas.length} schema(s): ${ok} processed, ${skipped} already present, ${empty} empty/placeholder (skipped), ${failed} failed. No data was deleted or overwritten.`
  );
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await platformPrisma.$disconnect();
  });
