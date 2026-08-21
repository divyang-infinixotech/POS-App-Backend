/*
  Warnings:

  - You are about to drop the column `printerWidth` on the `RestaurantSetting` table. All the data in the column will be lost.
  - You are about to drop the `Printer` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Shift` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[restaurantId,billNo]` on the table `Bill` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,name]` on the table `Category` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,kotNo]` on the table `KOT` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,orderNo]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,paymentNo]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId]` on the table `PrinterSetting` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId]` on the table `RestaurantSetting` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,tableNo]` on the table `RestaurantTable` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `restaurantId` to the `Bill` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `Category` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `Customer` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `KOT` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `MenuItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `PrinterSetting` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `RestaurantSetting` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `RestaurantTable` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."Bill_billNo_key";

-- DropIndex
DROP INDEX "public"."Category_name_key";

-- DropIndex
DROP INDEX "public"."KOT_kotNo_key";

-- DropIndex
DROP INDEX "public"."MenuItem_barcode_key";

-- DropIndex
DROP INDEX "public"."MenuItem_sku_key";

-- DropIndex
DROP INDEX "public"."Order_orderNo_key";

-- DropIndex
DROP INDEX "public"."Payment_paymentNo_key";

-- DropIndex
DROP INDEX "public"."RestaurantTable_tableNo_key";

-- AlterTable
ALTER TABLE "public"."AuditLog" ADD COLUMN     "restaurantId" INTEGER;

-- AlterTable
ALTER TABLE "public"."Bill" ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."Category" ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."Customer" ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."KOT" ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."MenuItem" ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."PrinterSetting" ADD COLUMN     "connectionType" "public"."ConnectionType" NOT NULL DEFAULT 'USB',
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "macAddress" TEXT,
ADD COLUMN     "port" INTEGER,
ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."RestaurantSetting" DROP COLUMN "printerWidth",
ADD COLUMN     "fssaiNumber" TEXT,
ADD COLUMN     "restaurantId" INTEGER NOT NULL,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "public"."RestaurantTable" ADD COLUMN     "restaurantId" INTEGER NOT NULL;

-- DropTable
DROP TABLE "public"."Printer";

-- DropTable
DROP TABLE "public"."Shift";

-- DropEnum
DROP TYPE "public"."PaperSize";

-- DropEnum
DROP TYPE "public"."PrinterType";

-- CreateIndex
CREATE UNIQUE INDEX "Bill_restaurantId_billNo_key" ON "public"."Bill"("restaurantId", "billNo");

-- CreateIndex
CREATE UNIQUE INDEX "Category_restaurantId_name_key" ON "public"."Category"("restaurantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "KOT_restaurantId_kotNo_key" ON "public"."KOT"("restaurantId", "kotNo");

-- CreateIndex
CREATE UNIQUE INDEX "Order_restaurantId_orderNo_key" ON "public"."Order"("restaurantId", "orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_restaurantId_paymentNo_key" ON "public"."Payment"("restaurantId", "paymentNo");

-- CreateIndex
CREATE UNIQUE INDEX "PrinterSetting_restaurantId_key" ON "public"."PrinterSetting"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantSetting_restaurantId_key" ON "public"."RestaurantSetting"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTable_restaurantId_tableNo_key" ON "public"."RestaurantTable"("restaurantId", "tableNo");

-- AddForeignKey
ALTER TABLE "public"."RestaurantSetting" ADD CONSTRAINT "RestaurantSetting_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RestaurantTable" ADD CONSTRAINT "RestaurantTable_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Category" ADD CONSTRAINT "Category_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MenuItem" ADD CONSTRAINT "MenuItem_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Order" ADD CONSTRAINT "Order_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KOT" ADD CONSTRAINT "KOT_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bill" ADD CONSTRAINT "Bill_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrinterSetting" ADD CONSTRAINT "PrinterSetting_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Customer" ADD CONSTRAINT "Customer_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
