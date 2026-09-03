require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const bcrypt = require("bcryptjs");
const { platformPrisma } = require("../src/config/tenantPrisma");

(async () => {
  const admin = await platformPrisma.user.findUnique({ where: { email: "admin@restaurant.com" }, select: { id: true, email: true, role: true, isActive: true, deletedAt: true, password: true, passwordChangedAt: true } });
  console.log("admin row:", admin ? { id: admin.id, email: admin.email, role: admin.role, isActive: admin.isActive, deletedAt: admin.deletedAt, passwordChangedAt: admin.passwordChangedAt, hashPrefix: admin.password.slice(0, 7) } : "NOT FOUND");
  if (admin) {
    const cands = ["password123", "SubPass@123", "Admin@123", "admin123", "Password@123", "admin@123", "Admin1234", "password", "password@123"];
    for (const c of cands) {
      const ok = await bcrypt.compare(c, admin.password);
      console.log(`  compare "${c}" → ${ok}`);
      if (ok) break;
    }
  }
  // compare with tenant manager hash (known seeded password123) to sanity-check the compare method
  const { getTenantClient } = require("../src/config/tenantPrisma");
  const tdb = getTenantClient("restaurant_1");
  const mgr = await tdb.user.findUnique({ where: { email: "manager@restaurant.com" }, select: { id: true, email: true, password: true } });
  console.log("manager hash check password123 →", mgr ? await bcrypt.compare("password123", mgr.password) : "not found");
  await platformPrisma.$disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
