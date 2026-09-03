#!/usr/bin/env node
/**
 * Ensures the User table exists in all existing tenant schemas.
 * This is needed because tenant schemas were created before the User table
 * was added to the tenant DDL.
 */

const { PrismaClient } = require("@prisma/client");

const USER_ROLE_ENUM_SQL = `
DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'SUPER_ADMIN');
EXCEPTION WHEN duplicate_object THEN null;
END $$;`;

const USER_TABLE_SQL = `
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
)`;

const USER_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_user_role ON "User"("role")`,
  `CREATE INDEX IF NOT EXISTS idx_user_active ON "User"("isActive")`,
  `CREATE INDEX IF NOT EXISTS idx_user_email ON "User"("email")`
];

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Ensure User table in all tenant schemas");
  console.log("═══════════════════════════════════════════════════════\n");

  const prisma = new PrismaClient();

  try {
    const restaurants = await prisma.restaurant.findMany({
      where: { deletedAt: null, tenantSchema: { not: null } },
      select: { id: true, name: true, tenantSchema: true }
    });

    console.log(`Found ${restaurants.length} restaurants with tenant schemas\n`);

    for (const restaurant of restaurants) {
      const schema = restaurant.tenantSchema;
      console.log(`Processing: ${restaurant.name} (ID: ${restaurant.id}) → ${schema}`);

      try {
        // Check if User table exists
        const tableCheck = await prisma.$queryRawUnsafe(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = '${schema}' 
            AND table_name = 'User'
          ) as exists
        `);

        const userTableExists = tableCheck[0]?.exists;

        if (userTableExists) {
          console.log(`  ✅ User table already exists in ${schema}`);
          continue;
        }

        console.log(`  ⚠ User table missing in ${schema} — creating...`);

        // Set search path
        await prisma.$executeRawUnsafe(`SET search_path TO "${schema}", public`);

        // Create UserRole enum if it doesn't exist
        await prisma.$executeRawUnsafe(USER_ROLE_ENUM_SQL);

        // Create the User table
        await prisma.$executeRawUnsafe(USER_TABLE_SQL);

        // Create indexes one by one
        for (const idx of USER_INDEXES) {
          await prisma.$executeRawUnsafe(idx);
        }

        // Verify
        const verifyCheck = await prisma.$queryRawUnsafe(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = '${schema}' 
            AND table_name = 'User'
          ) as exists
        `);

        if (verifyCheck[0]?.exists) {
          console.log(`  ✅ User table created successfully in ${schema}`);
        } else {
          console.log(`  ❌ Failed to create User table in ${schema}`);
        }

      } catch (err) {
        console.error(`  ❌ Error processing ${schema}: ${err.message}`);
      }
    }

    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  DONE");
    console.log("═══════════════════════════════════════════════════════");

  } catch (error) {
    console.error("Script failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
