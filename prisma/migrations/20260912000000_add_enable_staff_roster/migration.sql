-- AlterTable
-- Staff Roster module visibility toggle. Tenant-scoped at runtime (the real
-- RestaurantSetting rows live in each restaurant_N schema); this public-schema
-- mirror exists because the shared Prisma client maps every tenant model.
-- Default TRUE so existing restaurants keep their current Staff Roster.
ALTER TABLE "RestaurantSetting" ADD COLUMN "enableStaffRoster" BOOLEAN NOT NULL DEFAULT true;
