/**
 * READ-ONLY live-verification inspection.
 * Lists restaurants, tenant schemas, user roles (public + tenant),
 * active orders, occupied tables and merge groups so the live tests can
 * pick accounts/data. Makes NO writes.
 *
 * Usage: node qa/live-verify-inspect.js   (cwd = restaurant-pos-backend)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");
const { getTenantClient, isValidSchemaName } = require("../src/config/tenantPrisma");

(async () => {
  const restaurants = await platformPrisma.restaurant.findMany({
    orderBy: { id: "asc" },
    select: { id: true, name: true, status: true, tenantSchema: true, deletedAt: true, subscriptionPlan: true },
  });
  console.log(`\n=== RESTAURANTS (${restaurants.length}) ===`);
  for (const r of restaurants) {
    console.log(`  #${r.id} ${r.name} | status=${r.status} | plan=${r.subscriptionPlan} | tenantSchema=${r.tenantSchema} | deletedAt=${r.deletedAt ? "YES" : "no"}`);
  }

  const pubUsers = await platformPrisma.user.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, email: true, role: true, isActive: true, restaurantId: true },
    orderBy: { id: "asc" },
  });
  console.log(`\n=== PUBLIC USER (${pubUsers.length}) — first 30 ===`);
  for (const u of pubUsers.slice(0, 30)) {
    console.log(`  #${u.id} ${u.role.padEnd(12)} active=${u.isActive} restId=${u.restaurantId ?? "-"} ${u.email}`);
  }

  // Tenant inspection
  const activeTenantRests = restaurants.filter((r) => r.tenantSchema && isValidSchemaName(r.tenantSchema) && r.status === "ACTIVE" && !r.deletedAt);
  console.log(`\n=== TENANT SCHEMAS (${activeTenantRests.length}) ===`);
  for (const r of activeTenantRests) {
    const db = getTenantClient(r.tenantSchema);
    try {
      const users = await db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, email: true, role: true, isActive: true },
        orderBy: { id: "asc" },
      });
      const activeOrders = await db.order.count({
        where: { status: { in: ["PENDING", "PREPARING", "READY"] }, isDeleted: false },
      });
      const occupiedTables = await db.restaurantTable.count({ where: { status: "OCCUPIED" } });
      const mergeGroups = await db.mergeGroup.count();
      const activeMergeGroups = await db.mergeGroup.count({ where: { status: "ACTIVE" } });
      const menuItems = await db.menuItem.count();
      const categories = await db.category.count();
      console.log(`  Schema ${r.tenantSchema} (#${r.id} ${r.name}):`);
      console.log(`    users=${users.length} activeOrders=${activeOrders} occupiedTables=${occupiedTables} mergeGroups=${mergeGroups} (active ${activeMergeGroups}) menu=${menuItems} categories=${categories}`);
      const roleCounts = {};
      for (const u of users) roleCounts[u.role] = (roleCounts[u.role] || 0) + 1;
      console.log(`    roles: ${JSON.stringify(roleCounts)}`);
      const waiterEmails = users.filter((u) => u.role === "WAITER").map((u) => `${u.id}:${u.email}:${u.isActive ? "active" : "inactive"}`);
      console.log(`    waiters: ${waiterEmails.join(", ") || "(none)"}`);
      const adminLike = users.filter((u) => u.role === "ADMIN" || u.role === "MANAGER" || u.role === "CASHIER").map((u) => `${u.id}:${u.role}:${u.email}`);
      console.log(`    staff: ${adminLike.join(", ") || "(none)"}`);
    } catch (err) {
      console.log(`  Schema ${r.tenantSchema} (#${r.id}) ERROR: ${err.message.split("\n")[0]}`);
    }
  }

  await platformPrisma.$disconnect();
  console.log("\nInspection done.");
  process.exit(0);
})().catch(async (e) => {
  console.error("CRASH:", e.message);
  try { await platformPrisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
