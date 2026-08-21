-- CreateEnum
CREATE TYPE "public"."AuditModule" AS ENUM ('AUTH', 'USER', 'CATEGORY', 'MENU', 'TABLE', 'ORDER', 'KOT', 'BILL', 'PAYMENT', 'SETTINGS', 'PRINTER', 'DASHBOARD');

-- CreateEnum
CREATE TYPE "public"."AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'PRINT', 'REPRINT', 'CANCEL', 'PAYMENT', 'VIEW');

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "module" "public"."AuditModule" NOT NULL,
    "action" "public"."AuditAction" NOT NULL,
    "description" TEXT NOT NULL,
    "referenceId" INTEGER,
    "referenceNo" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
