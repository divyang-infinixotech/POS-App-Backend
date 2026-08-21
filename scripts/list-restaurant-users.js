/**
 * Helper: print users + subscription snapshot for a restaurant.
 * Usage: node scripts/list-restaurant-users.js 9
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const restaurantId = Number(process.argv[2]) || 1;

async function main() {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, name: true, subscriptionPlan: true, status: true },
  });
  console.log("RESTAURANT:", JSON.stringify(restaurant));

  const users = await prisma.user.findMany({
    where: { restaurantId, deletedAt: null },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  console.log("USERS:", JSON.stringify(users, null, 1));

  const sub = await prisma.subscription.findUnique({
    where: { restaurantId },
    select: { id: true, plan: true, status: true, features: true, planId: true },
  });
  console.log("SUBSCRIPTION:", JSON.stringify(sub, null, 1));
}

main()
  .catch((e) => {
    console.error("ERR:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
