-- Order.userId — the authenticated user who placed the order (staff attribution).
-- Derivation is server-side (JWT): createOrder sets it from req.user.id.
-- The tenant Order tables get the same column via the tenant DDL +
-- scripts/migrate-tenant-order-userid.js backfill (tenant schemas are managed
-- outside prisma migrate). Additive only — no existing data touched.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "userId" INTEGER;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
