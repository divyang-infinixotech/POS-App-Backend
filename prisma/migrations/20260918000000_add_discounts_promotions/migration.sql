-- AddDiscountPromotions
-- Discounts & Promotions module — additive, non-destructive.
-- Existing tables, rows and totals are untouched. All new tables start empty.
--
-- NOTE: these models are TENANT-schema models. The public-schema mirror below
-- exists only because the shared Prisma client maps every tenant model
-- (same pattern as User / Category / Order / Bill / KOTItem — real data lives
-- in each restaurant_N schema, which scripts/migrate-tenant-discounts.js
-- provisions with the identical idempotent DDL).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PromotionType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'STAFF', 'PROMO_CODE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DiscountStatus" AS ENUM ('ACTIVE', 'SCHEDULED', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- AlterEnum: audit module/action catalogs gain the DISCOUNT entries
ALTER TYPE "AuditModule" ADD VALUE IF NOT EXISTS 'DISCOUNT';

-- CreateTable
CREATE TABLE IF NOT EXISTS "Discount" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "PromotionType" NOT NULL,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "maximumDiscountAmount" DOUBLE PRECISION,
    "minimumOrderAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "status" "DiscountStatus" NOT NULL DEFAULT 'ACTIVE',
    "scope" TEXT NOT NULL DEFAULT 'ENTIRE_ORDER',
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
    "archivedAt" TIMESTAMP(3),
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DiscountCategory" (
    "id" SERIAL NOT NULL,
    "discountId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DiscountProduct" (
    "id" SERIAL NOT NULL,
    "discountId" INTEGER NOT NULL,
    "menuItemId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PromoCode" (
    "id" SERIAL NOT NULL,
    "discountId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderDiscount" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "discountId" INTEGER,
    "promoCodeId" INTEGER,
    "discountType" TEXT NOT NULL,
    "discountName" TEXT NOT NULL,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "discountAmount" DOUBLE PRECISION NOT NULL,
    "discountLabel" TEXT,
    "reason" TEXT,
    "appliedBy" INTEGER,
    "approvedBy" INTEGER,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DiscountCategory_discountId_categoryId_key" ON "DiscountCategory"("discountId", "categoryId");
CREATE INDEX IF NOT EXISTS "DiscountCategory_categoryId_idx" ON "DiscountCategory"("categoryId");
CREATE INDEX IF NOT EXISTS "DiscountCategory_discountId_idx" ON "DiscountCategory"("discountId");

CREATE UNIQUE INDEX IF NOT EXISTS "DiscountProduct_discountId_menuItemId_key" ON "DiscountProduct"("discountId", "menuItemId");
CREATE INDEX IF NOT EXISTS "DiscountProduct_menuItemId_idx" ON "DiscountProduct"("menuItemId");
CREATE INDEX IF NOT EXISTS "DiscountProduct_discountId_idx" ON "DiscountProduct"("discountId");

CREATE UNIQUE INDEX IF NOT EXISTS "PromoCode_code_key" ON "PromoCode"("code");
CREATE INDEX IF NOT EXISTS "PromoCode_discountId_idx" ON "PromoCode"("discountId");
CREATE INDEX IF NOT EXISTS "PromoCode_isActive_idx" ON "PromoCode"("isActive");

CREATE INDEX IF NOT EXISTS "Discount_status_idx" ON "Discount"("status");
CREATE INDEX IF NOT EXISTS "Discount_startDate_idx" ON "Discount"("startDate");
CREATE INDEX IF NOT EXISTS "Discount_endDate_idx" ON "Discount"("endDate");
CREATE INDEX IF NOT EXISTS "Discount_type_idx" ON "Discount"("type");
CREATE INDEX IF NOT EXISTS "Discount_archivedAt_idx" ON "Discount"("archivedAt");

CREATE INDEX IF NOT EXISTS "OrderDiscount_orderId_idx" ON "OrderDiscount"("orderId");
CREATE INDEX IF NOT EXISTS "OrderDiscount_discountId_idx" ON "OrderDiscount"("discountId");
CREATE INDEX IF NOT EXISTS "OrderDiscount_createdAt_idx" ON "OrderDiscount"("createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "DiscountCategory" ADD CONSTRAINT "DiscountCategory_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "DiscountProduct" ADD CONSTRAINT "DiscountProduct_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
