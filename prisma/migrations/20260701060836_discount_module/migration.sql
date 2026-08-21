-- CreateEnum
CREATE TYPE "public"."DiscountType" AS ENUM ('FLAT', 'PERCENTAGE');

-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "discountType" "public"."DiscountType",
ADD COLUMN     "discountValue" DOUBLE PRECISION NOT NULL DEFAULT 0;
