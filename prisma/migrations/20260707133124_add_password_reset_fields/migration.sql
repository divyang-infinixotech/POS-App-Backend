/*
  Warnings:

  - You are about to drop the column `resetOtp` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `resetOtpExpiry` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."User" DROP COLUMN "resetOtp",
DROP COLUMN "resetOtpExpiry";
