-- AlterEnum
ALTER TYPE "OrderType" ADD VALUE 'COUNTER_SALE';

-- AlterTable
ALTER TABLE "Floor" ADD COLUMN     "description" TEXT,
ADD COLUMN     "floorCode" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
