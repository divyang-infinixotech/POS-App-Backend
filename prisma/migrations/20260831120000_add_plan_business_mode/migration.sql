-- CreateEnum
CREATE TYPE "BusinessMode" AS ENUM ('BASIC_POS', 'RESTAURANT');

-- AlterTable: Add businessMode to Plan (default RESTAURANT for backward compatibility)
ALTER TABLE "Plan" ADD COLUMN "businessMode" "BusinessMode" NOT NULL DEFAULT 'RESTAURANT';

-- AlterTable: Add businessMode to Subscription (default RESTAURANT for backward compatibility)
ALTER TABLE "Subscription" ADD COLUMN "businessMode" "BusinessMode" NOT NULL DEFAULT 'RESTAURANT';
