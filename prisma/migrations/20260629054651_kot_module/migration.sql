-- CreateEnum
CREATE TYPE "public"."KOTStatus" AS ENUM ('PENDING', 'PREPARING', 'READY', 'SERVED');

-- CreateTable
CREATE TABLE "public"."KOT" (
    "id" SERIAL NOT NULL,
    "kotNo" TEXT NOT NULL,
    "status" "public"."KOTStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "orderId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KOT_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KOT_kotNo_key" ON "public"."KOT"("kotNo");

-- CreateIndex
CREATE UNIQUE INDEX "KOT_orderId_key" ON "public"."KOT"("orderId");

-- AddForeignKey
ALTER TABLE "public"."KOT" ADD CONSTRAINT "KOT_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
