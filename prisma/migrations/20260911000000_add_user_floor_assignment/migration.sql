-- CreateUserFloorAssignment
-- Staff-to-floor assignment (many-to-many, tenant-scoped at runtime — this
-- mirror table exists in the public schema only because the shared Prisma
-- client maps every tenant model; real data lives in each restaurant_N schema).
CREATE TABLE "UserFloorAssignment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "floorId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFloorAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserFloorAssignment_userId_floorId_key" ON "UserFloorAssignment"("userId", "floorId");

-- CreateIndex
CREATE INDEX "UserFloorAssignment_userId_idx" ON "UserFloorAssignment"("userId");

-- CreateIndex
CREATE INDEX "UserFloorAssignment_floorId_idx" ON "UserFloorAssignment"("floorId");

-- AddForeignKey
ALTER TABLE "UserFloorAssignment" ADD CONSTRAINT "UserFloorAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFloorAssignment" ADD CONSTRAINT "UserFloorAssignment_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
