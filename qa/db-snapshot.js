// QA helper: print current DB state for the seeded restaurants
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const restaurants = await prisma.restaurant.findMany({
    select: { id: true, name: true, email: true, status: true, deletedAt: true },
    orderBy: { id: 'asc' },
  });
  console.log('\n=== RESTAURANTS ===');
  for (const r of restaurants) console.log(r);

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, restaurantId: true, isActive: true, deletedAt: true },
    orderBy: { id: 'asc' },
    take: 40,
  });
  console.log('\n=== USERS (first 40) ===');
  for (const u of users) console.log(u);

  const cats = await prisma.category.findMany({ select: { id: true, name: true, restaurantId: true }, take: 10 });
  console.log('\n=== CATEGORIES ===');
  for (const c of cats) console.log(c);

  const items = await prisma.menuItem.findMany({ select: { id: true, name: true, price: true, currentStock: true, restaurantId: true, categoryId: true }, take: 10 });
  console.log('\n=== MENU ITEMS ===');
  for (const i of items) console.log(i);

  const floors = await prisma.floor.findMany({ select: { id: true, name: true, restaurantId: true } });
  console.log('\n=== FLOORS ===');
  for (const f of floors) console.log(f);

  const tables = await prisma.restaurantTable.findMany({ select: { id: true, name: true, status: true, floorId: true, restaurantId: true } });
  console.log('\n=== TABLES ===');
  for (const t of tables) console.log(t);

  const orders = await prisma.order.findMany({ select: { id: true, orderNumber: true, status: true, tableId: true, restaurantId: true, total: true, createdAt: true }, orderBy: { id: 'desc' }, take: 10 });
  console.log('\n=== ORDERS (recent) ===');
  for (const o of orders) console.log(o);

  const kots = await prisma.kot.findMany({ select: { id: true, kotNumber: true, status: true, orderId: true }, orderBy: { id: 'desc' }, take: 10 });
  console.log('\n=== KOTs (recent) ===');
  for (const k of kots) console.log(k);

  const bills = await prisma.bill.findMany({ select: { id: true, billNumber: true, status: true, orderId: true, total: true }, orderBy: { id: 'desc' }, take: 10 });
  console.log('\n=== BILLS (recent) ===');
  for (const b of bills) console.log(b);

  const subs = await prisma.subscription.findMany({ select: { id: true, restaurantId: true, planId: true, status: true } });
  console.log('\n=== SUBSCRIPTIONS ===');
  for (const s of subs) console.log(s);

  const plans = await prisma.plan.findMany({ select: { id: true, name: true, price: true } });
  console.log('\n=== PLANS ===');
  for (const p of plans) console.log(p);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
