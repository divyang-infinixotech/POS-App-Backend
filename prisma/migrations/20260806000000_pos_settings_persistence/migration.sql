-- POS V1 Settings Persistence
-- Persists POS Ordering, Basic POS layout, business mode, counter-sale flag,
-- tax type, manually-created tax components, and the full UI settings snapshot
-- for every restaurant (multi-tenant, scoped by restaurantId).
-- AlterTable
ALTER TABLE "RestaurantSetting" ADD COLUMN     "businessMode" TEXT NOT NULL DEFAULT 'restaurant',
ADD COLUMN     "enableCounterSale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enablePosOrdering" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "posLayout" TEXT NOT NULL DEFAULT 'basic',
ADD COLUMN     "taxType" TEXT NOT NULL DEFAULT 'Inclusive',
ADD COLUMN     "taxesAndCharges" JSONB,
ADD COLUMN     "uiSettings" JSONB;
