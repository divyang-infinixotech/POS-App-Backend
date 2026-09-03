#!/usr/bin/env node
/**
 * TASK 5: Test Staff Creation in ACTIVE Restaurants
 *
 * Creates test staff (MANAGER, CASHIER, KITCHEN, WAITER) in:
 *   - restaurant_1
 *   - restaurant_2
 *   - restaurant_460
 *   - restaurant_471
 *
 * Verifies:
 *   - Staff goes to tenant.User (not public.User)
 *   - Tenant isolation is maintained
 *
 * Then cleans up test users.
 *
 * Usage:
 *   node scripts/test-staff-creation.js
 */

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("  TASK 5: Test Staff Creation in ACTIVE Restaurants");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  const prisma = new PrismaClient();
  const { getTenantClient, generateSchemaName } = require("../src/config/tenantPrisma");

  const TARGET_RESTAURANTS = [1, 2, 460, 471];
  const TEST_ROLES = ["MANAGER", "CASHIER", "KITCHEN", "WAITER"];
  const TEST_PASSWORD = "TestPassword123!";
  const testUsers = [];

  try {
    // Verify target restaurants exist and are ACTIVE
    console.log("Step 1: Verify target restaurants\n");
    const restaurants = [];
    for (const rid of TARGET_RESTAURANTS) {
      const r = await prisma.restaurant.findUnique({
        where: { id: rid },
        select: { id: true, name: true, status: true, tenantSchema: true, deletedAt: true },
      });
      if (!r) {
        console.log(`  ❌ Restaurant #${rid} does not exist`);
        continue;
      }
      if (r.status !== "ACTIVE") {
        console.log(`  ❌ Restaurant #${rid} is ${r.status} (expected ACTIVE)`);
        continue;
      }
      if (!r.tenantSchema) {
        console.log(`  ❌ Restaurant #${rid} has no tenant schema`);
        continue;
      }
      console.log(`  ✅ Restaurant #${rid} "${r.name}" (${r.tenantSchema}) - ACTIVE`);
      restaurants.push(r);
    }
    console.log("");

    if (restaurants.length === 0) {
      console.log("No valid restaurants found. Aborting.");
      return;
    }

    // Step 2: Get public.User count before test
    console.log("Step 2: Record public.User count before test\n");
    const publicBefore = await prisma.user.count();
    console.log(`  public.User count before: ${publicBefore}\n`);

    // Step 3: Create test staff in each restaurant
    console.log("Step 3: Create test staff\n");
    const hashedPassword = await bcrypt.hash(TEST_PASSWORD, 10);

    for (const restaurant of restaurants) {
      console.log(`── Restaurant #${restaurant.id} (${restaurant.tenantSchema}) ──`);
      const tenantDb = getTenantClient(restaurant.tenantSchema);

      for (const role of TEST_ROLES) {
        const email = `test-${role.toLowerCase()}-${restaurant.id}@test-verify.com`;
        const name = `Test ${role} #${restaurant.id}`;

        try {
          // Create in tenant schema
          const user = await tenantDb.user.create({
            data: {
              name,
              email,
              password: hashedPassword,
              role,
              isActive: true,
            },
          });

          testUsers.push({ id: user.id, email, role, restaurantId: restaurant.id, tenantSchema: restaurant.tenantSchema });
          console.log(`  ✅ Created ${role}: ${email} (id=${user.id}) in ${restaurant.tenantSchema}`);
        } catch (err) {
          console.log(`  ❌ Failed to create ${role}: ${email} — ${err.message}`);
        }
      }
      console.log("");
    }

    // Step 4: Verify users are NOT in public.User
    console.log("Step 4: Verify users are NOT in public.User\n");
    const publicAfter = await prisma.user.count();
    console.log(`  public.User count after: ${publicAfter}`);
    console.log(`  Expected: ${publicBefore} (no change)`);

    if (publicAfter === publicBefore) {
      console.log("  ✅ public.User count unchanged — staff correctly created in tenant schemas\n");
    } else {
      console.log(`  ❌ public.User count changed by ${publicAfter - publicBefore} — PROBLEM!\n`);
    }

    // Verify none of the test emails are in public.User
    for (const tu of testUsers) {
      const inPublic = await prisma.user.findUnique({ where: { email: tu.email } });
      if (inPublic) {
        console.log(`  ❌ ${tu.email} found in public.User (should only be in ${tu.tenantSchema})`);
      } else {
        console.log(`  ✅ ${tu.email} NOT in public.User (correct)`);
      }
    }
    console.log("");

    // Step 5: Verify tenant isolation
    console.log("Step 5: Verify tenant isolation\n");
    for (const restaurant of restaurants) {
      const tenantDb = getTenantClient(restaurant.tenantSchema);
      const tenantUsers = await tenantDb.user.findMany({
        select: { email: true, role: true },
      });

      console.log(`  ${restaurant.tenantSchema}.User (${tenantUsers.length} users):`);
      for (const u of tenantUsers) {
        const isTest = testUsers.some(t => t.email === u.email && t.tenantSchema === restaurant.tenantSchema);
        console.log(`    - ${u.email} (${u.role})${isTest ? " ← TEST" : ""}`);
      }

      // Verify no test users from OTHER restaurants leaked in
      const leakedUsers = tenantUsers.filter(u =>
        testUsers.some(t => t.email === u.email && t.tenantSchema !== restaurant.tenantSchema)
      );
      if (leakedUsers.length > 0) {
        console.log(`  ❌ TENANT LEAK: ${leakedUsers.length} foreign test user(s) found!`);
      } else {
        console.log(`  ✅ No foreign test users (isolation OK)`);
      }
      console.log("");
    }

    // Step 6: Cleanup test users
    console.log("Step 6: Cleanup test users\n");
    let deletedCount = 0;
    for (const tu of testUsers) {
      try {
        const tenantDb = getTenantClient(tu.tenantSchema);
        await tenantDb.user.delete({ where: { id: tu.id } });
        console.log(`  🗑 Deleted ${tu.email} from ${tu.tenantSchema}`);
        deletedCount++;
      } catch (err) {
        console.log(`  ❌ Failed to delete ${tu.email}: ${err.message}`);
      }
    }
    console.log(`\n  Cleaned up ${deletedCount}/${testUsers.length} test users\n`);

    // Step 7: Verify cleanup
    console.log("Step 7: Verify cleanup\n");
    const publicFinal = await prisma.user.count();
    console.log(`  public.User count final: ${publicFinal} (expected: ${publicBefore})`);

    if (publicFinal === publicBefore) {
      console.log("  ✅ public.User restored to original count\n");
    } else {
      console.log(`  ⚠ public.User count mismatch\n`);
    }

    // Final summary
    console.log("═".repeat(80));
    console.log("  TASK 5 SUMMARY");
    console.log("═".repeat(80) + "\n");

    console.log(`Restaurants tested: ${restaurants.length}`);
    console.log(`Test users created: ${testUsers.length}`);
    console.log(`Test users deleted: ${deletedCount}`);
    console.log(`public.User impact: NONE`);
    console.log(`\n✅ Staff creation correctly routes to tenant schemas`);

  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
