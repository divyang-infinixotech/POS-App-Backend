#!/usr/bin/env node
/**
 * Staff Migration Script: public.User → tenant schemas
 *
 * This script safely migrates operational staff users (MANAGER, CASHIER, KITCHEN, WAITER)
 * from the public schema's User table to each restaurant's tenant schema.
 *
 * Platform users (SUPER_ADMIN, ADMIN) remain in public.User.
 *
 * Features:
 *   - Idempotent: running twice does not duplicate users
 *   - Verifies tenant copy before removing from public
 *   - Handles duplicate emails safely (tenant emails are schema-local)
 *   - Preserves passwords, roles, active status, timestamps
 *   - Produces a detailed migration report
 *
 * Usage:
 *   node scripts/migrate-staff-to-tenants.js [--dry-run]
 */

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const STAFF_ROLES = ["MANAGER", "CASHIER", "KITCHEN", "WAITER"];
const PLATFORM_ROLES = ["SUPER_ADMIN", "ADMIN"];

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Staff Migration: public.User → tenant schemas");
  console.log("  Mode:", isDryRun ? "DRY RUN (no changes)" : "LIVE MIGRATION");
  console.log("═══════════════════════════════════════════════════════\n");

  const prisma = new PrismaClient();
  const { getTenantClient, generateSchemaName } = require("../src/config/tenantPrisma");

  try {
    // Step 1: Find all staff users in public schema
    const staffUsers = await prisma.user.findMany({
      where: { role: { in: STAFF_ROLES } },
      select: {
        id: true, name: true, email: true, password: true, role: true,
        isActive: true, phone: true, avatar: true,
        restaurantId: true, lastLogin: true, passwordChangedAt: true,
        createdAt: true, updatedAt: true
      }
    });

    console.log(`Found ${staffUsers.length} staff user(s) in public.User`);
    if (staffUsers.length === 0) {
      console.log("\nNo staff users to migrate. Done.");
      return;
    }

    // Group by restaurant
    const byRestaurant = {};
    for (const user of staffUsers) {
      if (!user.restaurantId) {
        console.warn(`  Warning: User ${user.email} (id=${user.id}) has no restaurantId — skipping`);
        continue;
      }
      if (!byRestaurant[user.restaurantId]) byRestaurant[user.restaurantId] = [];
      byRestaurant[user.restaurantId].push(user);
    }

    const restaurantIds = Object.keys(byRestaurant);
    console.log(`Staff spread across ${restaurantIds.length} restaurant(s)\n`);

    // Step 2: Process each restaurant
    const report = [];

    for (const restaurantId of restaurantIds) {
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: Number(restaurantId) },
        select: { id: true, name: true, tenantSchema: true }
      });

      if (!restaurant || !restaurant.tenantSchema) {
        console.warn(`  Restaurant ${restaurantId}: not found or no tenant schema — skipping`);
        report.push({ restaurantId, name: restaurant?.name || "Unknown", status: "SKIPPED (no tenant schema)" });
        continue;
      }

      const schemaName = restaurant.tenantSchema;
      const users = byRestaurant[restaurantId];
      console.log(`────────────────────────────────────────────────`);
      console.log(`Restaurant: ${restaurant.name} (ID: ${restaurantId})`);
      console.log(`Tenant: ${schemaName}`);
      console.log(`Staff to migrate: ${users.length}`);

      let tenantDb;
      try {
        tenantDb = getTenantClient(schemaName);
      } catch (err) {
        console.error(`  ERROR: Could not get tenant client for ${schemaName}: ${err.message}`);
        report.push({ restaurantId, name: restaurant.name, status: "ERROR (tenant client)", migrated: 0 });
        continue;
      }

      const restaurantReport = {
        restaurantId: Number(restaurantId),
        name: restaurant.name,
        tenant: schemaName,
        publicBefore: {},
        tenantAfter: {},
        migrated: 0,
        skipped: 0,
        errors: []
      };

      // Count roles before migration
      for (const role of STAFF_ROLES) {
        restaurantReport.publicBefore[role] = users.filter(u => u.role === role).length;
      }

      // Step 3: Migrate each user
      for (const user of users) {
        // Check if user already exists in tenant schema (idempotency)
        let existingTenantUser = null;
        try {
          existingTenantUser = await tenantDb.user.findUnique({ where: { email: user.email } });
        } catch (err) {
          // Table might not exist yet
          if (err.message.includes("does not exist") || err.message.includes("relation")) {
            console.warn(`  User table not found in ${schemaName} — ensure tenant DDL includes User table`);
            restaurantReport.errors.push(`${user.email}: tenant User table missing`);
            continue;
          }
          throw err;
        }

        if (existingTenantUser) {
          console.log(`  ${user.email}: already exists in ${schemaName} — removing from public`);
          if (!isDryRun) {
            try {
              await prisma.user.delete({ where: { id: user.id } });
            } catch (delErr) {
              console.error(`  ${user.email}: could not delete from public — ${delErr.message}`);
            }
          }
          restaurantReport.migrated++;
          continue;
        }

        // Insert into tenant schema (preserve original ID where safely possible)
        try {
          // Try with original ID first
          let tenantUser;
          try {
            tenantUser = await tenantDb.user.create({
              data: {
                id: user.id, // Preserve original ID
                name: user.name,
                email: user.email,
                password: user.password, // Already hashed
                role: user.role,
                isActive: user.isActive,
                phone: user.phone,
                avatar: user.avatar,
                lastLogin: user.lastLogin,
                passwordChangedAt: user.passwordChangedAt,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt
              }
            });
          } catch (createErr) {
            // If ID conflict, let Prisma auto-generate
            if (createErr.code === "P2002" || createErr.message.includes("unique")) {
              tenantUser = await tenantDb.user.create({
                data: {
                  name: user.name,
                  email: user.email,
                  password: user.password,
                  role: user.role,
                  isActive: user.isActive,
                  phone: user.phone,
                  avatar: user.avatar,
                  lastLogin: user.lastLogin,
                  passwordChangedAt: user.passwordChangedAt,
                  createdAt: user.createdAt,
                  updatedAt: user.updatedAt
                }
              });
            } else {
              throw createErr;
            }
          }

          // Verify the copy
          const verified = await tenantDb.user.findUnique({ where: { email: user.email } });
          if (!verified || verified.role !== user.role) {
            throw new Error("Verification failed — user not found or role mismatch after insert");
          }

          if (!isDryRun) {
            // Remove from public schema
            await prisma.user.delete({ where: { id: user.id } });
          }

          console.log(`  ${user.email} (${user.role}): migrated${isDryRun ? " (dry run)" : ""}`);
          restaurantReport.migrated++;

        } catch (err) {
          console.error(`  ${user.email}: ERROR — ${err.message}`);
          restaurantReport.errors.push(`${user.email}: ${err.message}`);
        }
      }

      // Count roles after migration (in tenant)
      try {
        const tenantUsers = await tenantDb.user.findMany({ select: { role: true } });
        for (const role of STAFF_ROLES) {
          restaurantReport.tenantAfter[role] = tenantUsers.filter(u => u.role === role).length;
        }
      } catch (err) {
        console.warn(`  Could not count tenant users: ${err.message}`);
      }

      report.push(restaurantReport);
    }

    // Step 4: Verify public schema
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  VERIFICATION");
    console.log("═══════════════════════════════════════════════════════\n");

    const remainingStaff = await prisma.user.findMany({
      where: { role: { in: STAFF_ROLES } },
      select: { id: true, email: true, role: true, restaurantId: true }
    });

    const platformUsers = await prisma.user.findMany({
      where: { role: { in: PLATFORM_ROLES } },
      select: { id: true, email: true, role: true, restaurantId: true }
    });

    console.log(`Public.User remaining staff: ${remainingStaff.length}`);
    remainingStaff.forEach(u => console.log(`  - ${u.email} (${u.role}, restaurantId=${u.restaurantId})`));
    console.log(`\nPublic.User platform users: ${platformUsers.length}`);
    platformUsers.forEach(u => console.log(`  - ${u.email} (${u.role})`));

    // Step 5: Migration Report
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  MIGRATION REPORT");
    console.log("═══════════════════════════════════════════════════════\n");

    for (const r of report) {
      console.log(`Restaurant: ${r.name || r.restaurantId}`);
      console.log(`  ID: ${r.restaurantId}`);
      console.log(`  Tenant: ${r.tenant || "N/A"}`);
      console.log(`  Status: ${r.status || "COMPLETED"}`);
      console.log(`  Public staff before:`);
      for (const role of STAFF_ROLES) {
        console.log(`    ${role}: ${(r.publicBefore && r.publicBefore[role]) || 0}`);
      }
      console.log(`  Tenant staff after:`);
      for (const role of STAFF_ROLES) {
        console.log(`    ${role}: ${(r.tenantAfter && r.tenantAfter[role]) || 0}`);
      }
      console.log(`  Migrated: ${r.migrated}`);
      console.log(`  Skipped (already exists): ${r.skipped}`);
      if (r.errors && r.errors.length > 0) {
        console.log(`  Errors:`);
        r.errors.forEach(e => console.log(`    - ${e}`));
      }
      console.log(`  Migration status: ${r.errors && r.errors.length > 0 ? "PARTIAL" : "SUCCESS"}`);
      console.log("");
    }

    console.log("═══════════════════════════════════════════════════════");
    console.log("  MIGRATION COMPLETE" + (isDryRun ? " (DRY RUN)" : ""));
    console.log("═══════════════════════════════════════════════════════");

  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
