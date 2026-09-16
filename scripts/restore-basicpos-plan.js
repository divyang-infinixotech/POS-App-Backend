/**
 * One-off: restore the missing BASIC_POS plan (lost with the public-schema
 * reset). Restores CONFIGURATION only — plans, module permissions and system
 * settings are config, not user data. Derives pricing from the existing BASIC
 * seed plan and enforces the RESTAURANT_ONLY capability map server-side, so a
 * Basic POS plan can never carry floors/tables/kitchen entitlements.
 *
 * Idempotent: safe to run multiple times.
 * Run: node scripts/restore-basicpos-plan.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const { filterModulesForBusinessMode } = require("../src/config/subscription.config");

async function main() {
  // 1. BASIC_POS plan (code BASIC_POS to avoid clashing with the existing
  //    restaurant-mode BASIC seed plan).
  const existing = await prisma.plan.findUnique({ where: { code: "BASIC_POS" } });
  if (!existing) {
    const basic = await prisma.plan.findUnique({ where: { code: "BASIC" } });
    const created = await prisma.plan.create({
      data: {
        code: "BASIC_POS",
        name: "Basic POS",
        description:
          "Counter billing without restaurant workflow: no floors, no tables, no KOT.",
        businessMode: "BASIC_POS",
        monthlyPrice: basic ? basic.monthlyPrice : 999,
        yearlyPrice: basic ? basic.yearlyPrice : 9990,
        billingCycle: basic ? basic.billingCycle : "MONTHLY",
        trialDays: basic ? basic.trialDays : 0,
        maxUsers: basic ? basic.maxUsers : 10,
        maxTables: null,
        maxFloors: null,
        maxMenuItems: basic ? basic.maxMenuItems : 250,
        maxPrinters: basic ? basic.maxPrinters : null,
        maxBranches: 1,
        maxOrdersPerMonth: basic ? basic.maxOrdersPerMonth : 5000,
        storageLimitMB: basic ? basic.storageLimitMB : 500,
        features: [],
        isActive: true,
        sortOrder: basic ? basic.sortOrder + 1 : 2,
      },
    });
    console.log(`Created plan BASIC_POS (id=${created.id})`);
  } else {
    console.log(`Plan BASIC_POS already exists (id=${existing.id})`);
  }

  const plan = await prisma.plan.findUnique({ where: { code: "BASIC_POS" } });

  // 2. Module permissions for the plan — capability-map filtered (no floors/
  //    tables/kitchen on a Basic POS plan).
  const modules = await prisma.planModule.findMany({ where: { isActive: true } });
  const allowed = filterModulesForBusinessMode(
    modules.map((m) => m.key),
    "BASIC_POS"
  );
  const allowedIds = new Set(
    modules.filter((m) => allowed.includes(m.key)).map((m) => m.id)
  );

  const existingPerms = await prisma.planModulePermission.findMany({
    where: { planId: plan.id },
  });
  const have = new Set(existingPerms.map((p) => p.moduleId));

  for (const m of modules) {
    if (!allowedIds.has(m.id)) continue;
    if (have.has(m.id)) continue;
    await prisma.planModulePermission.create({
      data: { planId: plan.id, moduleId: m.id, isEnabled: true },
    });
  }
  // features[] is the denormalized entitlement list used by requireFeature
  const finalAllowed = allowed;
  await prisma.plan.update({
    where: { id: plan.id },
    data: { features: finalAllowed },
  });

  const permCount = await prisma.planModulePermission.count({
    where: { planId: plan.id, isEnabled: true },
  });
  console.log(
    `BASIC_POS entitlements (${finalAllowed.length}): ${finalAllowed.join(", ")}`
  );
  console.log(`PlanModulePermission rows: ${permCount}`);

  // 3. SystemSetting: plans were previously seeded when the toggle was absent —
  //    leaving it unset means the feature is available (existing behavior).
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
