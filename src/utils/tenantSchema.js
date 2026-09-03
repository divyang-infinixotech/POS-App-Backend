/**
 * Tenant Schema Initialization
 *
 * Creates and initializes a PostgreSQL schema for a new restaurant tenant.
 * Uses raw SQL via Prisma's $executeRaw to create tables in the target schema.
 *
 * This module is used during:
 *   1. Restaurant onboarding (Super Admin creates a new restaurant)
 *   2. Existing restaurant migration (moving from shared tables to schema-per-tenant)
 *   3. Development/test tenant creation
 *   4. Tenant recovery
 */
const { platformPrisma } = require("../config/tenantPrisma");
const { generateSchemaName } = require("../config/tenantPrisma");

/**
 * Split a multi-statement SQL string into individual statements.
 * Correctly handles PostgreSQL $$ dollar-quoting so DO blocks stay intact.
 * Semicolons inside $$ ... $$ are never treated as statement separators.
 */
function splitSQL(sql) {
  const stmts = [];
  let current = '';
  let inDollarQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '$' && sql[i + 1] === '$') {
      inDollarQuote = !inDollarQuote;
      current += '$$';
      i++;
    } else if (ch === ';' && !inDollarQuote) {
      const trimmed = current.trim();
      if (trimmed.length > 0) stmts.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) stmts.push(trimmed);
  return stmts;
}

/**
 * Execute a multi-statement SQL block via individual $executeRawUnsafe calls.
 * This avoids PostgreSQL error 42601 (cannot insert multiple commands into
 * a prepared statement) when using Prisma's extended query protocol.
 */
async function execMultiSQL(client, sql, label) {
  const stmts = splitSQL(sql);
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    try {
      await client.$executeRawUnsafe(stmt);
    } catch (err) {
      const snippet = stmt.substring(0, 80).replace(/\n/g, ' ');
      console.error(`[TenantInit] Statement ${i + 1}/${stmts.length} failed${label ? ' (' + label + ')' : ''}: ${snippet}...`);
      console.error(`[TenantInit] Error: ${err.message}`);
      throw err;
    }
  }
}

/**
 * PostgreSQL enum types required by Prisma for tenant schemas.
 * These must be created BEFORE the tables that reference them.
 */
const TENANT_ENUMS_SQL = `
-- Order statuses
DO $$ BEGIN
  CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED', 'HOLD');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Order types
DO $$ BEGIN
  CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY', 'COUNTER_SALE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Table statuses
DO $$ BEGIN
  CREATE TYPE "TableStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Discount types
DO $$ BEGIN
  CREATE TYPE "DiscountType" AS ENUM ('FLAT', 'PERCENTAGE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- KOT statuses
DO $$ BEGIN
  CREATE TYPE "KOTStatus" AS ENUM ('PENDING', 'PREPARING', 'READY', 'SERVED', 'ACCEPTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Bill statuses
DO $$ BEGIN
  CREATE TYPE "BillStatus" AS ENUM ('UNPAID', 'PAID', 'CANCELLED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Payment methods
DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'UPI');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Payment statuses
DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'PARTIAL', 'REFUNDED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Payment gateways
DO $$ BEGIN
  CREATE TYPE "PaymentGateway" AS ENUM ('RAZORPAY', 'CASHFREE', 'PHONEPE', 'PAYTM', 'STRIPE', 'NONE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Customer types
DO $$ BEGIN
  CREATE TYPE "CustomerType" AS ENUM ('WALK_IN', 'REGULAR', 'VIP');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Audit modules
DO $$ BEGIN
  CREATE TYPE "AuditModule" AS ENUM ('AUTH', 'USER', 'CATEGORY', 'MENU', 'TABLE', 'ORDER', 'KOT', 'BILL', 'PAYMENT', 'SETTINGS', 'PRINTER', 'DASHBOARD', 'SUBSCRIPTION', 'CUSTOMER', 'FLOOR', 'REPORT', 'NOTIFICATION');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Audit actions
DO $$ BEGIN
  CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'PRINT', 'REPRINT', 'CANCEL', 'PAYMENT', 'VIEW', 'REFUND', 'APPLY_DISCOUNT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Connection types for printers
DO $$ BEGIN
  CREATE TYPE "ConnectionType" AS ENUM ('USB', 'LAN', 'BLUETOOTH');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Notification types
DO $$ BEGIN
  CREATE TYPE "NotificationType" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR', 'ORDER', 'KITCHEN', 'PAYMENT', 'SUBSCRIPTION', 'SYSTEM');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Notification priorities
DO $$ BEGIN
  CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- User roles (tenant staff only — SUPER_ADMIN/ADMIN are platform-level in public schema)
DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'SUPER_ADMIN');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
`;

