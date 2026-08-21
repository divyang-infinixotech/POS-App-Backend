/**
 * Safe, idempotent migration — grants the DASHBOARD module wherever it is missing.
 *
 * Root cause fixed:
 *   Restaurants assigned to legacy plans (e.g. PRO, created before the Dashboard
 *   module existed) have subscription snapshots and Plan rows whose `features`
 *   array lacks "dashboard". The requireFeature("dashboard") middleware then
 *   correctly returns 403 for GET /api/dashboard.
 *
 * SCOPE: This is a one-time, policy-neutral backfill. Dashboard is the landing
 * screen for every restaurant, so it is treated as a baseline module and added
 * to ANY plan/subscription missing it (including old plans like PRO). Super
 * Admins can still toggle Dashboard off later via the plan editor. The script
 * ONLY adds "dashboard" — it never removes a granted feature, never touches
 * limits/pricing/status, and never disables permission checks. It is safe to
 * re-run at any time (no-op when healthy).
 *
 * Run with:  node scripts/fix-dashboard-feature.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("=== DASHBOARD FEATURE MIGRATION ===\n");

  // ── 0. Before-state diagnostics ─────────────────────────────────────────
  const beforePlans = await prisma.plan.findMany({ select: { id: true, code: true, features: true } });
  const beforeSubs = await prisma.subscription.findMany({
    select: { id: true, restaurantId: true, plan: true, features: true },
  });
  console.log("BEFORE:");
  beforePlans.forEach((p) =>
    console.log(
      "  plan " + p.code + " id=" + p.id + " hasDashboard=" + (p.features || []).includes("dashboard")
    )
  );
  beforeSubs.forEach((s) =>
    console.log(
      "  sub#" + s.id + " restaurant=" + s.restaurantId + " plan=" + s.plan +
      " hasDashboard=" + ((s.features || []).includes("dashboard"))
    )
  );

  // ── 1. Ensure the Dashboard module exists in the catalog ────────────────
  const dashModule = await prisma.planModule.upsert({
    where: { key: "dashboard" },
    update: { name: "Dashboard", icon: "layout-dashboard", isActive: true },
    create: { key: "dashboard", name: "Dashboard", icon: "layout-dashboard", sortOrder: 1, isActive: true },
  });
  console.log("\n[catalog] dashboard module id=" + dashModule.id);

  // ── 2. Fix every Plan row (features + relational permission) ────────────
  let plansFixed = 0;
  let permsFixed = 0;
  for (const plan of beforePlans) {
    const features = Array.isArray(plan.features) ? plan.features : [];
    if (!features.includes("dashboard")) {
      await prisma.plan.update({
        where: { id: plan.id },
        data: { features: ["dashboard", ...features] },
      });
      plansFixed++;
      console.log("[plan] +dashboard -> " + plan.code);
    }
    const perm = await prisma.planModulePermission.findUnique({
      where: { planId_moduleId: { planId: plan.id, moduleId: dashModule.id } },
    });
    if (!perm || !perm.isEnabled) {
      await prisma.planModulePermission.upsert({
        where: { planId_moduleId: { planId: plan.id, moduleId: dashModule.id } },
        update: { isEnabled: true },
        create: { planId: plan.id, moduleId: dashModule.id, isEnabled: true },
      });
      permsFixed++;
      console.log("[perm] enable dashboard -> " + plan.code);
    }
  }

  // ── 3. Fix every Subscription snapshot (additive union) ─────────────────
  let subsFixed = 0;
  for (const sub of beforeSubs) {
    const features = Array.isArray(sub.features) ? sub.features : [];
    if (!features.includes("dashboard")) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { features: ["dashboard", ...features] },
      });
      subsFixed++;
      console.log("[sub] +dashboard -> sub#" + sub.id + " (restaurant " + sub.restaurantId + ", plan " + sub.plan + ")");
    }
  }

  // ── 4. After-state verification ─────────────────────────────────────────
  const afterPlans = await prisma.plan.findMany({ select: { id: true, code: true, features: true } });
  const afterSubs = await prisma.subscription.findMany({
    select: { id: true, restaurantId: true, plan: true, features: true },
  });
  console.log("\nAFTER:");
  afterPlans.forEach((p) =>
    console.log(
      "  plan " + p.code + " id=" + p.id + " hasDashboard=" + (p.features || []).includes("dashboard")
    )
  );
  afterSubs.forEach((s) =>
    console.log(
      "  sub#" + s.id + " restaurant=" + s.restaurantId + " plan=" + s.plan +
      " hasDashboard=" + ((s.features || []).includes("dashboard"))
    )
  );

  const brokenPlans = afterPlans.filter((p) => !(p.features || []).includes("dashboard")).length;
  const brokenSubs = afterSubs.filter((s) => !(s.features || []).includes("dashboard")).length;
  console.log("\nRESULT: plansFixed=" + plansFixed + " permsFixed=" + permsFixed + " subsFixed=" + subsFixed);
  if (brokenPlans === 0 && brokenSubs === 0) {
    console.log("VERIFIED: every plan and every subscription now includes 'dashboard'.");
  } else {
    throw new Error(brokenPlans + " plans and " + brokenSubs + " subscriptions still missing dashboard.");
  }
}

main()
  .catch((e) => {
    console.error("Migration failed:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
