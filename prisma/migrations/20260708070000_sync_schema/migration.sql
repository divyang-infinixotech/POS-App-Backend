-- SyncSchema: Comprehensive migration to align the database with schema.prisma
-- Detected drift between the database and the Prisma schema after 35 migrations.

-- ==============================================================================
-- 1. NEW ENUMS
-- ==============================================================================

-- PaymentGateway enum
CREATE TYPE "public"."PaymentGateway" AS ENUM ('RAZORPAY', 'CASHFREE', 'PHONEPE', 'PAYTM', 'STRIPE', 'NONE');

-- NotificationPriority enum
CREATE TYPE "public"."NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- BusinessType enum
CREATE TYPE "public"."BusinessType" AS ENUM ('RESTAURANT', 'CAFE', 'BAR', 'FOOD_TRUCK', 'CLOUD_KITCHEN', 'OTHER');

-- ==============================================================================
-- 2. ALTER EXISTING ENUMS (ADD VALUES)
-- ==============================================================================

-- PaymentStatus: add FAILED
ALTER TYPE "public"."PaymentStatus" ADD VALUE 'FAILED';

-- NotificationType: add ORDER, KITCHEN, PAYMENT, SUBSCRIPTION, SYSTEM
ALTER TYPE "public"."NotificationType" ADD VALUE 'ORDER';
ALTER TYPE "public"."NotificationType" ADD VALUE 'KITCHEN';
ALTER TYPE "public"."NotificationType" ADD VALUE 'PAYMENT';
ALTER TYPE "public"."NotificationType" ADD VALUE 'SUBSCRIPTION';
ALTER TYPE "public"."NotificationType" ADD VALUE 'SYSTEM';

-- AuditModule: add SUBSCRIPTION, CUSTOMER, FLOOR, REPORT, NOTIFICATION
ALTER TYPE "public"."AuditModule" ADD VALUE 'SUBSCRIPTION';
ALTER TYPE "public"."AuditModule" ADD VALUE 'CUSTOMER';
ALTER TYPE "public"."AuditModule" ADD VALUE 'FLOOR';
ALTER TYPE "public"."AuditModule" ADD VALUE 'REPORT';
ALTER TYPE "public"."AuditModule" ADD VALUE 'NOTIFICATION';

-- AuditAction: add REFUND
ALTER TYPE "public"."AuditAction" ADD VALUE 'REFUND';

-- CustomerType: add VIP
ALTER TYPE "public"."CustomerType" ADD VALUE 'VIP';

-- SubscriptionStatus: add SUSPENDED
ALTER TYPE "public"."SubscriptionStatus" ADD VALUE 'SUSPENDED';

-- BillStatus: add REFUNDED
ALTER TYPE "public"."BillStatus" ADD VALUE 'REFUNDED';

-- ==============================================================================
-- 3. RESTAURANT TABLE — Add missing columns
-- ==============================================================================

ALTER TABLE "public"."Restaurant"
  ADD COLUMN     "website" TEXT,
  ADD COLUMN     "supportEmail" TEXT,
  ADD COLUMN     "supportPhone" TEXT,
  ADD COLUMN     "businessType" "public"."BusinessType" NOT NULL DEFAULT 'RESTAURANT',
  ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
  ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en';

-- ==============================================================================
-- 5. RESTAURANTTABLE — Add missing columns
-- ==============================================================================

ALTER TABLE "public"."RestaurantTable"
  ADD COLUMN     "shape" TEXT NOT NULL DEFAULT 'round',
  ADD COLUMN     "floorId" INTEGER;

-- ==============================================================================
-- 6. CATEGORY — Add missing columns
-- ==============================================================================

ALTER TABLE "public"."Category"
  ADD COLUMN     "color" TEXT NOT NULL DEFAULT '#16A34A',
  ADD COLUMN     "icon" TEXT NOT NULL DEFAULT 'utensils',
  ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- ==============================================================================
-- 7. MENUITEM — Add missing columns
-- ==============================================================================

