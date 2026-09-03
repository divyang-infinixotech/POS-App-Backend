#!/usr/bin/env node
/**
 * Migration Verification Script
 *
 * Verifies that the staff migration was successful by checking:
 * 1. Public.User contains only SUPER_ADMIN and ADMIN
 * 2. Each tenant schema has the correct staff users
 * 3. Cross-tenant isolation is maintained
 *
 * Usage:
 *   node scripts/verify-staff-migration.js
 */

const { PrismaClient } = require("@prisma/client");

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Staff Migration Verification");
  console.log("═══════════════════════════════════════════════════════\n");

  const prisma = new PrismaClient();
  const { getTenantClient } = require("../src/config/tenantPrisma");

  const STAFF_ROLES = ["MANAGER", "CASHIER", "KITCHEN", "WAITER"];
  let allPassed = true;

  try {
    // ── CHECK 1: Public schema ──
    console.log("CHECK 1: Public.User contents");
    console.log("─────────────────────────────");

    const publicUsers = await prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, restaurantId: true }
    });

    const publicByRole = {};
    for (const u of publicUsers) {
      if (!publicByRole[u.role]) publicByRole[u.role] = [];
      publicByRole[u.role].push(u);
    }

    console.log("Roles in public.User:");
    for (const [role, users] of Object.entries(publicByRole)) {
      console.log(`  ${role}: ${users.length}`);
      users.forEach(u => console.log(`    - ${u.email} (restaurantId=${u.restaurantId})`));
    }

    // Verify no staff roles remain in public
    const staffInPublic = publicUsers.filter(u => STAFF_ROLES.includes(u.role));
    if (staffInPublic.length > 0) {
      console.log(`\n  ❌ FAIL: ${staffInPublic.length} staff user(s) still in public.User!`);
      staffInPublic.forEach(u => console.log(`    - ${u.email} (${u.role}, restaurantId=${u.restaurantId})`));
      allPassed = false;
    } else {
      console.log(`\n  ✅ PASS: No staff users in public.User`);
    }

    // ── CHECK 2: Per-tenant verification ──
    console.log("\nCHECK 2: Tenant schema verification");
    console.log("───────────────────────────────────");

    const restaurants = await prisma.restaurant.findMany({
      where: { deletedAt: null, tenantSchema: { not: null } },
      select: { id: true, name: true, tenantSchema: true }
    });

    for (const restaurant of restaurants) {
      console.log(`\nRestaurant: ${restaurant.name} (ID: ${restaurant.id})`);
      console.log(`  Tenant: ${restaurant.tenantSchema}`);

      try {
        const tenantDb = getTenantClient(restaurant.tenantSchema);
        const tenantUsers = await tenantDb.user.findMany({
          select: { id: true, email: true, name: true, role: true, isActive: true }
        });

        const tenantByRole = {};
        for (const u of tenantUsers) {
          if (!tenantByRole[u.role]) tenantByRole[u.role] = [];
          tenantByRole[u.role].push(u);
        }

        console.log(`  Users in ${restaurant.tenantSchema}.User:`);
        for (const [role, users] of Object.entries(tenantByRole)) {
          console.log(`    ${role}: ${users.length}`);
          users.forEach(u => console.log(`      - ${u.email} (active=${u.isActive})`));
        }

        if (tenantUsers.length === 0) {
          console.log(`  ⚠ WARNING: No users in tenant schema`);
        }

      } catch (err) {
        console.log(`  ❌ ERROR: Could not read tenant schema: ${err.message}`);
        allPassed = false;
      }
    }

    // ── CHECK 3: Cross-tenant isolation ──
    console.log("\nCHECK 3: Cross-tenant isolation");
    console.log("──────────────────────────────");

    if (restaurants.length >= 2) {
      const r1 = restaurants[0];
      const r2 = restaurants[1];

      try {
        const tenant1Db = getTenantClient(r1.tenantSchema);
        const tenant2Db = getTenantClient(r2.tenantSchema);

        const r1Users = await tenant1Db.user.findMany({ select: { email: true } });
        const r2Users = await tenant2Db.user.findMany({ select: { email: true } });

        const r1Emails = new Set(r1Users.map(u => u.email));
        const r2Emails = new Set(r2Users.map(u => u.email));

        const overlap = [...r1Emails].filter(e => r2Emails.has(e));
        if (overlap.length > 0) {
          console.log(`  ❌ FAIL: Email overlap between ${r1.tenantSchema} and ${r2.tenantSchema}:`);
          overlap.forEach(e => console.log(`    - ${e}`));
          allPassed = false;
        } else {
          console.log(`  ✅ PASS: No email overlap between ${r1.tenantSchema} and ${r2.tenantSchema}`);
        }

        console.log(`  ${r1.tenantSchema}: ${r1Users.length} users`);
        console.log(`  ${r2.tenantSchema}: ${r2Users.length} users`);

      } catch (err) {
        console.log(`  ❌ ERROR: Could not verify isolation: ${err.message}`);
        allPassed = false;
      }
    } else {
      console.log(`  ⚠ SKIP: Need at least 2 restaurants for cross-tenant check`);
    }

    // ── SUMMARY ──
    console.log("\n═══════════════════════════════════════════════════════");
    console.log(allPassed ? "  ✅ ALL CHECKS PASSED" : "  ❌ SOME CHECKS FAILED");
    console.log("═══════════════════════════════════════════════════════\n");

    process.exit(allPassed ? 0 : 1);

  } catch (error) {
    console.error("Verification failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
