-- CreateEnum
CREATE TYPE "public"."ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "public"."Shift" (
    "id" SERIAL NOT NULL,
    "shiftNo" TEXT NOT NULL,
    "openedBy" INTEGER NOT NULL,
    "closedBy" INTEGER,
    "openingCash" DOUBLE PRECISION NOT NULL,
    "closingCash" DOUBLE PRECISION,
    "expectedCash" DOUBLE PRECISION,
    "cashDifference" DOUBLE PRECISION,
    "totalSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalBills" INTEGER NOT NULL DEFAULT 0,
    "cashSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cardSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "upiSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "public"."ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shift_shiftNo_key" ON "public"."Shift"("shiftNo");
