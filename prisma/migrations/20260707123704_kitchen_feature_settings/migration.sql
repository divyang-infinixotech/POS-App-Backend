-- AlterTable
ALTER TABLE "public"."RestaurantSetting" ADD COLUMN     "enableKitchenDisplay" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enableKotStatusTracking" BOOLEAN NOT NULL DEFAULT false;
