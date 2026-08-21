/*
  Warnings:

  - You are about to drop the column `status` on the `KOT` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."KOT" DROP COLUMN "status",
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "lastPrintedAt" TIMESTAMP(3),
ADD COLUMN     "printCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;
