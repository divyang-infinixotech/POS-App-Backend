-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'PENDING_DOCUMENT_REVIEW', 'ACTIVE', 'REJECTED');

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN "onboardingStatus" "OnboardingStatus" DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE "RestaurantDocument" (
    "id" SERIAL NOT NULL,
    "restaurantId" INTEGER NOT NULL,
    "documentType" TEXT NOT NULL,
    "fileReference" TEXT,
    "originalFileName" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "uploadedBy" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedBy" INTEGER,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyAgreement" (
    "id" SERIAL NOT NULL,
    "restaurantId" INTEGER NOT NULL,
    "policyType" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "acceptedBy" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RestaurantDocument_restaurantId_idx" ON "RestaurantDocument"("restaurantId");

-- CreateIndex
CREATE INDEX "RestaurantDocument_status_idx" ON "RestaurantDocument"("status");

-- CreateIndex
CREATE INDEX "RestaurantDocument_documentType_idx" ON "RestaurantDocument"("documentType");

-- CreateIndex
CREATE INDEX "RestaurantDocument_createdAt_idx" ON "RestaurantDocument"("createdAt");

-- CreateIndex
CREATE INDEX "PolicyAgreement_restaurantId_idx" ON "PolicyAgreement"("restaurantId");

-- CreateIndex
CREATE INDEX "PolicyAgreement_policyType_idx" ON "PolicyAgreement"("policyType");

-- CreateIndex
CREATE INDEX "PolicyAgreement_acceptedBy_idx" ON "PolicyAgreement"("acceptedBy");

-- CreateIndex
CREATE INDEX "PolicyAgreement_createdAt_idx" ON "PolicyAgreement"("createdAt");

-- AddForeignKey
ALTER TABLE "RestaurantDocument" ADD CONSTRAINT "RestaurantDocument_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantDocument" ADD CONSTRAINT "RestaurantDocument_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantDocument" ADD CONSTRAINT "RestaurantDocument_verifiedBy_fkey" FOREIGN KEY ("verifiedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAgreement" ADD CONSTRAINT "PolicyAgreement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAgreement" ADD CONSTRAINT "PolicyAgreement_acceptedBy_fkey" FOREIGN KEY ("acceptedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
