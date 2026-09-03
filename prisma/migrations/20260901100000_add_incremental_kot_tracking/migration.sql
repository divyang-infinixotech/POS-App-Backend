-- AlterTable: Add sentQuantity to OrderItem
ALTER TABLE "OrderItem" ADD COLUMN "sentQuantity" INTEGER;

-- CreateTable: KOTItem for tracking which items (and quantities) belong to each KOT
CREATE TABLE "KOTItem" (
    "id" SERIAL NOT NULL,
    "kotId" INTEGER NOT NULL,
    "orderItemId" INTEGER NOT NULL,
    "menuItemId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KOTItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KOTItem_kotId_idx" ON "KOTItem"("kotId");
CREATE INDEX "KOTItem_orderItemId_idx" ON "KOTItem"("orderItemId");
CREATE INDEX "KOTItem_kotId_orderItemId_idx" ON "KOTItem"("kotId", "orderItemId");

-- AddForeignKey
ALTER TABLE "KOTItem" ADD CONSTRAINT "KOTItem_kotId_fkey" FOREIGN KEY ("kotId") REFERENCES "KOT"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KOTItem" ADD CONSTRAINT "KOTItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KOTItem" ADD CONSTRAINT "KOTItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON UPDATE CASCADE;

-- Backward compatibility: For existing orders that already have KOTs,
-- set sentQuantity = quantity (these items have already been sent to kitchen).
-- Orders with no KOTs get sentQuantity = 0 (nothing sent yet).
UPDATE "OrderItem" oi
SET "sentQuantity" = oi."quantity"
WHERE EXISTS (
    SELECT 1 FROM "KOT" k
    WHERE k."orderId" = oi."orderId"
    AND k."cancelledAt" IS NULL
);

-- For order items that belong to orders with NO non-cancelled KOTs, set sentQuantity = 0
UPDATE "OrderItem" oi
SET "sentQuantity" = 0
WHERE oi."sentQuantity" IS NULL;
