-- AddDiscountStaffTargetingAndPromoMethod
-- Discounts & Promotions — additive, non-destructive refinement.
--  * Discount.promoMethod  — PROMO_CODE grants percentage OR fixed amount
--  * Discount.staffUserIds — STAFF discounts may target specific tenant Users
--  * OrderDiscount.staffUserId / staffName — the staff member who RECEIVED a
--    staff discount, normalized (relation id) + historical name snapshot
--
-- Same schema-isolation note as the base discounts migration: these models are
-- TENANT-schema models; the public-schema statements below are the mirror the
-- shared Prisma client maps (real data lives in each restaurant_N schema,
-- which scripts/migrate-tenant-discounts.js provisions identically).

-- AlterTable: Promo code discount method (percentage vs fixed amount)
ALTER TABLE "Discount" ADD COLUMN IF NOT EXISTS "promoMethod" TEXT;

-- AlterTable: specific staff targeting for STAFF discounts (JSON array of
-- tenant User ids). NULL/empty = role-based eligibility only.
ALTER TABLE "Discount" ADD COLUMN IF NOT EXISTS "staffUserIds" JSONB;

-- AlterTable: the staff member who received an applied staff discount —
-- normalized User id + historical display snapshot (never the source of truth).
ALTER TABLE "OrderDiscount" ADD COLUMN IF NOT EXISTS "staffUserId" INTEGER;
ALTER TABLE "OrderDiscount" ADD COLUMN IF NOT EXISTS "staffName" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderDiscount_staffUserId_idx" ON "OrderDiscount"("staffUserId");

-- AddForeignKey: OrderDiscount.staffUserId → public User (platform schema).
-- onDelete: SET NULL — staff account removal must never delete order history.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderDiscount_staffUserId_fkey') THEN
    ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_staffUserId_fkey"
      FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
EXCEPTION WHEN others THEN null;
END $$;
