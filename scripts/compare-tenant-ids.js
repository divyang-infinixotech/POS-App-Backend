const { platformPrisma } = require('../src/config/tenantPrisma');

const restaurants = [1, 2, 9];

const tables = [
  'RestaurantSetting',
  'Floor',
  'Category',
  'MenuItem',
  'Customer',
  'RestaurantTable',
  'Order',
  'KOT',
  'Bill',
  'Payment',
  'StockMovement',
  'PrinterSetting',
  'AuditLog',
  'Notification',
];

async function getPublicIds(table, restaurantId) {
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
      SELECT id
      FROM public."${table}"
      WHERE "restaurantId" = $1
      ORDER BY id
    `, restaurantId);
  }

  return [];
}

async function getPublicOrderItemIds(restaurantId) {
  return platformPrisma.$queryRawUnsafe(`
    SELECT oi.id
    FROM public."OrderItem" oi
    INNER JOIN public."Order" o
      ON o.id = oi."orderId"
    WHERE o."restaurantId" = $1
    ORDER BY oi.id
  `, restaurantId);
}

async function getTenantIds(table, schema) {
  return platformPrisma.$queryRawUnsafe(`
    SELECT id
    FROM "${schema}"."${table}"
    ORDER BY id
  `);
}

async function compare(table, publicIds, tenantIds) {
  const publicSet = new Set(publicIds.map(x => Number(x.id)));
  const tenantSet = new Set(tenantIds.map(x => Number(x.id)));

  const onlyPublic = [...publicSet]
    .filter(id => !tenantSet.has(id));

  const onlyTenant = [...tenantSet]
    .filter(id => !publicSet.has(id));

  return {
    table,
    publicCount: publicSet.size,
    tenantCount: tenantSet.size,
    onlyPublicCount: onlyPublic.length,
    onlyTenantCount: onlyTenant.length,
    onlyPublic: onlyPublic.slice(0, 30),
    onlyTenant: onlyTenant.slice(0, 30),
  };
}

async function run() {
  try {
    for (const restaurantId of restaurants) {
      const schema = `restaurant_${restaurantId}`;

      console.log('\n========================================');
      console.log(`RESTAURANT ${restaurantId}`);
      console.log(`SCHEMA ${schema}`);
      console.log('========================================');

      for (const table of tables) {
        const publicIds = await getPublicIds(table, restaurantId);
        const tenantIds = await getTenantIds(table, schema);

        const result = await compare(
          table,
          publicIds,
          tenantIds
        );

        if (
          result.onlyPublicCount > 0 ||
          result.onlyTenantCount > 0
        ) {
          console.log('\n', result);
        } else {
          console.log(`${table}: IDENTICAL IDs`);
        }
      }

      const publicOrderItems =
        await getPublicOrderItemIds(restaurantId);

      const tenantOrderItems =
        await getTenantIds('OrderItem', schema);

      const orderItemResult = await compare(
        'OrderItem',
        publicOrderItems,
        tenantOrderItems
      );

      if (
        orderItemResult.onlyPublicCount > 0 ||
        orderItemResult.onlyTenantCount > 0
      ) {
        console.log('\n', orderItemResult);
      } else {
        console.log('OrderItem: IDENTICAL IDs');
      }
    }
  } catch (error) {
    console.error('\nERROR:', error);
    process.exitCode = 1;
  } finally {
    await platformPrisma.$disconnect();
  }
}

run();