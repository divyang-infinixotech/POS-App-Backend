-- 3-mode plan system (spec §6): additive enum extension only.
-- Existing rows and enum values are untouched — RESTAURANT and BASIC_POS plans,
-- subscriptions, and business types keep working unchanged (spec §23).
--
-- QUICK_BILLING joins BASIC_POS as a separate retail-flavored basic mode;
-- six retail verticals join the BusinessType catalog the same way the
-- SUPERMARKET/GROCERY/CLOTHING migration did.

-- AlterEnum
ALTER TYPE "BusinessMode" ADD VALUE 'QUICK_BILLING';

-- AlterEnum
ALTER TYPE "BusinessType" ADD VALUE 'ELECTRONICS';
ALTER TYPE "BusinessType" ADD VALUE 'FURNITURE';
ALTER TYPE "BusinessType" ADD VALUE 'HARDWARE';
ALTER TYPE "BusinessType" ADD VALUE 'COSMETICS';
ALTER TYPE "BusinessType" ADD VALUE 'STATIONERY';
ALTER TYPE "BusinessType" ADD VALUE 'JEWELLERY';
