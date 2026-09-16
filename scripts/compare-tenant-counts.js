const { platformPrisma } = require('../src/config/tenantPrisma');

const RESTAURANTS = [1, 2, 9];

const tables = [
  'RestaurantSetting',
  'Floor',
  'Category',
  'MenuItem',
  'Customer',
  'RestaurantTable',
  'Order',
  'OrderItem',
  'KOT',
  'Bill',
  'Payment',
  'StockMovement',
  'PrinterSetting',
  'AuditLog',
  'Notification',
];

async function countPublic(table, restaurantId) {
  if (table === 'OrderItem') {
    return platformPrisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count
      FROM public."OrderItem" oi
      INNER JOIN public."Order" o ON o.id = oi."orderId"
      WHERE o."restaurantId" = $1
    `, restaurantId);
  }

  if (table === 'RestaurantSetting' ||
      table === 'Floor' ||
      table === 'Category' ||
      table === 'MenuItem' ||
      table === 'Customer' ||
      table === 'RestaurantTable' ||
      table === 'Order' ||
      table === 'KOT' ||
      table === 'Bill' ||
      table === 'Payment' ||
      table === 'StockMovement' ||
      table === 'PrinterSetting' ||
      table === 'AuditLog' ||
      table === 'Notification') {
    return platformPrisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count
      FROM public."${table}"
      WHERE "restaurantId" = $1
    `, restaurantId);
  }

  return [{ count: 0 }];
}

async function countTenant(table, schema) {
  return platformPrisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count
    FROM "${schema}"."${table}"
  `);
}

async function run() {
  try {
    for (const restaurantId of RESTAURANTS) {
      const schema = `restaurant_${restaurantId}`;

      console.log(`\n========================================`);
      console.log(`RESTAURANT ${restaurantId}`);
      console.log(`SCHEMA: ${schema}`);
      console.log(`========================================`);

      const rows = [];

      for (const table of tables) {
        const publicResult = await countPublic(table, restaurantId);
        const tenantResult = await countTenant(table, schema);

        rows.push({
          table,
          public: Number(publicResult[0].count),
          tenant: Number(tenantResult[0].count),
          difference:
            Number(tenantResult[0].count) -
            Number(publicResult[0].count),
        });
      }

      const publicStaff = await platformPrisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS count
        FROM public."User"
        WHERE "restaurantId" = $1
          AND "role" IN (
            'MANAGER',
            'CASHIER',
            'KITCHEN',
            'WAITER'
          )
      `, restaurantId);

      const tenantStaff = await platformPrisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS count
        FROM "${schema}"."User"
        WHERE "role" IN (
          'MANAGER',
          'CASHIER',
          'KITCHEN',
          'WAITER'
        )
      `);

      rows.unshift({
        table: 'Staff User',
        public: Number(publicStaff[0].count),
        tenant: Number(tenantStaff[0].count),
        difference:
          Number(tenantStaff[0].count) -
          Number(publicStaff[0].count),
      });

      console.table(rows);
    }
  } catch (error) {
    console.error('\nERROR:', error);
    process.exitCode = 1;
  } finally {
    await platformPrisma.$disconnect();
  }
}

run();