ALTER TABLE "public"."MenuItem"
  ADD COLUMN     "shortDescription" TEXT,
  ADD COLUMN     "images" jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN     "costPrice" DOUBLE PRECISION,
  ADD COLUMN     "gstPercentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN     "taxInclusive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN     "kitchenCategory" TEXT DEFAULT '',
  ADD COLUMN     "displayOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "spicyLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN     "isRecommended" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN     "currentStock" INTEGER,
  ADD COLUMN     "minStock" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN     "maxStock" INTEGER,
  ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'piece';

-- ==============================================================================
-- 8. CUSTOMER — Add missing columns
-- ==============================================================================

ALTER TABLE "public"."Customer"
  ADD COLUMN     "gstNumber" TEXT,
  ADD COLUMN     "address" TEXT,
  ADD COLUMN     "notes" TEXT,
  ADD COLUMN     "birthday" TIMESTAMP(3),
  ADD COLUMN     "anniversary" TIMESTAMP(3),
  ADD COLUMN     "totalOrders" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "totalSpent" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Drop the old unique constraint on phone alone, replace with (restaurantId, phone)
DROP INDEX IF EXISTS "public"."Customer_phone_key";
CREATE UNIQUE INDEX "Customer_restaurantId_phone_key" ON "public"."Customer"("restaurantId", "phone");

-- ==============================================================================
-- 9. ORDER — Add timestamp columns
-- ==============================================================================

ALTER TABLE "public"."Order"
  ADD COLUMN     "acceptedAt" TIMESTAMP(3),
  ADD COLUMN     "cookingStartedAt" TIMESTAMP(3),
  ADD COLUMN     "readyAt" TIMESTAMP(3),
  ADD COLUMN     "servedAt" TIMESTAMP(3),
  ADD COLUMN     "completedAt" TIMESTAMP(3);

-- ==============================================================================
-- 10. KOT — Re-add status and add timestamp columns
-- ==============================================================================

-- Re-add the status column that was previously dropped
ALTER TABLE "public"."KOT"
  ADD COLUMN     "status" "public"."KOTStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN     "acceptedAt" TIMESTAMP(3),
  ADD COLUMN     "preparingAt" TIMESTAMP(3),
  ADD COLUMN     "readyAt" TIMESTAMP(3),
  ADD COLUMN     "servedAt" TIMESTAMP(3);

-- ==============================================================================
-- 11. BILL — Add refund and updated status columns
-- ==============================================================================

ALTER TABLE "public"."Bill"
  ADD COLUMN     "refundedAt" TIMESTAMP(3),
  ADD COLUMN     "refundReason" TEXT;

-- ==============================================================================
-- 12. PAYMENT — Add all missing fields
-- ==============================================================================

ALTER TABLE "public"."Payment"
  ADD COLUMN     "status" "public"."PaymentStatus" NOT NULL DEFAULT 'PAID',
  ADD COLUMN     "gateway" "public"."PaymentGateway" NOT NULL DEFAULT 'NONE',
  ADD COLUMN     "gatewayRef" TEXT,
  ADD COLUMN     "failureReason" TEXT,
  ADD COLUMN     "refundedAt" TIMESTAMP(3),
  ADD COLUMN     "cardNumber" TEXT,
  ADD COLUMN     "cardType" TEXT,
  ADD COLUMN     "last4Digits" TEXT,
  ADD COLUMN     "approvalCode" TEXT,
  ADD COLUMN     "upiTransactionId" TEXT,
  ADD COLUMN     "upiVerifiedAt" TIMESTAMP(3);

-- ==============================================================================
-- 13. PRINTERSETTING — Add printersJson column
-- ==============================================================================

ALTER TABLE "public"."PrinterSetting"
  ADD COLUMN     "printersJson" TEXT DEFAULT '[]';

-- ==============================================================================
-- 14. RESTAURANTSETTING — Add missing columns
-- ==============================================================================

ALTER TABLE "public"."RestaurantSetting"
  ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN     "upiId" TEXT DEFAULT '';

-- ==============================================================================
-- 15. NOTIFICATION — Add priority and deepLink columns
-- ==============================================================================

