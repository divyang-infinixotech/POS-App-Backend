#!/usr/bin/env node
/**
 * Fixes tenant User tables by adding the restaurantId column
 * that Prisma expects. This is needed because the Prisma schema's
 * User model includes restaurantId, and Prisma will fail when querying
 * a User table without it.
 */

const { PrismaClient } = require("@prisma/client");

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Fix tenant User tables: add restaurantId column");
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
      const restaurantId = restaurant.id;
      console.log(`Processing: ${restaurant.name} (ID: ${restaurantId}) → ${schema}`);

      try {
        // Check if restaurantId column exists
        const colCheck = await prisma.$queryRawUnsafe(`
          SELECT EXISTS (
            SELECT FROM information_schema.columns 
            WHERE table_schema = '${schema}' 
            AND table_name = 'User'
            AND column_name = 'restaurantId'
          ) as exists
        `);

        const hasCol = colCheck[0]?.exists;

        if (hasCol) {
          console.log(`  ✅ restaurantId column already exists`);
          continue;
        }

        console.log(`  ⚠ restaurantId column missing — adding...`);

        // Add the column
        await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."User" ADD COLUMN "restaurantId" INTEGER`);
        
        // Update existing rows with the correct restaurantId
        await prisma.$executeRawUnsafe(`UPDATE "${schema}"."User" SET "restaurantId" = ${restaurantId}`);
        
        // Create index
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_user_restaurant ON "${schema}"."User"("restaurantId")`);

        console.log(`  ✅ restaurantId column added and populated`);

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
