-- CreateEnum
CREATE TYPE "DietaryAccess" AS ENUM ('VEG_ONLY', 'VEG_AND_NON_VEG');

-- CreateEnum
CREATE TYPE "DietaryMode" AS ENUM ('VEG_ONLY', 'VEG_AND_NON_VEG');

-- CreateEnum
CREATE TYPE "DietaryType" AS ENUM ('VEG', 'NON_VEG');

-- DropForeignKey
ALTER TABLE "KOTItem" DROP CONSTRAINT "KOTItem_menuItemId_fkey";

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "dietaryType" "DietaryType" NOT NULL DEFAULT 'VEG',
ADD COLUMN     "subcategoryId" INTEGER;

-- Preserve legacy dietary data: the column default above stamps every existing
-- row as VEG, so re-derive the real type from the existing isVeg flag
-- (isVeg=true → VEG, isVeg=false → NON_VEG). No rows are deleted or merged.
UPDATE "MenuItem" SET "dietaryType" = (CASE WHEN "isVeg" THEN 'VEG'::"DietaryType" ELSE 'NON_VEG'::"DietaryType" END)::"DietaryType";

-- AlterTable
ALTER TABLE "OrderItem" ALTER COLUMN "sentQuantity" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "RestaurantSetting" ADD COLUMN     "dietaryMode" "DietaryMode" NOT NULL DEFAULT 'VEG_AND_NON_VEG';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dietaryAccess" "DietaryAccess" NOT NULL DEFAULT 'VEG_AND_NON_VEG';

-- CreateTable
CREATE TABLE "Subcategory" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "categoryId" INTEGER NOT NULL,
    "restaurantId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subcategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermission" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subcategory_restaurantId_idx" ON "Subcategory"("restaurantId");

-- CreateIndex
CREATE INDEX "Subcategory_categoryId_idx" ON "Subcategory"("categoryId");

-- CreateIndex
CREATE INDEX "Subcategory_isActive_idx" ON "Subcategory"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Subcategory_restaurantId_categoryId_name_key" ON "Subcategory"("restaurantId", "categoryId", "name");

-- CreateIndex
CREATE INDEX "UserPermission_userId_idx" ON "UserPermission"("userId");

-- CreateIndex
CREATE INDEX "UserPermission_permissionKey_idx" ON "UserPermission"("permissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermission_userId_permissionKey_key" ON "UserPermission"("userId", "permissionKey");

-- NOTE: "Restaurant_tenantSchema_key" is intentionally NOT created here.
-- Migration 20260901000000_add_restaurant_tenant_schema already created it as a
-- partial unique index (WHERE "tenantSchema" IS NOT NULL), which matches the
-- nullable @unique column. Re-creating it would fail on name collision.

-- AddForeignKey
ALTER TABLE "Subcategory" ADD CONSTRAINT "Subcategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subcategory" ADD CONSTRAINT "Subcategory_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "Subcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KOTItem" ADD CONSTRAINT "KOTItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