ALTER TABLE "public"."Notification"
  ADD COLUMN     "priority" "public"."NotificationPriority" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN     "deepLink" TEXT;

-- ==============================================================================
-- 16. FLOOR — Create new table
-- ==============================================================================

CREATE TABLE "public"."Floor" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "restaurantId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- Floor unique constraint, indexes, and FK
CREATE UNIQUE INDEX "Floor_restaurantId_name_key" ON "public"."Floor"("restaurantId", "name");
CREATE INDEX "Floor_restaurantId_idx" ON "public"."Floor"("restaurantId");

ALTER TABLE "public"."Floor" ADD CONSTRAINT "Floor_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "public"."Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add FK from RestaurantTable.floorId -> Floor.id
ALTER TABLE "public"."RestaurantTable" ADD CONSTRAINT "RestaurantTable_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "public"."Floor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ==============================================================================
-- 17. INDEXES — Add missing indexes from schema
-- ==============================================================================

-- User indexes
CREATE INDEX IF NOT EXISTS "User_isActive_idx" ON "public"."User"("isActive");
CREATE INDEX IF NOT EXISTS "User_email_idx" ON "public"."User"("email");
CREATE INDEX IF NOT EXISTS "User_role_idx" ON "public"."User"("role");

-- RestaurantTable indexes
CREATE INDEX IF NOT EXISTS "RestaurantTable_floorId_idx" ON "public"."RestaurantTable"("floorId");
CREATE INDEX IF NOT EXISTS "RestaurantTable_status_idx" ON "public"."RestaurantTable"("status");

-- Category indexes
CREATE INDEX IF NOT EXISTS "Category_isActive_idx" ON "public"."Category"("isActive");

-- MenuItem indexes
CREATE UNIQUE INDEX IF NOT EXISTS "MenuItem_restaurantId_sku_key" ON "public"."MenuItem"("restaurantId", "sku");
CREATE INDEX IF NOT EXISTS "MenuItem_isAvailable_idx" ON "public"."MenuItem"("isAvailable");
CREATE INDEX IF NOT EXISTS "MenuItem_sku_idx" ON "public"."MenuItem"("sku");
CREATE INDEX IF NOT EXISTS "MenuItem_barcode_idx" ON "public"."MenuItem"("barcode");
CREATE INDEX IF NOT EXISTS "MenuItem_isVeg_idx" ON "public"."MenuItem"("isVeg");

-- Customer indexes
CREATE INDEX IF NOT EXISTS "Customer_phone_idx" ON "public"."Customer"("phone");
CREATE INDEX IF NOT EXISTS "Customer_email_idx" ON "public"."Customer"("email");
CREATE INDEX IF NOT EXISTS "Customer_type_idx" ON "public"."Customer"("type");

-- Order indexes
CREATE INDEX IF NOT EXISTS "Order_orderType_idx" ON "public"."Order"("orderType");

-- OrderItem indexes
CREATE INDEX IF NOT EXISTS "OrderItem_menuItemId_idx" ON "public"."OrderItem"("menuItemId");
CREATE INDEX IF NOT EXISTS "OrderItem_orderId_menuItemId_idx" ON "public"."OrderItem"("orderId", "menuItemId");

-- Payment indexes
CREATE INDEX IF NOT EXISTS "Payment_paymentMethod_idx" ON "public"."Payment"("paymentMethod");
CREATE INDEX IF NOT EXISTS "Payment_gateway_idx" ON "public"."Payment"("gateway");

-- Subscription indexes
CREATE INDEX IF NOT EXISTS "Subscription_plan_idx" ON "public"."Subscription"("plan");
CREATE INDEX IF NOT EXISTS "Subscription_status_idx" ON "public"."Subscription"("status");
CREATE INDEX IF NOT EXISTS "Subscription_expiryDate_idx" ON "public"."Subscription"("expiryDate");

-- Notification indexes
CREATE INDEX IF NOT EXISTS "Notification_type_idx" ON "public"."Notification"("type");
CREATE INDEX IF NOT EXISTS "Notification_priority_idx" ON "public"."Notification"("priority");
