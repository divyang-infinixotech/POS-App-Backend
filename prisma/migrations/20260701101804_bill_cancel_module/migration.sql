-- AlterTable
ALTER TABLE "public"."Bill" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" INTEGER,
ADD COLUMN     "isCancelled" BOOLEAN NOT NULL DEFAULT false;
