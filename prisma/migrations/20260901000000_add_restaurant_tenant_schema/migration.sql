-- AlterTable: Add tenantSchema to Restaurant for schema-per-tenant isolation
ALTER TABLE "Restaurant" ADD COLUMN "tenantSchema" TEXT;

-- Create unique index on tenantSchema (Prisma @unique)
CREATE UNIQUE INDEX "Restaurant_tenantSchema_key" ON "Restaurant"("tenantSchema") WHERE "tenantSchema" IS NOT NULL;
