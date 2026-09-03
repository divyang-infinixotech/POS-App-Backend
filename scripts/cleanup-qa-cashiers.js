#!/usr/bin/env node
/**
 * TASK 1: Clean QA Data — Delete 97 CASHIER users from public.User
 *
 * Safety checks:
 *   - Verify each user's restaurant exists
 *   - Verify restaurant.status = INACTIVE
 *   - Verify restaurant.deletedAt IS NOT NULL
 *   - Verify the restaurant has NO tenant schema
 *
 * Usage:
 *   node scripts/cleanup-qa-cashiers.js [--dry-run]
 */

const { PrismaClient } = require("@prisma/client");

async function main() {
  const isDryRun = process.argv.includes("--dry-run");

  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("  TASK 1: Clean QA Data — Delete 97 CASHIER users from public.User");
  console.log("  Mode:", isDryRun ? "DRY RUN (no changes)" : "LIVE DELETION");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  const prisma = new PrismaClient();

  try {
    // Step 1: Get all CASHIER users
    const cashierUsers = await prisma.user.findMany({
      where: { role: "CASHIER" },
      select: {
        id: true,
        name: true,
        email: true,
        restaurantId: true,
      },
    });

    console.log(`Found ${cashierUsers.length} CASHIER users in public.User\n`);

    // Step 2: Verify each user before deletion
    const safeToDelete = [];
    const skippedUsers = [];

    for (const user of cashierUsers) {
      // Check 1: restaurant exists
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: user.restaurantId },
        select: {
          id: true,
          name: true,
          status: true,
          tenantSchema: true,
          deletedAt: true,
        },
      });

      if (!restaurant) {
        skippedUsers.push({
          user,
          reason: "Restaurant does not exist",
        });
        continue;
      }

      // Check 2: restaurant.status = INACTIVE
      if (restaurant.status !== "INACTIVE") {
        skippedUsers.push({
          user,
          reason: `Restaurant status is ${restaurant.status} (expected INACTIVE)`,
        });
        continue;
      }

      // Check 3: restaurant.deletedAt IS NOT NULL
      if (!restaurant.deletedAt) {
        skippedUsers.push({
          user,
          reason: "Restaurant deletedAt is NULL (not soft-deleted)",
        });
        continue;
      }

      // Check 4: restaurant has NO tenant schema
      if (restaurant.tenantSchema) {
        skippedUsers.push({
          user,
          reason: `Restaurant has tenant schema: ${restaurant.tenantSchema}`,
        });
        continue;
      }

      // All checks passed
      safeToDelete.push({
        user,
        restaurant,
      });
    }

    // Step 3: Report
    console.log("═".repeat(80));
    console.log("  VERIFICATION RESULTS");
    console.log("═".repeat(80) + "\n");

    console.log(`Safe to delete: ${safeToDelete.length}`);
    console.log(`Skipped (safety check failed): ${skippedUsers.length}\n`);

    if (skippedUsers.length > 0) {
      console.log("⚠ SKIPPED USERS:");
      for (const { user, reason } of skippedUsers) {
        console.log(`  - ${user.email} (id=${user.id}, restaurantId=${user.restaurantId}): ${reason}`);
      }
      console.log("");
    }

    // Step 4: Delete
    if (safeToDelete.length === 0) {
      console.log("No users to delete.");
      return;
    }

    console.log("═".repeat(80));
    console.log("  DELETION");
    console.log("═".repeat(80) + "\n");

    let deletedCount = 0;
    let errorCount = 0;

    for (const { user, restaurant } of safeToDelete) {
      try {
        if (!isDryRun) {
          await prisma.user.delete({
            where: { id: user.id },
          });
        }
        console.log(
          `  ${isDryRun ? "[DRY RUN] " : ""}Deleted: ${user.email} (id=${user.id}, restaurant=${restaurant.name} #${restaurant.id})`
        );
        deletedCount++;
      } catch (err) {
        console.error(`  ERROR deleting ${user.email}: ${err.message}`);
        errorCount++;
      }
    }

    // Step 5: Post-deletion verification
    console.log("\n" + "═".repeat(80));
    console.log("  POST-DELETION VERIFICATION");
    console.log("═".repeat(80) + "\n");

    const remainingCashiers = await prisma.user.findMany({
      where: { role: "CASHIER" },
      select: { id: true, email: true, restaurantId: true },
    });

    console.log(`Remaining CASHIER users in public.User: ${remainingCashiers.length}`);

    if (remainingCashiers.length > 0) {
      console.log("⚠ Remaining CASHIERs:");
      for (const u of remainingCashiers) {
        console.log(`  - ${u.email} (id=${u.id}, restaurantId=${u.restaurantId})`);
      }
    } else {
      console.log("✅ No CASHIER users remain in public.User");
    }

    // Verify no ACTIVE restaurant CASHIER was deleted
    console.log("\n" + "═".repeat(80));
    console.log("  SAFETY CHECK: No ACTIVE restaurant CASHIER was deleted");
    console.log("═".repeat(80) + "\n");

    const activeRestaurantsWithCashiers = await prisma.user.findMany({
      where: {
        role: "CASHIER",
        restaurant: {
          status: "ACTIVE",
          deletedAt: null,
        },
      },
      select: { id: true, email: true, restaurantId: true },
    });

    if (activeRestaurantsWithCashiers.length === 0) {
      console.log("✅ No ACTIVE restaurant CASHIER exists in public.User (expected)");
    } else {
      console.log(`⚠ Found ${activeRestaurantsWithCashiers.length} CASHIER(s) in ACTIVE restaurants:`);
      for (const u of activeRestaurantsWithCashiers) {
        console.log(`  - ${u.email} (restaurantId=${u.restaurantId})`);
      }
    }

    // Final summary
    console.log("\n" + "═".repeat(80));
    console.log("  SUMMARY");
    console.log("═".repeat(80) + "\n");

    console.log(`Total CASHIER users found: ${cashierUsers.length}`);
    console.log(`Safe to delete: ${safeToDelete.length}`);
    console.log(`Deleted: ${deletedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Skipped: ${skippedUsers.length}`);
    console.log(`Remaining CASHIERs: ${remainingCashiers.length}`);

    if (!isDryRun && deletedCount > 0) {
      console.log("\n✅ QA CASHIER cleanup complete.");
    }

  } catch (error) {
    console.error("Cleanup failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
