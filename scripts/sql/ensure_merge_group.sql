-- Ensure MergeGroup and MergeGroupTable exist in the tenant schema.
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS "MergeGroup" (
    "id" SERIAL NOT NULL,
    "restaurantId" INTEGER NOT NULL,
    "primaryOrderId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MergeGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MergeGroupTable" (
    "id" SERIAL NOT NULL,
    "mergeGroupId" INTEGER NOT NULL,
    "tableId" INTEGER NOT NULL,
    "originalOrderId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeGroupTable_pkey" PRIMARY KEY ("id")
);

-- Indexes (IF NOT EXISTS for idempotency)
CREATE INDEX IF NOT EXISTS "MergeGroup_restaurantId_idx" ON "MergeGroup"("restaurantId");
CREATE INDEX IF NOT EXISTS "MergeGroup_primaryOrderId_idx" ON "MergeGroup"("primaryOrderId");
CREATE INDEX IF NOT EXISTS "MergeGroup_status_idx" ON "MergeGroup"("status");
CREATE INDEX IF NOT EXISTS "MergeGroupTable_mergeGroupId_idx" ON "MergeGroupTable"("mergeGroupId");
CREATE INDEX IF NOT EXISTS "MergeGroupTable_tableId_idx" ON "MergeGroupTable"("tableId");
CREATE INDEX IF NOT EXISTS "MergeGroupTable_originalOrderId_idx" ON "MergeGroupTable"("originalOrderId");

-- Foreign keys (with safe existence checks)
DO $$
BEGIN
  -- MergeGroup.primaryOrderId → Order.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MergeGroup_primaryOrderId_fkey') THEN
    ALTER TABLE "MergeGroup" ADD CONSTRAINT "MergeGroup_primaryOrderId_fkey"
      FOREIGN KEY ("primaryOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- MergeGroupTable.mergeGroupId → MergeGroup.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MergeGroupTable_mergeGroupId_fkey') THEN
    ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_mergeGroupId_fkey"
      FOREIGN KEY ("mergeGroupId") REFERENCES "MergeGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- MergeGroupTable.tableId → RestaurantTable.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MergeGroupTable_tableId_fkey') THEN
    ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_tableId_fkey"
      FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- MergeGroupTable.originalOrderId → Order.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MergeGroupTable_originalOrderId_fkey') THEN
    ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_originalOrderId_fkey"
      FOREIGN KEY ("originalOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
