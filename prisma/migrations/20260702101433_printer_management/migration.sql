-- CreateEnum
CREATE TYPE "public"."PrinterType" AS ENUM ('BILL', 'KITCHEN', 'BAR', 'LABEL');

-- CreateEnum
CREATE TYPE "public"."ConnectionType" AS ENUM ('USB', 'LAN', 'BLUETOOTH');

-- CreateEnum
CREATE TYPE "public"."PaperSize" AS ENUM ('MM58', 'MM80', 'A4');

-- CreateTable
CREATE TABLE "public"."Printer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "printerType" "public"."PrinterType" NOT NULL,
    "connectionType" "public"."ConnectionType" NOT NULL,
    "ipAddress" TEXT,
    "port" INTEGER,
    "macAddress" TEXT,
    "usbName" TEXT,
    "paperSize" "public"."PaperSize" NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);
