/*
  Warnings:

  - You are about to drop the column `status` on the `Payment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."Bill" ADD COLUMN     "balanceAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "paymentStatus" "public"."PaymentStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "public"."Payment" DROP COLUMN "status";
