-- Inventory Workflow Change: Deduct Stock When Order is Placed
-- Adds an idempotency guard for stock restore on order cancel/delete
-- (stock is now deducted at order placement, not at payment).
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stockRestoredAt" TIMESTAMP(3);

-- New default for stock movement type (inventory is now reserved at order placement)
ALTER TABLE "StockMovement" ALTER COLUMN "type" SET DEFAULT 'ORDER_CREATED';
