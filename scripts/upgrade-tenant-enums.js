#!/usr/bin/env node
/**
 * Upgrade existing tenant schemas with PostgreSQL enum types and missing columns.
 *
 * Existing tenant schemas were created with TEXT columns but Prisma expects
 * PostgreSQL enum types (OrderStatus, PaymentMethod, etc.). This script:
 *
 * 1. Adds all required enum types to each tenant schema
 * 2. Drops TEXT columns that use enum types and recreates them with the correct type
 * 3. Adds missing columns (e.g., cardNumber in Payment)
 *
 * This script is IDEMPOTENT — safe to run multiple times.
 *
 * Usage:
 *   node scripts/upgrade-tenant-enums.js
 *   node scripts/upgrade-tenant-enums.js --dry-run
 */

const { platformPrisma } = require('../src/config/tenantPrisma');

// All enum types needed by Prisma in tenant schemas
const ENUM_DEFINITIONS = [
  { name: 'OrderStatus', values: "'PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED', 'HOLD'" },
  { name: 'OrderType', values: "'DINE_IN', 'TAKEAWAY', 'DELIVERY', 'COUNTER_SALE'" },
  { name: 'TableStatus', values: "'AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING'" },
  { name: 'DiscountType', values: "'FLAT', 'PERCENTAGE'" },
  { name: 'KOTStatus', values: "'PENDING', 'PREPARING', 'READY', 'SERVED', 'ACCEPTED', 'CANCELLED'" },
  { name: 'BillStatus', values: "'UNPAID', 'PAID', 'CANCELLED', 'REFUNDED'" },
  { name: 'PaymentMethod', values: "'CASH', 'CARD', 'UPI'" },
  { name: 'PaymentStatus', values: "'PENDING', 'PAID', 'PARTIAL', 'REFUNDED', 'FAILED'" },
  { name: 'PaymentGateway', values: "'RAZORPAY', 'CASHFREE', 'PHONEPE', 'PAYTM', 'STRIPE', 'NONE'" },
  { name: 'CustomerType', values: "'WALK_IN', 'REGULAR', 'VIP'" },
  { name: 'AuditModule', values: "'AUTH', 'USER', 'CATEGORY', 'MENU', 'TABLE', 'ORDER', 'KOT', 'BILL', 'PAYMENT', 'SETTINGS', 'PRINTER', 'DASHBOARD', 'SUBSCRIPTION', 'CUSTOMER', 'FLOOR', 'REPORT', 'NOTIFICATION'" },
  { name: 'AuditAction', values: "'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'PRINT', 'REPRINT', 'CANCEL', 'PAYMENT', 'VIEW', 'REFUND', 'APPLY_DISCOUNT'" },
  { name: 'ConnectionType', values: "'USB', 'LAN', 'BLUETOOTH'" },
  { name: 'NotificationType', values: "'INFO', 'SUCCESS', 'WARNING', 'ERROR', 'ORDER', 'KITCHEN', 'PAYMENT', 'SUBSCRIPTION', 'SYSTEM'" },
  { name: 'NotificationPriority', values: "'LOW', 'NORMAL', 'HIGH', 'URGENT'" },
];

// Column-to-enum mappings: which columns need to be converted from TEXT to enum type
// Format: { table, column, enumType }
const ENUM_COLUMN_MAPPINGS = [
  { table: 'Order', column: 'status', enumType: 'OrderStatus' },
  { table: 'Order', column: 'orderType', enumType: 'OrderType' },
  { table: 'Order', column: 'discountType', enumType: 'DiscountType' },
  { table: 'RestaurantTable', column: 'status', enumType: 'TableStatus' },
  { table: 'KOT', column: 'status', enumType: 'KOTStatus' },
  { table: 'Bill', column: 'status', enumType: 'BillStatus' },
  { table: 'Bill', column: 'discountType', enumType: 'DiscountType' },
  { table: 'Bill', column: 'paymentMethod', enumType: 'PaymentMethod' },
  { table: 'Bill', column: 'paymentStatus', enumType: 'PaymentStatus' },
  { table: 'Payment', column: 'paymentMethod', enumType: 'PaymentMethod' },
  { table: 'Payment', column: 'status', enumType: 'PaymentStatus' },
  { table: 'Payment', column: 'gateway', enumType: 'PaymentGateway' },
  { table: 'Customer', column: 'type', enumType: 'CustomerType' },
  { table: 'AuditLog', column: 'module', enumType: 'AuditModule' },
  { table: 'AuditLog', column: 'action', enumType: 'AuditAction' },
  { table: 'Notification', column: 'type', enumType: 'NotificationType' },
  { table: 'Notification', column: 'priority', enumType: 'NotificationPriority' },
];

