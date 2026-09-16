/** One-off: restore a public ADMIN + tenant mirror row for restaurant 2. */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient();

(async () => {
  const hash = await bcrypt.hash("Admin@123", 10);
  const existing = await prisma.user.findFirst({ where: { restaurantId: 2, role: "ADMIN" } });
  if (!existing) {
    await prisma.user.create({
      data: {
        restaurantId: 2,
        name: "R2 Admin",
        email: "admin-2@restaurant.com",
        password: hash,
        role: "ADMIN",
        isActive: true,
      },
    });
    console.log("public ADMIN created for restaurant 2 (admin-2@restaurant.com / Admin@123)");
  } else {
    console.log("public ADMIN for restaurant 2 already present");
  }

  // Tenant mirror row — role enum is per-schema, so COPY it from an existing
  // tenant row instead of casting across schemas.
  const copied = await prisma.$executeRawUnsafe(`
    INSERT INTO "restaurant_2"."User" (name, email, password, role, "isActive", "restaurantId")
    SELECT 'R2 Admin', 'admin-2@restaurant.com', '${hash}', role, true, 2
    FROM "restaurant_2"."User" u
    WHERE u.role = 'ADMIN'
      AND NOT EXISTS (SELECT 1 FROM "restaurant_2"."User" WHERE email = 'admin-2@restaurant.com')
    LIMIT 1
  `);
  console.log("tenant mirror row inserted:", copied === 1);
  const rows = await prisma.$queryRawUnsafe('SELECT id, name, email, role FROM "restaurant_2"."User"');
  console.log("restaurant_2.User rows:", JSON.stringify(rows));
  process.exit(0);
})()
  .catch((e) => { console.error("ERR:", e.message); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