/**
 * The DDL for all tenant-local tables.
 * These tables live inside each restaurant's PostgreSQL schema.
 *
 * restaurantId columns are RETAINED for business logic, reporting, and
 * cross-schema operations — but they are NOT needed for tenant isolation
 * (the PostgreSQL schema itself provides that).
 */
const TENANT_TABLES_SQL = `
-- Tenant Staff Users (operational staff: MANAGER, CASHIER, KITCHEN, WAITER)
-- The tenant schema itself identifies the restaurant — no restaurantId FK needed.
CREATE TABLE IF NOT EXISTS "User" (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "isActive" BOOLEAN DEFAULT true,
  avatar TEXT,
  phone TEXT,
  "lastLogin" TIMESTAMP,
  "passwordChangedAt" TIMESTAMP,
  "deletedAt" TIMESTAMP,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(email)
);

-- Restaurant Settings (1:1 with restaurant)
CREATE TABLE IF NOT EXISTS "RestaurantSetting" (
  id SERIAL PRIMARY KEY,
  "restaurantName" TEXT NOT NULL,
  "gstNumber" TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  logo TEXT,
  "fssaiNumber" TEXT,
  website TEXT,
  currency TEXT DEFAULT 'INR',
  timezone TEXT DEFAULT 'Asia/Kolkata',
  language TEXT DEFAULT 'en',
  "billNumberStart" INTEGER DEFAULT 1,
  "billPrefix" TEXT DEFAULT 'BILL',
  "invoicePrefix" TEXT DEFAULT 'INV',
  "kotPrefix" TEXT DEFAULT 'KOT',
  "receiptFooter" TEXT DEFAULT 'Thank You! Visit Again.',
  "roundOffEnabled" BOOLEAN DEFAULT true,
  "serviceCharge" DOUBLE PRECISION DEFAULT 0,
  "taxPercentage" DOUBLE PRECISION DEFAULT 0,
  "enableKitchenDisplay" BOOLEAN DEFAULT false,
  "enableKotStatusTracking" BOOLEAN DEFAULT false,
  "upiId" TEXT DEFAULT '',
  "enableKitchen" BOOLEAN DEFAULT true,
  "enableBilling" BOOLEAN DEFAULT true,
  "enableHoldOrders" BOOLEAN DEFAULT true,
  "enableAddItem" BOOLEAN DEFAULT true,
  "enableSplitBill" BOOLEAN DEFAULT true,
  "enableTransferTable" BOOLEAN DEFAULT true,
  "enableMergeTables" BOOLEAN DEFAULT true,
  "enableFloorManagement" BOOLEAN DEFAULT true,
  "enableReports" BOOLEAN DEFAULT true,
  "enableMenu" BOOLEAN DEFAULT true,
  "enableStock" BOOLEAN DEFAULT true,
  "enableActiveOrders" BOOLEAN DEFAULT true,
  "enableTableReservations" BOOLEAN DEFAULT false,
  "autoPrintBill" BOOLEAN DEFAULT false,
  "autoPrintKOT" BOOLEAN DEFAULT false,
  "autoGenerateKOT" BOOLEAN DEFAULT false,
  "multiplePayments" BOOLEAN DEFAULT false,
  "askCustomerBeforePrint" BOOLEAN DEFAULT false,
  "autoReleaseTable" BOOLEAN DEFAULT true,
  "enablePosOrdering" BOOLEAN DEFAULT true,
  "posLayout" TEXT DEFAULT 'basic',
  "businessMode" TEXT DEFAULT 'restaurant',
  "enableCounterSale" BOOLEAN DEFAULT false,
  "taxType" TEXT DEFAULT 'Inclusive',
  "taxesAndCharges" JSONB,
  "uiSettings" JSONB,
  "restaurantId" INTEGER NOT NULL UNIQUE,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW()
);

-- Floors
CREATE TABLE IF NOT EXISTS "Floor" (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  "floorCode" TEXT,
  description TEXT,
  "isActive" BOOLEAN DEFAULT true,
  "sortOrder" INTEGER DEFAULT 0,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", name)
);

-- Restaurant Tables
CREATE TABLE IF NOT EXISTS "RestaurantTable" (
  id SERIAL PRIMARY KEY,
  "tableNo" TEXT NOT NULL,
  name TEXT,
  capacity INTEGER NOT NULL,
  status "TableStatus" DEFAULT 'AVAILABLE',
  shape TEXT DEFAULT 'round',
  "floorId" INTEGER,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", "tableNo")
);

-- Menu Categories
CREATE TABLE IF NOT EXISTS "Category" (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT,
  color TEXT DEFAULT '#16A34A',
  icon TEXT DEFAULT 'utensils',
  "sortOrder" INTEGER DEFAULT 0,
  "isActive" BOOLEAN DEFAULT true,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", name)
);

-- Menu Items
CREATE TABLE IF NOT EXISTS "MenuItem" (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  "shortName" TEXT,
  sku TEXT,
  barcode TEXT,
  description TEXT,
  "shortDescription" TEXT,
  image TEXT,
  "imagePublicId" TEXT,
  "imageIsExternal" BOOLEAN DEFAULT false,
  images JSONB DEFAULT '[]'::jsonb,
  price DOUBLE PRECISION NOT NULL,
  "costPrice" DOUBLE PRECISION,
  "gstPercentage" DOUBLE PRECISION DEFAULT 0,
  "taxInclusive" BOOLEAN DEFAULT true,
  tax DOUBLE PRECISION DEFAULT 0,
  "preparationTime" INTEGER DEFAULT 15,
  "kitchenCategory" TEXT DEFAULT '',
  "displayOrder" INTEGER DEFAULT 0,
  "spicyLevel" INTEGER DEFAULT 0,
  "isVeg" BOOLEAN DEFAULT true,
  "isAvailable" BOOLEAN DEFAULT true,
  "isFeatured" BOOLEAN DEFAULT false,
  "isRecommended" BOOLEAN DEFAULT false,
  "currentStock" INTEGER,
  "minStock" INTEGER DEFAULT 10,
  "maxStock" INTEGER,
  "modifierOptions" TEXT,
  unit TEXT DEFAULT 'piece',
  "categoryId" INTEGER NOT NULL,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", sku)
);

-- Customers
CREATE TABLE IF NOT EXISTS "Customer" (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  "gstNumber" TEXT,
  address TEXT,
  notes TEXT,
  birthday TIMESTAMP,
  anniversary TIMESTAMP,
  type "CustomerType" DEFAULT 'WALK_IN',
  "totalOrders" INTEGER DEFAULT 0,
  "totalSpent" DOUBLE PRECISION DEFAULT 0,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", phone)
);

-- Orders
CREATE TABLE IF NOT EXISTS "Order" (
  id SERIAL PRIMARY KEY,
  "orderNo" TEXT NOT NULL,
  "orderType" "OrderType" NOT NULL,
  status "OrderStatus" DEFAULT 'PENDING',
  subtotal DOUBLE PRECISION DEFAULT 0,
  "taxAmount" DOUBLE PRECISION DEFAULT 0,
  "totalAmount" DOUBLE PRECISION DEFAULT 0,
  discount DOUBLE PRECISION DEFAULT 0,
  "discountType" "DiscountType",
  "discountValue" DOUBLE PRECISION DEFAULT 0,
  "serviceCharge" DOUBLE PRECISION DEFAULT 0,
  "roundOff" DOUBLE PRECISION DEFAULT 0,
  notes TEXT,
  "cancelReason" TEXT,
  "tableId" INTEGER,
  "customerId" INTEGER,
  "isDeleted" BOOLEAN DEFAULT false,
  "deletedAt" TIMESTAMP,
  "holdAt" TIMESTAMP,
  "cancelledAt" TIMESTAMP,
  "acceptedAt" TIMESTAMP,
  "cookingStartedAt" TIMESTAMP,
  "readyAt" TIMESTAMP,
  "servedAt" TIMESTAMP,
  "completedAt" TIMESTAMP,
  "stockDeductedAt" TIMESTAMP,
  "stockRestoredAt" TIMESTAMP,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", "orderNo")
);

-- Order Items
CREATE TABLE IF NOT EXISTS "OrderItem" (
  id SERIAL PRIMARY KEY,
  quantity INTEGER NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  tax DOUBLE PRECISION NOT NULL,
  total DOUBLE PRECISION NOT NULL,
  notes TEXT,
  "orderId" INTEGER NOT NULL,
  "menuItemId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

-- Stock Movements
CREATE TABLE IF NOT EXISTS "StockMovement" (
  id SERIAL PRIMARY KEY,
  "restaurantId" INTEGER NOT NULL,
  "menuItemId" INTEGER NOT NULL,
  "orderId" INTEGER,
  type TEXT DEFAULT 'ORDER_CREATED',  -- intentionally TEXT, not an enum
  quantity INTEGER NOT NULL,
  "stockBefore" INTEGER,
  "stockAfter" INTEGER,
  reference TEXT,
  "createdBy" INTEGER,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

-- Kitchen Order Tickets
CREATE TABLE IF NOT EXISTS "KOT" (
  id SERIAL PRIMARY KEY,
  "kotNo" TEXT NOT NULL,
  status "KOTStatus" DEFAULT 'PENDING',
  notes TEXT,
  "printCount" INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  "cancelReason" TEXT,
  "lastPrintedAt" TIMESTAMP,
  "acceptedAt" TIMESTAMP,
  "preparingAt" TIMESTAMP,
  "readyAt" TIMESTAMP,
  "servedAt" TIMESTAMP,
  "cancelledAt" TIMESTAMP,
  "orderId" INTEGER NOT NULL,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", "kotNo")
);

-- Bills
CREATE TABLE IF NOT EXISTS "Bill" (
  id SERIAL PRIMARY KEY,
  "billNo" TEXT NOT NULL,
  subtotal DOUBLE PRECISION NOT NULL,
  "taxAmount" DOUBLE PRECISION NOT NULL,
  discount DOUBLE PRECISION DEFAULT 0,
  "discountType" "DiscountType",
  "discountValue" DOUBLE PRECISION DEFAULT 0,
  "discountReason" TEXT,
  "discountedBy" INTEGER,
  "discountedAt" TIMESTAMP,
  "serviceCharge" DOUBLE PRECISION DEFAULT 0,
  "roundOff" DOUBLE PRECISION DEFAULT 0,
  "grandTotal" DOUBLE PRECISION NOT NULL,
  "paidAmount" DOUBLE PRECISION DEFAULT 0,
  "balanceAmount" DOUBLE PRECISION DEFAULT 0,
  "paymentMethod" "PaymentMethod",
  status "BillStatus" DEFAULT 'UNPAID',
  "paymentStatus" "PaymentStatus" DEFAULT 'PENDING',
  "printedAt" TIMESTAMP,
  "reprintCount" INTEGER DEFAULT 0,
  "cancelReason" TEXT,
  "cancelledAt" TIMESTAMP,
  "cancelledBy" INTEGER,
  "isCancelled" BOOLEAN DEFAULT false,
  "refundedAt" TIMESTAMP,
  "refundReason" TEXT,
  "orderId" INTEGER NOT NULL UNIQUE,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", "billNo")
);

-- Payments
CREATE TABLE IF NOT EXISTS "Payment" (
  id SERIAL PRIMARY KEY,
  "paymentNo" TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  "paymentMethod" "PaymentMethod" NOT NULL,
  status "PaymentStatus" DEFAULT 'PAID',
  gateway "PaymentGateway" DEFAULT 'NONE',
  "transactionId" TEXT,
  "gatewayRef" TEXT,
  "failureReason" TEXT,
  notes TEXT,
  "createdBy" INTEGER,
  "refundedAt" TIMESTAMP,
  "cardNumber" TEXT,
  "cardType" TEXT,
  "last4Digits" TEXT,
  "approvalCode" TEXT,
  "upiTransactionId" TEXT,
  "upiVerifiedAt" TIMESTAMP,
  "billId" INTEGER NOT NULL,
  "restaurantId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("restaurantId", "paymentNo")
);

-- Printer Settings (1:1 with restaurant)
CREATE TABLE IF NOT EXISTS "PrinterSetting" (
  id SERIAL PRIMARY KEY,
  "printerName" TEXT NOT NULL,
  "printerWidth" INTEGER DEFAULT 80,
  "autoPrintBill" BOOLEAN DEFAULT false,
  "autoPrintKOT" BOOLEAN DEFAULT false,
  "showLogo" BOOLEAN DEFAULT true,
  "showGST" BOOLEAN DEFAULT true,
  "showQRCode" BOOLEAN DEFAULT false,
  "billHeader" TEXT,
  "billFooter" TEXT,
  "connectionType" "ConnectionType" DEFAULT 'USB',
  "ipAddress" TEXT,
  "macAddress" TEXT,
  port INTEGER,
  "printersJson" TEXT DEFAULT '[]',
  "restaurantId" INTEGER NOT NULL UNIQUE,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW()
);

-- Audit Logs
CREATE TABLE IF NOT EXISTS "AuditLog" (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "restaurantId" INTEGER,
  module "AuditModule" NOT NULL,
  action "AuditAction" NOT NULL,
  description TEXT NOT NULL,
  "referenceId" INTEGER,
  "referenceNo" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS "Notification" (
  id SERIAL PRIMARY KEY,
  "restaurantId" INTEGER NOT NULL,
  "userId" INTEGER,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type "NotificationType" DEFAULT 'INFO',
  priority "NotificationPriority" DEFAULT 'NORMAL',
  "deepLink" TEXT,
  "isRead" BOOLEAN DEFAULT false,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

-- Merge Groups (DB-persisted table merges)
CREATE TABLE IF NOT EXISTS "MergeGroup" (
  id SERIAL PRIMARY KEY,
  "restaurantId" INTEGER NOT NULL,
  "primaryOrderId" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW()
);

-- Junction: which tables are part of a merge group
CREATE TABLE IF NOT EXISTS "MergeGroupTable" (
  id SERIAL PRIMARY KEY,
  "mergeGroupId" INTEGER NOT NULL,
  "tableId" INTEGER NOT NULL,
  "originalOrderId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);
`;

