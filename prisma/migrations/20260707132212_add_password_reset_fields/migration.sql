-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "resetOtp" TEXT,
ADD COLUMN     "resetOtpExpiry" TIMESTAMP(3);
