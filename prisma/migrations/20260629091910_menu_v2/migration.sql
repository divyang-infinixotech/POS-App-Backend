/*
  Warnings:

  - A unique constraint covering the columns `[sku]` on the table `MenuItem` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[barcode]` on the table `MenuItem` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `sku` to the `MenuItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."MenuItem" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "isVeg" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "preparationTime" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "shortName" TEXT,
ADD COLUMN     "sku" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_sku_key" ON "public"."MenuItem"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_barcode_key" ON "public"."MenuItem"("barcode");
