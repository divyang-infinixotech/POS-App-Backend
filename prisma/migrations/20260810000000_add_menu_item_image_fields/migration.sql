-- Add self-hosted image storage references to MenuItem
ALTER TABLE "MenuItem" ADD COLUMN "imagePublicId" TEXT;
ALTER TABLE "MenuItem" ADD COLUMN "imageIsExternal" BOOLEAN NOT NULL DEFAULT false;
