-- AlterEnum
ALTER TYPE "public"."OrderStatus" ADD VALUE 'HOLD';

-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "holdAt" TIMESTAMP(3),
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false;
