-- Bill Discount Management Migration
-- Adds discount metadata fields to Bill model
-- Adds APPLY_DISCOUNT to AuditAction enum

-- Add new columns to Bill table
ALTER TABLE "Bill" 
  ADD COLUMN IF NOT EXISTS "discountType" "DiscountType",
  ADD COLUMN IF NOT EXISTS "discountValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "discountReason" TEXT,
  ADD COLUMN IF NOT EXISTS "discountedBy" INTEGER,
  ADD COLUMN IF NOT EXISTS "discountedAt" TIMESTAMP(3);

-- Add APPLY_DISCOUNT to AuditAction enum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPLY_DISCOUNT';

-- Create index for discountedBy for faster audit lookups
CREATE INDEX IF NOT EXISTS "Bill_discountedBy_idx" ON "Bill"("discountedBy");
CREATE INDEX IF NOT EXISTS "Bill_discountType_idx" ON "Bill"("discountType");
