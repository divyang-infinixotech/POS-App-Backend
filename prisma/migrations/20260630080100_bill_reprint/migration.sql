-- AlterTable
ALTER TABLE "public"."Bill" ADD COLUMN     "printedAt" TIMESTAMP(3),
ADD COLUMN     "reprintCount" INTEGER NOT NULL DEFAULT 0;
