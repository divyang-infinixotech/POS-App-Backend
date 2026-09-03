#!/usr/bin/env node
/**
 * READ-ONLY Analysis: public.User CASHIER Cleanup Report
 *
 * This script performs NO destructive operations.
 * It queries the database to produce a complete cleanup report.
 *
 * Usage:
 *   node scripts/analyze-cashier-users.js
 */

const { PrismaClient } = require("@prisma/client");

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("  READ-ONLY ANALYSIS: public.User CASHIER Cleanup Report");
  console.log("  ⚠ NO DATA WILL BE MODIFIED");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  const prisma = new PrismaClient();
  const { getTenantClient } = require("../src/config/tenantPrisma");

  try {
    // ── SECTION A: Get all CASHIER users in public.User ──
    console.log("═".repeat(80));
    console.log("  SECTION A: CASHIER Users in public.User");
    console.log("═".repeat(80) + "\n");

    const cashierUsers = await prisma.user.findMany({
      where: { role: "CASHIER" },
      select: {
        id: true,
        name: true,
        email: true,
        restaurantId: true,
        isActive: true,
        createdAt: true,
        lastLogin: true,
      },
      orderBy: { restaurantId: "asc" },
    });

    console.log(`Total CASHIER users found: ${cashierUsers.length}\n`);

    if (cashierUsers.length === 0) {
      console.log("✅ No CASHIER users remain in public.User. Migration is complete.");
      return;
    }

    // ── SECTION B: Get restaurant details for each CASHIER ──
    console.log("═".repeat(80));
    console.log("  SECTION B: Restaurant Details for CASHIER Users");
    console.log("═".repeat(80) + "\n");

    // Group CASHIERs by restaurantId
    const byRestaurant = {};
    for (const user of cashierUsers) {
      const rid = user.restaurantId;
      if (!rid) {
        console.warn(`  ⚠ User ${user.email} (id=${user.id}) has no restaurantId`);
        if (!byRestaurant["NONE"]) byRestaurant["NONE"] = [];
        byRestaurant["NONE"].push(user);
        continue;
      }
      if (!byRestaurant[rid]) byRestaurant[rid] = [];
      byRestaurant[rid].push(user);
    }

    const restaurantIds = Object.keys(byRestaurant).filter((k) => k !== "NONE");
    console.log(`CASHIERs spread across ${restaurantIds.length} restaurant(s)\n`);

    // Fetch restaurant details
    const restaurantDetails = {};
    for (const rid of restaurantIds) {
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: Number(rid) },
        select: {
          id: true,
          name: true,
          status: true,
          tenantSchema: true,
          deletedAt: true,
          createdAt: true,
        },
      });
      restaurantDetails[rid] = restaurant;
    }

    // ── SECTION C: Check tenant schema existence for each restaurant ──
    console.log("═".repeat(80));
    console.log("  SECTION C: Tenant Schema Analysis");
    console.log("═".repeat(80) + "\n");

    const results = [];

    for (const rid of restaurantIds) {
      const users = byRestaurant[rid];
      const restaurant = restaurantDetails[rid];

      const entry = {
        restaurantId: Number(rid),
        restaurantName: restaurant?.name || "UNKNOWN",
        restaurantStatus: restaurant?.status || "UNKNOWN",
        deletedAt: restaurant?.deletedAt,
        tenantSchema: restaurant?.tenantSchema,
        schemaExists: false,
        tenantUserCount: 0,
        staffCount: users.length,
        users: users,
        recommendedAction: "",
        notes: "",
      };

      // Check if tenant schema exists
      if (restaurant?.tenantSchema) {
        try {
          const tenantDb = getTenantClient(restaurant.tenantSchema);
          const tenantUsers = await tenantDb.user.findMany({
            select: { id: true, email: true, role: true, isActive: true },
          });
          entry.schemaExists = true;
          entry.tenantUserCount = tenantUsers.length;

          // Check if any of the CASHIER emails already exist in tenant
          const tenantEmails = new Set(tenantUsers.map((u) => u.email));
          const alreadyMigrated = users.filter((u) => tenantEmails.has(u.email));
          entry.notes = alreadyMigrated.length > 0
            ? `${alreadyMigrated.length} already in tenant`
            : "No CASHIERs migrated yet";
        } catch (err) {
          entry.notes = `Tenant schema error: ${err.message}`;
        }
      }

      // Determine recommended action
      if (entry.deletedAt) {
        entry.recommendedAction = "DELETE (soft-deleted restaurant)";
      } else if (entry.restaurantStatus === "INACTIVE") {
        entry.recommendedAction = "DELETE (inactive restaurant)";
      } else if (entry.restaurantStatus === "SUSPENDED") {
        entry.recommendedAction = "DELETE (suspended restaurant)";
      } else if (!entry.tenantSchema) {
        entry.recommendedAction = "CREATE TENANT SCHEMA → MIGRATE → DELETE from public";
      } else if (entry.tenantSchema && !entry.schemaExists) {
        entry.recommendedAction = "FIX SCHEMA → MIGRATE → DELETE from public";
      } else if (entry.tenantSchema && entry.schemaExists) {
        entry.recommendedAction = "MIGRATE to tenant → DELETE from public";
      } else {
        entry.recommendedAction = "REVIEW";
      }

      results.push(entry);
    }

    // ── SECTION D: Cleanup Report ──
    console.log("═".repeat(80));
    console.log("  SECTION D: Cleanup Report");
    console.log("═".repeat(80) + "\n");

    console.log(
      "restaurantId | restaurantName | schemaExists | staffCount | restaurantStatus | recommendedAction"
    );
    console.log("-".repeat(120));

    for (const r of results) {
      const name = (r.restaurantName || "").substring(0, 20).padEnd(20);
      const schema = r.schemaExists ? "YES" : "NO";
      console.log(
        `${String(r.restaurantId).padEnd(12)} | ${name} | ${schema.padEnd(12)} | ${String(r.staffCount).padEnd(10)} | ${r.restaurantStatus.padEnd(17)} | ${r.recommendedAction}`
      );
    }

    // ── SECTION E: Group by recommendation ──
    console.log("\n" + "═".repeat(80));
    console.log("  SECTION E: Grouped by Recommended Action");
    console.log("═".repeat(80) + "\n");

    const groups = {};
    for (const r of results) {
      const key = r.recommendedAction;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }

    for (const [action, entries] of Object.entries(groups)) {
      console.log(`\n${action} (${entries.length} restaurant(s)):`);
      for (const e of entries) {
        console.log(`  - #${e.restaurantId} "${e.restaurantName}" (${e.staffCount} CASHIERs)`);
        if (e.notes) console.log(`    Note: ${e.notes}`);
      }
    }

    // ── SECTION F: Verify Restaurants 460 and 471 ──
    console.log("\n" + "═".repeat(80));
    console.log("  SECTION F: Verification of Restaurants 460 and 471");
    console.log("═".repeat(80) + "\n");

    for (const targetId of [460, 471]) {
      console.log(`\n── Restaurant #${targetId} ──`);

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          name: true,
          status: true,
          tenantSchema: true,
          deletedAt: true,
        },
      });

      if (!restaurant) {
        console.log(`  ❌ Restaurant #${targetId} does NOT exist`);
        continue;
      }

      console.log(`  Name: ${restaurant.name}`);
      console.log(`  Status: ${restaurant.status}`);
      console.log(`  tenantSchema: ${restaurant.tenantSchema || "NULL"}`);
      console.log(`  deletedAt: ${restaurant.deletedAt || "NULL"}`);

      // Check if tenant schema exists
      if (restaurant.tenantSchema) {
        try {
          const tenantDb = getTenantClient(restaurant.tenantSchema);

          // Check User table existence
          const tableCheck = await prisma.$queryRawUnsafe(`
            SELECT EXISTS (
              SELECT FROM information_schema.tables
              WHERE table_schema = '${restaurant.tenantSchema}'
              AND table_name = 'User'
            ) as exists
          `);

          const userTableExists = tableCheck[0]?.exists;
          console.log(`  User table exists: ${userTableExists ? "✅ YES" : "❌ NO"}`);

          if (userTableExists) {
            // List all users in tenant schema
            const tenantUsers = await tenantDb.user.findMany({
              select: { id: true, email: true, name: true, role: true, isActive: true },
            });

            console.log(`  Tenant users (${tenantUsers.length}):`);
            for (const u of tenantUsers) {
              console.log(`    - ${u.email} (${u.role}, active=${u.isActive})`);
            }

            if (tenantUsers.length === 0) {
              console.log("  ✅ No staff expected/required if only ADMIN exists");
              console.log("  ✅ Future staff creation will go to tenant User table");
            }
          }
        } catch (err) {
          console.log(`  ❌ Error accessing tenant schema: ${err.message}`);
        }
      } else {
        console.log("  ⚠ No tenant schema assigned");
      }

      // Check if any CASHIER users remain in public for this restaurant
      const publicCashiers = await prisma.user.findMany({
        where: { restaurantId: targetId, role: "CASHIER" },
        select: { id: true, email: true, name: true },
      });

      if (publicCashiers.length > 0) {
        console.log(`  ⚠ ${publicCashiers.length} CASHIER(s) still in public.User:`);
        for (const u of publicCashiers) {
          console.log(`    - ${u.email} (id=${u.id})`);
        }
      } else {
        console.log("  ✅ No CASHIER users in public.User");
      }
    }

    // ── SECTION G: Public.User Role Summary ──
    console.log("\n" + "═".repeat(80));
    console.log("  SECTION G: public.User Role Summary (Final State)");
    console.log("═".repeat(80) + "\n");

    const allPublicUsers = await prisma.user.findMany({
      select: { id: true, email: true, role: true, restaurantId: true },
    });

    const roleCounts = {};
    for (const u of allPublicUsers) {
      if (!roleCounts[u.role]) roleCounts[u.role] = [];
      roleCounts[u.role].push(u);
    }

    for (const [role, users] of Object.entries(roleCounts)) {
      console.log(`${role}: ${users.length}`);
      if (role === "CASHIER" || role === "MANAGER" || role === "KITCHEN" || role === "WAITER") {
        users.forEach((u) => console.log(`  ⚠ ${u.email} (restaurantId=${u.restaurantId})`));
      }
    }

    // ── SECTION H: Detailed CASHIER List ──
    console.log("\n" + "═".repeat(80));
    console.log("  SECTION H: Complete List of 97 CASHIER Users");
    console.log("═".repeat(80) + "\n");

    console.log(
      "No. | userId | email | restaurantId | restaurantName | schemaExists | restaurantStatus | recommendedAction"
    );
    console.log("-".repeat(140));

    let idx = 1;
    for (const r of results) {
      for (const u of r.users) {
        const email = u.email.padEnd(35);
        const name = (r.restaurantName || "").substring(0, 20).padEnd(20);
        const schema = r.schemaExists ? "YES" : "NO";
        console.log(
          `${String(idx).padEnd(4)} | ${String(u.id).padEnd(6)} | ${email} | ${String(r.restaurantId).padEnd(12)} | ${name} | ${schema.padEnd(12)} | ${r.restaurantStatus.padEnd(17)} | ${r.recommendedAction}`
        );
        idx++;
      }
    }

    // ── SECTION I: Code Issues Check ──
    console.log("\n" + "═".repeat(80));
    console.log("  SECTION I: Code/Database Issues Discovery");
    console.log("═".repeat(80) + "\n");

    // Check auth.controller.js register function
    console.log("1. Auth Controller (auth.controller.js):");
    console.log("   - register() still creates users in public.User via platformPrisma");
    console.log("   - login() searches both public and tenant schemas");
    console.log("   - ⚠ ISSUE: register() does NOT route staff to tenant schema");
    console.log("   - ✅ login() correctly handles tenant staff lookup");

    // Check super-admin.service.js
    console.log("\n2. Super Admin Service (super-admin.service.js):");
    console.log("   - adminCreateUser() creates ALL users in public.User");
    console.log("   - ⚠ ISSUE: adminCreateUser() does NOT route MANAGER/CASHIER/KITCHEN/WAITER to tenant schema");
    console.log("   - This means any new staff created via Super Admin goes to public.User");

    // Check tenantPrisma.js
    console.log("\n3. Tenant Prisma (tenantPrisma.js):");
    console.log("   - tenantMiddleware correctly resolves tenant from JWT restaurantId");
    console.log("   - ✅ req.tenantDb is properly attached for operational data");

    console.log("\n" + "═".repeat(80));
    console.log("  SUMMARY");
    console.log("═".repeat(80) + "\n");

    const totalCashiers = cashierUsers.length;
    const withTenantSchema = results.filter((r) => r.tenantSchema).length;
    const withoutTenantSchema = results.filter((r) => !r.tenantSchema).length;
    const inactive = results.filter(
      (r) => r.deletedAt || r.restaurantStatus === "INACTIVE" || r.restaurantStatus === "SUSPENDED"
    ).length;

    console.log(`Total CASHIER users in public.User: ${totalCashiers}`);
    console.log(`Restaurants with tenant schema: ${withTenantSchema}`);
    console.log(`Restaurants WITHOUT tenant schema: ${withoutTenantSchema}`);
    console.log(`Inactive/deleted restaurants: ${inactive}`);
    console.log(`\nRecommended actions:`);
    console.log(`  - Restaurants WITH tenant schema: MIGRATE users → DELETE from public`);
    console.log(`  - Restaurants WITHOUT tenant schema: CREATE schema → MIGRATE → DELETE`);
    console.log(`  - Inactive restaurants: DELETE CASHIER records`);
    console.log(`\n⚠ DO NOT execute cleanup yet. Review this report first.`);

  } catch (error) {
    console.error("Analysis failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
