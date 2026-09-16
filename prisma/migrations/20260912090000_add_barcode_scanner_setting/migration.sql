-- AlterTable
-- Barcode Scanner tenant toggle (Part 11). Tenant-scoped at runtime (the real
-- RestaurantSetting rows live in each restaurant_N schema); this public-schema
-- mirror exists because the shared Prisma client maps every tenant model.
-- Default FALSE = safe default: the scanner stays inactive until the restaurant
-- admin explicitly enables it (plan entitlement is still the upper limit).
ALTER TABLE "RestaurantSetting" ADD COLUMN "barcodeScannerEnabled" BOOLEAN NOT NULL DEFAULT false;
