-- CreateTable
CREATE TABLE "MergeGroup" (
    "id" SERIAL NOT NULL,
    "restaurantId" INTEGER NOT NULL,
    "primaryOrderId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MergeGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MergeGroupTable" (
    "id" SERIAL NOT NULL,
    "mergeGroupId" INTEGER NOT NULL,
    "tableId" INTEGER NOT NULL,
    "originalOrderId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeGroupTable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MergeGroup_restaurantId_idx" ON "MergeGroup"("restaurantId");

-- CreateIndex
CREATE INDEX "MergeGroup_primaryOrderId_idx" ON "MergeGroup"("primaryOrderId");

-- CreateIndex
CREATE INDEX "MergeGroup_status_idx" ON "MergeGroup"("status");

-- CreateIndex
CREATE INDEX "MergeGroupTable_mergeGroupId_idx" ON "MergeGroupTable"("mergeGroupId");

-- CreateIndex
CREATE INDEX "MergeGroupTable_tableId_idx" ON "MergeGroupTable"("tableId");

-- CreateIndex
CREATE INDEX "MergeGroupTable_originalOrderId_idx" ON "MergeGroupTable"("originalOrderId");

-- AddForeignKey
ALTER TABLE "MergeGroup" ADD CONSTRAINT "MergeGroup_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeGroup" ADD CONSTRAINT "MergeGroup_primaryOrderId_fkey" FOREIGN KEY ("primaryOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_mergeGroupId_fkey" FOREIGN KEY ("mergeGroupId") REFERENCES "MergeGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_originalOrderId_fkey" FOREIGN KEY ("originalOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