// Missing columns that need to be added to existing tenant schemas
const MISSING_COLUMNS = [
  // Payment card fields (added after initial schema creation)
  { table: 'Payment', column: '"cardNumber"', type: 'TEXT' },
  { table: 'Payment', column: '"cardType"', type: 'TEXT' },
  { table: 'Payment', column: '"last4Digits"', type: 'TEXT' },
  { table: 'Payment', column: '"approvalCode"', type: 'TEXT' },
  { table: 'Payment', column: '"upiTransactionId"', type: 'TEXT' },
  { table: 'Payment', column: '"upiVerifiedAt"', type: 'TIMESTAMP' },
];

const isDryRun = process.argv.includes('--dry-run');

async function getExistingSchemas() {
  const restaurants = await platformPrisma.restaurant.findMany({
    where: {
      tenantSchema: { not: null },
      status: 'ACTIVE',
    },
    select: { id: true, name: true, tenantSchema: true },
    orderBy: { id: 'asc' },
  });
  return restaurants;
}

async function columnExists(client, schemaName, tableName, columnName) {
  const result = await client.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND column_name = $3
    ) as exists
  `, schemaName, tableName, columnName);
  return result[0]?.exists || false;
}

async function enumTypeExists(client, schemaName, enumName) {
  const result = await client.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = $1
        AND t.typname = $2
    ) as exists
  `, schemaName, enumName);
  return result[0]?.exists || false;
}

async function getColumnType(client, schemaName, tableName, columnName) {
  const result = await client.$queryRawUnsafe(`
    SELECT data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = $2
      AND column_name = $3
  `, schemaName, tableName, columnName);
  return result[0] || null;
}