/**
 * Indexes for tenant tables (created after tables for cleaner DDL).
 */
const TENANT_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_floor_restaurant ON "Floor"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_table_restaurant ON "RestaurantTable"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_table_floor ON "RestaurantTable"("floorId");
CREATE INDEX IF NOT EXISTS idx_table_status ON "RestaurantTable"(status);
CREATE INDEX IF NOT EXISTS idx_category_restaurant ON "Category"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_category_active ON "Category"("isActive");
CREATE INDEX IF NOT EXISTS idx_menuitem_restaurant ON "MenuItem"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_menuitem_category ON "MenuItem"("categoryId");
CREATE INDEX IF NOT EXISTS idx_menuitem_available ON "MenuItem"("isAvailable");
CREATE INDEX IF NOT EXISTS idx_menuitem_sku ON "MenuItem"(sku);
CREATE INDEX IF NOT EXISTS idx_menuitem_barcode ON "MenuItem"(barcode);
CREATE INDEX IF NOT EXISTS idx_menuitem_veg ON "MenuItem"("isVeg");
CREATE INDEX IF NOT EXISTS idx_customer_restaurant ON "Customer"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_customer_phone ON "Customer"(phone);
CREATE INDEX IF NOT EXISTS idx_customer_email ON "Customer"(email);
CREATE INDEX IF NOT EXISTS idx_customer_type ON "Customer"(type);
CREATE INDEX IF NOT EXISTS idx_order_restaurant ON "Order"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_order_status ON "Order"(status);
CREATE INDEX IF NOT EXISTS idx_order_table ON "Order"("tableId");
CREATE INDEX IF NOT EXISTS idx_order_customer ON "Order"("customerId");
CREATE INDEX IF NOT EXISTS idx_order_created ON "Order"("createdAt");
CREATE INDEX IF NOT EXISTS idx_order_type ON "Order"("orderType");
CREATE INDEX IF NOT EXISTS idx_orderitem_order ON "OrderItem"("orderId");
CREATE INDEX IF NOT EXISTS idx_orderitem_menu ON "OrderItem"("menuItemId");
CREATE INDEX IF NOT EXISTS idx_orderitem_order_menu ON "OrderItem"("orderId", "menuItemId");
CREATE INDEX IF NOT EXISTS idx_stock_restaurant ON "StockMovement"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_stock_menu ON "StockMovement"("menuItemId");
CREATE INDEX IF NOT EXISTS idx_stock_order ON "StockMovement"("orderId");
CREATE INDEX IF NOT EXISTS idx_stock_created ON "StockMovement"("createdAt");
CREATE INDEX IF NOT EXISTS idx_kot_restaurant ON "KOT"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_kot_status ON "KOT"(status);
CREATE INDEX IF NOT EXISTS idx_kot_order ON "KOT"("orderId");
CREATE INDEX IF NOT EXISTS idx_kot_created ON "KOT"("createdAt");
CREATE INDEX IF NOT EXISTS idx_bill_restaurant ON "Bill"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_bill_status ON "Bill"(status);
CREATE INDEX IF NOT EXISTS idx_bill_payment ON "Bill"("paymentStatus");
CREATE INDEX IF NOT EXISTS idx_bill_order ON "Bill"("orderId");
CREATE INDEX IF NOT EXISTS idx_bill_created ON "Bill"("createdAt");
CREATE INDEX IF NOT EXISTS idx_payment_restaurant ON "Payment"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_payment_bill ON "Payment"("billId");
CREATE INDEX IF NOT EXISTS idx_payment_method ON "Payment"("paymentMethod");
CREATE INDEX IF NOT EXISTS idx_payment_status ON "Payment"(status);
CREATE INDEX IF NOT EXISTS idx_payment_gateway ON "Payment"(gateway);
CREATE INDEX IF NOT EXISTS idx_payment_created ON "Payment"("createdAt");
CREATE INDEX IF NOT EXISTS idx_printer_restaurant ON "PrinterSetting"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_audit_restaurant ON "AuditLog"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_audit_user ON "AuditLog"("userId");
CREATE INDEX IF NOT EXISTS idx_audit_module ON "AuditLog"(module);
CREATE INDEX IF NOT EXISTS idx_audit_action ON "AuditLog"(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON "AuditLog"("createdAt");
CREATE INDEX IF NOT EXISTS idx_audit_ref ON "AuditLog"("referenceId");
CREATE INDEX IF NOT EXISTS idx_notif_restaurant ON "Notification"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_notif_user ON "Notification"("userId");
CREATE INDEX IF NOT EXISTS idx_notif_type ON "Notification"(type);
CREATE INDEX IF NOT EXISTS idx_notif_read ON "Notification"("isRead");
CREATE INDEX IF NOT EXISTS idx_notif_created ON "Notification"("createdAt");
CREATE INDEX IF NOT EXISTS idx_notif_priority ON "Notification"(priority);
CREATE INDEX IF NOT EXISTS idx_user_role ON "User"("role");
CREATE INDEX IF NOT EXISTS idx_user_active ON "User"("isActive");
CREATE INDEX IF NOT EXISTS idx_user_email ON "User"(email);
CREATE INDEX IF NOT EXISTS idx_setting_restaurant ON "RestaurantSetting"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_mergegroup_restaurant ON "MergeGroup"("restaurantId");
CREATE INDEX IF NOT EXISTS idx_mergegroup_order ON "MergeGroup"("primaryOrderId");
CREATE INDEX IF NOT EXISTS idx_mergegroup_status ON "MergeGroup"(status);
CREATE INDEX IF NOT EXISTS idx_mergegrouptable_mergegroup ON "MergeGroupTable"("mergeGroupId");
CREATE INDEX IF NOT EXISTS idx_mergegrouptable_table ON "MergeGroupTable"("tableId");
CREATE INDEX IF NOT EXISTS idx_mergegrouptable_order ON "MergeGroupTable"("originalOrderId");
`;

/**
 * Foreign key constraints for tenant tables.
 * These reference other tables WITHIN the same tenant schema.
 * Cross-schema foreign keys (to public.Restaurant) are NOT created —
 * the application handles that relationship via code.
 */
const TENANT_FKS_SQL = `
DO $$
BEGIN
  -- Floor FK is handled by unique constraint already
  -- RestaurantTable.floorId → Floor.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RestaurantTable_floorId_fkey') THEN
    ALTER TABLE "RestaurantTable" ADD CONSTRAINT "RestaurantTable_floorId_fkey"
      FOREIGN KEY ("floorId") REFERENCES "Floor"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- MenuItem.categoryId → Category.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuItem_categoryId_fkey') THEN
    ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES "Category"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- Order.tableId → RestaurantTable.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_tableId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_tableId_fkey"
      FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- Order.customerId → Customer.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_customerId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- OrderItem.orderId → Order.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderItem_orderId_fkey') THEN
    ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- OrderItem.menuItemId → MenuItem.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderItem_menuItemId_fkey') THEN
    ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey"
      FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- StockMovement.menuItemId → MenuItem.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockMovement_menuItemId_fkey') THEN
    ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_menuItemId_fkey"
      FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- StockMovement.orderId → Order.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockMovement_orderId_fkey') THEN
    ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- KOT.orderId → Order.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KOT_orderId_fkey') THEN
    ALTER TABLE "KOT" ADD CONSTRAINT "KOT_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- Bill.orderId → Order.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Bill_orderId_fkey') THEN
    ALTER TABLE "Bill" ADD CONSTRAINT "Bill_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- Payment.billId → Bill.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_billId_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_billId_fkey"
      FOREIGN KEY ("billId") REFERENCES "Bill"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- MergeGroup.primaryOrderId → Order.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MergeGroup_primaryOrderId_fkey') THEN
    ALTER TABLE "MergeGroup" ADD CONSTRAINT "MergeGroup_primaryOrderId_fkey"
      FOREIGN KEY ("primaryOrderId") REFERENCES "Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- MergeGroupTable.mergeGroupId → MergeGroup.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MergeGroupTable_mergeGroupId_fkey') THEN
    ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_mergeGroupId_fkey"
      FOREIGN KEY ("mergeGroupId") REFERENCES "MergeGroup"(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- MergeGroupTable.tableId → RestaurantTable.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MergeGroupTable_tableId_fkey') THEN
    ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_tableId_fkey"
      FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- MergeGroupTable.originalOrderId → Order.id
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MergeGroupTable_originalOrderId_fkey') THEN
    ALTER TABLE "MergeGroupTable" ADD CONSTRAINT "MergeGroupTable_originalOrderId_fkey"
      FOREIGN KEY ("originalOrderId") REFERENCES "Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
`;

/**
 * Default seed data for a new tenant schema.
 */
const TENANT_DEFAULTS_SQL = `
-- Default Walk-in Customer
INSERT INTO "Customer" ("name", type, "restaurantId")
SELECT 'Walk-in Customer', 'WALK_IN', 0
WHERE NOT EXISTS (SELECT 1 FROM "Customer" WHERE type = 'WALK_IN');
`;

/**
 * Schema-qualify all table references in a SQL string.
 * Replaces bare "TableName" with "schemaName"."TableName" in:
 *   CREATE TABLE IF NOT EXISTS
 *   CREATE INDEX IF NOT EXISTS ... ON
 *   ALTER TABLE
 *   REFERENCES "TableName"
 *   INSERT INTO / SELECT FROM / WHERE EXISTS (SELECT ... FROM
 *
 * The enums SQL uses DO $$ blocks that reference types, not tables — it needs
 * SET search_path prepended instead.
 */
function schemaQualifySQL(sql, schemaName) {
  const S = schemaName;
  // Replace CREATE TABLE IF NOT EXISTS "Name"
  let result = sql.replace(/CREATE TABLE IF NOT EXISTS "/g, `CREATE TABLE IF NOT EXISTS "${S}"."`);
  // Replace CREATE INDEX IF NOT EXISTS ... ON "Name"
  result = result.replace(/ON "/g, `ON "${S}"."`);
  // Replace ALTER TABLE "Name"
  result = result.replace(/ALTER TABLE "/g, `ALTER TABLE "${S}"."`);
  // Replace REFERENCES "Name"
  result = result.replace(/REFERENCES "/g, `REFERENCES "${S}"."`);
  // Replace INSERT INTO "Name"
  result = result.replace(/INSERT INTO "/g, `INSERT INTO "${S}"."`);
  // Replace FROM "Name" (in SELECT subqueries and WHERE EXISTS)
  result = result.replace(/FROM "/g, `FROM "${S}"."`);

  return result;
}

/**
 * Schema-qualify enum type names in DO $$ blocks.
 * Replaces CREATE TYPE "TypeName" with CREATE TYPE "schemaName"."TypeName"
 * so enums are created in the correct tenant schema regardless of search_path.
 */
function schemaQualifyEnums(sql, schemaName) {
  // Replace CREATE TYPE "Name" AS ENUM with CREATE TYPE "schema"."Name" AS ENUM
  return sql.replace(/CREATE TYPE "/g, `CREATE TYPE "${schemaName}"."`);
}

/**
 * Initialize a new tenant schema for a restaurant.
 * Creates the schema, all tables, indexes, foreign keys, and default data.
 *
 * @param {number} restaurantId - The restaurant ID
 * @param {object} options - Optional overrides
 * @param {object} tx - Optional Prisma transaction client (from platformPrisma)
 * @returns {Promise<{ schemaName: string, success: boolean }>}
 */
async function initializeTenantSchema(restaurantId, options = {}, tx = null) {
  const schemaName = generateSchemaName(restaurantId);

  console.log(`[TenantInit] Initializing schema: ${schemaName} for restaurant ${restaurantId}`);

  try {
    // 1. Create the schema (auto-commits, separate from DDL transaction)
    await platformPrisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    console.log(`[TenantInit] Schema ${schemaName} created`);

    // 2-5. Create enums, tables, indexes, foreign keys inside a transaction
    // so SET search_path persists across all statements on the same connection.
    await platformPrisma.$transaction(async (ddlTx) => {
      // Set search_path so bare type references resolve to the tenant schema
      await ddlTx.$executeRawUnsafe(`SET search_path TO "${schemaName}", public`);

      // 2. Create PostgreSQL enum types
      const enumsSQL = schemaQualifyEnums(TENANT_ENUMS_SQL, schemaName);
      await execMultiSQL(ddlTx, enumsSQL, 'enums');
      console.log(`[TenantInit] Enum types created in ${schemaName}`);

      // 3. Create all tenant tables
      const qualifiedTables = schemaQualifySQL(TENANT_TABLES_SQL, schemaName);
      await execMultiSQL(ddlTx, qualifiedTables, 'tables');
      console.log(`[TenantInit] Tables created in ${schemaName}`);

      // 4. Create indexes
      const qualifiedIndexes = schemaQualifySQL(TENANT_INDEXES_SQL, schemaName);
      await execMultiSQL(ddlTx, qualifiedIndexes, 'indexes');
      console.log(`[TenantInit] Indexes created in ${schemaName}`);

      // 5. Create foreign key constraints
      const qualifiedFKs = schemaQualifySQL(TENANT_FKS_SQL, schemaName);
      await execMultiSQL(ddlTx, qualifiedFKs, 'foreign-keys');
      console.log(`[TenantInit] Foreign keys created in ${schemaName}`);
    });
    console.log(`[TenantInit] DDL transaction committed for ${schemaName}`);

    // 6. Update the Restaurant record with tenantSchema (skip if restaurantId not yet known)
    if (restaurantId && restaurantId > 0) {
      await platformPrisma.restaurant.update({
        where: { id: restaurantId },
        data: { tenantSchema: schemaName },
      });
      console.log(`[TenantInit] Restaurant ${restaurantId} linked to ${schemaName}`);
    } else {
      console.log(`[TenantInit] Skipped linking (restaurantId not yet assigned)`);
    }

    return { schemaName, success: true };
  } catch (error) {
    console.error(`[TenantInit] Error initializing ${schemaName}:`, error.message);
    throw error;
  }
}

/**
 * Get the SQL to create tenant schema tables (for migration scripts).
 * Returns the raw SQL that can be executed against a specific schema.
 */
function getTenantDDLForSchema(schemaName) {
  if (!schemaName || !/^restaurant_\d+$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }

  // Set the search path for the SQL block
  return `
SET search_path TO "${schemaName}";
${TENANT_TABLES_SQL}
${TENANT_INDEXES_SQL}
${TENANT_FKS_SQL}
RESET search_path;
`;
}

module.exports = {
  initializeTenantSchema,
  getTenantDDLForSchema,
  generateSchemaName,
  splitSQL,
  execMultiSQL,
  TENANT_TABLES_SQL,
  TENANT_ENUMS_SQL,
  TENANT_INDEXES_SQL,
  TENANT_FKS_SQL,
  TENANT_DEFAULTS_SQL,
};
