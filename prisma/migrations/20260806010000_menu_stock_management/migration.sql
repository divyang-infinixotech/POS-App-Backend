-- Menu & Stock Management
-- Tracks one-time stock deduction per order (idempotency guard) and
-- append-only stock movement history for sales/restock adjustments.
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stockDeductedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" SERIAL NOT NULL,
    "restaurantId" INTEGER NOT NULL,
    "menuItemId" INTEGER NOT NULL,
    "orderId" INTEGER,
    "type" TEXT NOT NULL DEFAULT 'SALE',
    "quantity" INTEGER NOT NULL,
    "stockBefore" INTEGER,
    "stockAfter" INTEGER,
    "reference" TEXT,
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockMovement_restaurantId_idx" ON "StockMovement"("restaurantId");
CREATE INDEX "StockMovement_menuItemId_idx" ON "StockMovement"("menuItemId");
CREATE INDEX "StockMovement_orderId_idx" ON "StockMovement"("orderId");
CREATE INDEX "StockMovement_createdAt_idx" ON "StockMovement"("createdAt");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
