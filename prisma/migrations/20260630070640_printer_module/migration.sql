-- CreateTable
CREATE TABLE "public"."PrinterSetting" (
    "id" SERIAL NOT NULL,
    "printerName" TEXT NOT NULL,
    "printerWidth" INTEGER NOT NULL DEFAULT 80,
    "autoPrintBill" BOOLEAN NOT NULL DEFAULT false,
    "autoPrintKOT" BOOLEAN NOT NULL DEFAULT false,
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "showGST" BOOLEAN NOT NULL DEFAULT true,
    "showQRCode" BOOLEAN NOT NULL DEFAULT false,
    "billHeader" TEXT,
    "billFooter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrinterSetting_pkey" PRIMARY KEY ("id")
);