async function upgradeSchema(client, schemaName, restaurant) {
  const results = { enums: 0, columns: 0, conversions: 0, errors: [] };

  try {
    // Step 1: Create all enum types
    console.log(`  Creating enum types...`);
    for (const enumDef of ENUM_DEFINITIONS) {
      const exists = await enumTypeExists(client, schemaName, enumDef.name);
      if (exists) {
        continue; // Already exists
      }

      if (isDryRun) {
        console.log(`    [DRY RUN] Would create enum ${enumDef.name}`);
        results.enums++;
        continue;
      }

      try {
        await client.$executeRawUnsafe(`
          DO $$ BEGIN
            CREATE TYPE "${enumDef.name}" AS ENUM (${enumDef.values});
          EXCEPTION WHEN duplicate_object THEN null;
          END $$;
        `);
        results.enums++;
      } catch (err) {
        results.errors.push(`Enum ${enumDef.name}: ${err.message}`);
      }
    }

    // Step 2: Convert TEXT columns to enum types
    console.log(`  Converting TEXT columns to enum types...`);
    for (const mapping of ENUM_COLUMN_MAPPINGS) {
      const colType = await getColumnType(client, schemaName, mapping.table, mapping.column);

      if (!colType) {
        // Column doesn't exist at all, skip
        continue;
      }

      // If it's already the correct enum type, skip
      if (colType.udt_name === mapping.enumType.toLowerCase()) {
        continue;
      }

      // If it's still TEXT/varchar, convert it
      if (colType.data_type === 'text' || colType.data_type === 'character varying') {
        if (isDryRun) {
          console.log(`    [DRY RUN] Would convert ${mapping.table}.${mapping.column} from ${colType.data_type} to ${mapping.enumType}`);
          results.conversions++;
          continue;
        }

        console.log(`    Converting ${mapping.table}.${mapping.column} from ${colType.data_type} to ${mapping.enumType}...`);
        try {
          // Step 1: Drop the column default so PostgreSQL can cast the column type.
          // The error "default for column cannot be cast automatically" means
          // the TEXT default value conflicts with the ALTER TYPE operation.
          await client.$executeRawUnsafe(`
            ALTER TABLE "${mapping.table}" ALTER COLUMN "${mapping.column}" DROP DEFAULT
          `);

          // Step 2: Cast the column from TEXT to the enum type
          await client.$executeRawUnsafe(`
            ALTER TABLE "${mapping.table}"
            ALTER COLUMN "${mapping.column}"
            TYPE "${mapping.enumType}"
            USING "${mapping.column}"::text::"${mapping.enumType}"
          `);

          // Step 3: Re-add a valid enum default if there was one originally
          const defaultMap = {
            'status': { OrderStatus: "'PENDING'", TableStatus: "'AVAILABLE'", KOTStatus: "'PENDING'", BillStatus: "'UNPAID'", PaymentStatus: "'PAID'" },
            'paymentStatus': { PaymentStatus: "'PENDING'" },
            'gateway': { PaymentGateway: "'NONE'" },
            'type': { CustomerType: "'WALK_IN'", NotificationType: "'INFO'" },
            'priority': { NotificationPriority: "'NORMAL'" },
          };
          const colBaseName = mapping.column.replace(/"/g, '');
          const defaults = defaultMap[colBaseName];
          if (defaults && defaults[mapping.enumType]) {
            await client.$executeRawUnsafe(`
              ALTER TABLE "${mapping.table}"
              ALTER COLUMN "${mapping.column}"
              SET DEFAULT ${defaults[mapping.enumType]}
            `);
          }

          results.conversions++;
          console.log(`    ✓ Converted ${mapping.table}.${mapping.column}`);
        } catch (err) {
          // If conversion fails (e.g., invalid data), keep as TEXT and log warning
          console.warn(`    ⚠ Could not convert ${mapping.table}.${mapping.column}: ${err.message}`);
          console.warn(`    ⚠ Keeping as TEXT — Prisma may not work correctly for this column`);
          results.errors.push(`Convert ${mapping.table}.${mapping.column}: ${err.message}`);
        }
      }
    }

    // Step 3: Add missing columns
    console.log(`  Adding missing columns...`);
    for (const col of MISSING_COLUMNS) {
      const exists = await columnExists(client, schemaName, col.table, col.column.replace(/"/g, ''));
      if (exists) continue;

      if (isDryRun) {
        console.log(`    [DRY RUN] Would add ${col.table}.${col.column}`);
        results.columns++;
        continue;
      }

      try {
        await client.$executeRawUnsafe(`
          ALTER TABLE "${col.table}" ADD COLUMN ${col.column} ${col.type}
        `);
        results.columns++;
        console.log(`    ✓ Added ${col.table}.${col.column}`);
      } catch (err) {
        results.errors.push(`Add column ${col.table}.${col.column}: ${err.message}`);
      }
    }

  } catch (err) {
    results.errors.push(`Schema upgrade failed: ${err.message}`);
  }

  return results;
}

async function main() {
  console.log('=== Tenant Schema Upgrade: Enum Types & Missing Columns ===');
  if (isDryRun) {
    console.log('[DRY RUN MODE — no changes will be made]\n');
  }

  const restaurants = await getExistingSchemas();
  console.log(`Found ${restaurants.length} restaurant(s) with tenant schemas\n`);

  let successCount = 0;
  let errorCount = 0;

  for (const restaurant of restaurants) {
    const schemaName = restaurant.tenantSchema;
    console.log(`[${schemaName}] Restaurant #${restaurant.id} — ${restaurant.name}`);

    try {
      // Create a client connected to this specific tenant schema
      const baseUrl = process.env.DATABASE_URL;
      const separator = baseUrl.includes('?') ? '&' : '?';
      const tenantUrl = `${baseUrl}${separator}schema=${schemaName}`;
      const { PrismaClient } = require('@prisma/client');
      const tenantClient = new PrismaClient({
        datasources: { db: { url: tenantUrl } },
      });

      const results = await upgradeSchema(tenantClient, schemaName, restaurant);

      if (results.errors.length > 0) {
        console.log(`  ⚠ Errors: ${results.errors.join(', ')}`);
      }

      console.log(`  Summary: ${results.enums} enums created, ${results.conversions} columns converted, ${results.columns} columns added`);

      if (results.errors.length === 0) {
        console.log(`  ✅ Success\n`);
        successCount++;
      } else {
        console.log(`  ⚠ Completed with warnings\n`);
        successCount++;
      }

      await tenantClient.$disconnect();
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}\n`);
      errorCount++;
    }
  }

  console.log('\n=== Upgrade Complete ===');
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${errorCount}`);

  if (errorCount > 0) {
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await platformPrisma.$disconnect();
  });
