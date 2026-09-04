/**
 * Production-safe migration:
 *
 * public operational tables
 *        ↓
 * restaurant_<id> tenant schemas
 *
 * IMPORTANT:
 * - First run with --dry-run
 * - This script DOES NOT delete public records
 * - Existing IDs are preserved
 * - Staff users are copied to tenant User
 * - ADMIN / SUPER_ADMIN remain in public.User
 * - Restaurant.tenantSchema is linked only after verification
 *
 * Usage:
 *   node scripts/migrate-public-data-to-tenants.js --dry-run
 *   node scripts/migrate-public-data-to-tenants.js --restaurant=1 --dry-run
 *   node scripts/migrate-public-data-to-tenants.js
 *   node scripts/migrate-public-data-to-tenants.js --restaurant=1
 */

const {
  platformPrisma,
  generateSchemaName,
} = require("../src/config/tenantPrisma");

const {
  initializeTenantSchema,
} = require("../src/utils/tenantSchema");

const DRY_RUN = process.argv.includes("--dry-run");

const restaurantArg = process.argv.find((arg) =>
  arg.startsWith("--restaurant=")
);

const ONLY_RESTAURANT_ID = restaurantArg
  ? Number(restaurantArg.split("=")[1])
  : null;

const STAFF_ROLES = [
  "MANAGER",
  "CASHIER",
  "KITCHEN",
  "WAITER",
];

/**
 * Public → Tenant migration order.
 *
 * Parent tables must be copied before child tables because
 * tenant foreign keys are enabled.
 */
const MIGRATION_TABLES = [
  {
    tableName: "RestaurantSetting",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "Floor",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "Category",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "MenuItem",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "Customer",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "RestaurantTable",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "Order",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "OrderItem",
    sourceWhere: `"orderId" IN (
      SELECT id
      FROM public."Order"
      WHERE "restaurantId" = $1
    )`,
    targetWhere: `"orderId" IN (
      SELECT id
      FROM "restaurant_SCHEMA"."Order"
      WHERE "restaurantId" = $1
    )`,
  },

  {
    tableName: "StockMovement",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "KOT",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "KOTItem",
    sourceWhere: `"kotId" IN (
      SELECT id
      FROM public."KOT"
      WHERE "restaurantId" = $1
    )`,
    targetWhere: `"kotId" IN (
      SELECT id
      FROM "restaurant_SCHEMA"."KOT"
      WHERE "restaurantId" = $1
    )`,
  },

  {
    tableName: "Bill",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "Payment",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "PrinterSetting",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "AuditLog",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "Notification",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "MergeGroup",
    sourceWhere: `"restaurantId" = $1`,
    targetWhere: `"restaurantId" = $1`,
  },

  {
    tableName: "MergeGroupTable",
    sourceWhere: `"mergeGroupId" IN (
      SELECT id
      FROM public."MergeGroup"
      WHERE "restaurantId" = $1
    )`,
    targetWhere: `"mergeGroupId" IN (
      SELECT id
      FROM "restaurant_SCHEMA"."MergeGroup"
      WHERE "restaurantId" = $1
    )`,
  },
];

/**
 * Escape PostgreSQL identifiers safely.
 */
function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Return fully-qualified tenant table.
 */
function tenantTable(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/**
 * Replace the tenant-schema placeholder used inside targetWhere
 * clauses with the concrete tenant schema name.
 */
function resolveTenantWhere(schemaName, whereClause) {
  return whereClause.replace(/restaurant_SCHEMA/g, schemaName);
}

/**
 * Get columns from public table.
 *
 * This prevents accidentally copying a column that doesn't exist
 * in the source or target table.
 */
async function getTableColumns(tableName) {
  const rows = await platformPrisma.$queryRawUnsafe(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    tableName
  );

  return rows.map((row) => row.column_name);
}

/**
 * Get columns from tenant table.
 */
async function getTenantTableColumns(schemaName, tableName) {
  const rows = await platformPrisma.$queryRawUnsafe(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `,
    schemaName,
    tableName
  );

  return rows.map((row) => row.column_name);
}

/**
 * Get number of rows for restaurant.
 */
async function getPublicCount(
  tableName,
  restaurantId,
  whereClause = `"restaurantId" = $1`
) {
  const result = await platformPrisma.$queryRawUnsafe(
    `
      SELECT COUNT(*)::integer AS count
      FROM public.${quoteIdentifier(tableName)}
      WHERE ${whereClause}
    `,
    restaurantId
  );

  return result[0]?.count || 0;
}

/**
 * Get number of rows in tenant.
 */
async function getTenantCount(
  schemaName,
  tableName,
  restaurantId,
  whereClause = `"restaurantId" = $1`
) {
  const result = await platformPrisma.$queryRawUnsafe(
    `
      SELECT COUNT(*)::integer AS count
      FROM ${tenantTable(schemaName, tableName)}
      WHERE ${resolveTenantWhere(schemaName, whereClause)}
    `,
    restaurantId
  );

  return result[0]?.count || 0;
}

/**
 * Check whether a public table exists.
 */
async function publicTableExists(tableName) {
  const result = await platformPrisma.$queryRawUnsafe(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS exists
    `,
    tableName
  );

  return Boolean(result[0]?.exists);
}

/**
 * Check whether tenant table exists.
 */
async function tenantTableExists(schemaName, tableName) {
  const result = await platformPrisma.$queryRawUnsafe(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
      ) AS exists
    `,
    schemaName,
    tableName
  );

  return Boolean(result[0]?.exists);
}

/**
 * Copy records from public table into tenant table.
 *
 * Only common columns are copied.
 * IDs are preserved.
 */
async function copyTable({
  restaurantId,
  schemaName,
  tableName,
  whereClause,
  targetWhere = `"restaurantId" = $1`,
  whereParams = [],
}) {
  const sourceExists = await publicTableExists(tableName);

  if (!sourceExists) {
    console.log(`  [SKIP] public.${tableName} does not exist`);
    return {
      tableName,
      sourceCount: 0,
      targetCount: 0,
      copied: 0,
      skipped: true,
    };
  }

  const targetExists = await tenantTableExists(schemaName, tableName);

  if (!targetExists) {
    throw new Error(
      `Tenant table ${schemaName}.${tableName} does not exist`
    );
  }

  const sourceColumns = await getTableColumns(tableName);
  const targetColumns = await getTenantTableColumns(
    schemaName,
    tableName
  );

  const targetColumnSet = new Set(targetColumns);

  const columns = sourceColumns.filter((column) =>
    targetColumnSet.has(column)
  );

  if (!columns.includes("id")) {
    throw new Error(
      `Table ${tableName}: id column missing from migration columns`
    );
  }

  if (columns.length === 0) {
    throw new Error(`No common columns found for ${tableName}`);
  }

  const quotedColumns = columns
    .map(quoteIdentifier)
    .join(", ");

  const sourceWhere = whereClause
    ? `WHERE ${whereClause}`
    : "";

  const countResult = await platformPrisma.$queryRawUnsafe(
    `
      SELECT COUNT(*)::integer AS count
      FROM public.${quoteIdentifier(tableName)}
      ${sourceWhere}
    `,
    ...whereParams
  );

  const sourceCount = countResult[0]?.count || 0;

  console.log(
    `  ${tableName}: source=${sourceCount}, columns=${columns.length}`
  );

  if (DRY_RUN) {
    return {
      tableName,
      sourceCount,
      targetCount: null,
      copied: 0,
      skipped: false,
    };
  }

  /**
   * INSERT ... SELECT
   *
   * ON CONFLICT (id) DO UPDATE
   *
   * This makes the migration idempotent.
   */
  const sql = `
    INSERT INTO ${tenantTable(schemaName, tableName)}
      (${quotedColumns})
    SELECT
      ${quotedColumns}
    FROM public.${quoteIdentifier(tableName)}
    ${sourceWhere}
    ON CONFLICT ("id") DO UPDATE SET
      ${columns
        .filter((column) => column !== "id")
        .map(
          (column) =>
            `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(
              column
            )}`
        )
        .join(", ")}
  `;

  const copied = await platformPrisma.$executeRawUnsafe(
    sql,
    ...whereParams
  );

  /**
   * Fix sequence after preserving IDs.
   */
  await resetSequence(schemaName, tableName);

  const targetCount = await getTenantCount(
    schemaName,
    tableName,
    restaurantId,
    targetWhere
  );

  console.log(
    `  ${tableName}: copied=${copied}, target=${targetCount}`
  );

  return {
    tableName,
    sourceCount,
    targetCount,
    copied,
    skipped: false,
  };
}

/**
 * Reset SERIAL / sequence after inserting explicit IDs.
 */
async function resetSequence(schemaName, tableName) {
  const sequenceRows = await platformPrisma.$queryRawUnsafe(
    `
      SELECT pg_get_serial_sequence(
        $1,
        'id'
      ) AS sequence_name
    `,
    tenantTable(schemaName, tableName)
  );

  const sequenceName = sequenceRows[0]?.sequence_name;

  if (!sequenceName) {
    return;
  }

  await platformPrisma.$executeRawUnsafe(
    `
      SELECT setval(
        $1::regclass,
        COALESCE(
          (
            SELECT MAX(id)
            FROM ${tenantTable(schemaName, tableName)}
          ),
          1
        ),
        true
      )
    `,
    sequenceName
  );
}

/**
 * Create tenant schema without relying on an already-existing
 * tenantSchema value.
 */
async function ensureTenantSchema(restaurantId) {
  const schemaName = generateSchemaName(restaurantId);

  const restaurant = await platformPrisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      tenantSchema: true,
    },
  });

  if (!restaurant) {
    throw new Error(`Restaurant ${restaurantId} not found`);
  }

  console.log(
    `\nRestaurant ${restaurant.id}: ${restaurant.name}`
  );
  console.log(`Tenant schema: ${schemaName}`);

  if (restaurant.tenantSchema) {
    if (restaurant.tenantSchema !== schemaName) {
      throw new Error(
        `Restaurant ${restaurantId} already points to ${restaurant.tenantSchema}, expected ${schemaName}`
      );
    }

    console.log(
      `  Existing tenantSchema link detected: ${restaurant.tenantSchema}`
    );
  }

  /**
   * initializeTenantSchema currently also links Restaurant.tenantSchema.
   *
   * We only call it if the schema does not already exist.
   *
   * In dry-run mode we DO NOT create production schema.
   */
  const schemaExistsResult =
    await platformPrisma.$queryRawUnsafe(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.schemata
          WHERE schema_name = $1
        ) AS exists
      `,
      schemaName
    );

  const schemaExists = Boolean(schemaExistsResult[0]?.exists);

  if (schemaExists) {
    console.log(`  Schema ${schemaName} already exists`);
    return schemaName;
  }

  if (DRY_RUN) {
    console.log(
      `  [DRY-RUN] Would create tenant schema ${schemaName}`
    );
    return schemaName;
  }

  console.log(`  Creating tenant schema ${schemaName}...`);

  await initializeTenantSchema(restaurantId);

  console.log(`  Tenant schema ${schemaName} created`);

  return schemaName;
}

/**
 * Verify staff migration.
 */
async function verifyStaffUsers(restaurantId, schemaName) {
  const publicStaff = await platformPrisma.user.findMany({
    where: {
      restaurantId,
      role: {
        in: STAFF_ROLES,
      },
    },
    select: {
      id: true,
      email: true,
      role: true,
    },
  });

  if (DRY_RUN) {
    console.log(
      `  [DRY-RUN] Staff users to migrate: ${publicStaff.length}`
    );
    return;
  }

  const tenantRows = await platformPrisma.$queryRawUnsafe(
    `
      SELECT id, email, role
      FROM ${tenantTable(schemaName, "User")}
      WHERE "role" IN ('MANAGER', 'CASHIER', 'KITCHEN', 'WAITER')
    `
  );

  const tenantById = new Map(
    tenantRows.map((user) => [Number(user.id), user])
  );

  const missing = publicStaff.filter(
    (user) => !tenantById.has(user.id)
  );

  if (missing.length > 0) {
    throw new Error(
      `Staff verification failed. Missing tenant users: ${missing
        .map((u) => `${u.id}:${u.email}`)
        .join(", ")}`
    );
  }

  console.log(
    `  Staff verification passed: ${publicStaff.length} users`
  );
}

/**
 * Verify all migrated tables.
 */
async function verifyMigration(restaurantId, schemaName) {
  console.log(`\nVerifying restaurant ${restaurantId}...`);

  const results = [];

  for (const table of MIGRATION_TABLES) {
    const tableName = table.tableName;

    if (!(await publicTableExists(tableName))) {
      continue;
    }

    /**
     * User requires special handling because ADMIN and SUPER_ADMIN
     * stay in public.
     */
    if (tableName === "User") {
      const publicCount = await platformPrisma.user.count({
        where: {
          restaurantId,
          role: {
            in: STAFF_ROLES,
          },
        },
      });

      const tenantRows = await platformPrisma.$queryRawUnsafe(
        `
          SELECT COUNT(*)::integer AS count
          FROM ${tenantTable(schemaName, "User")}
          WHERE "role" IN ('MANAGER', 'CASHIER', 'KITCHEN', 'WAITER')
        `
      );

      const tenantCount = tenantRows[0]?.count || 0;

      results.push({
        tableName,
        sourceCount: publicCount,
        targetCount: tenantCount,
      });

      if (publicCount !== tenantCount) {
        throw new Error(
          `Verification failed for User: public staff=${publicCount}, tenant=${tenantCount}`
        );
      }

      continue;
    }

    const sourceCount = await getPublicCount(
      tableName,
      restaurantId,
      table.sourceWhere
    );

    const targetCount = await getTenantCount(
      schemaName,
      tableName,
      restaurantId,
      table.targetWhere
    );

    results.push({
      tableName,
      sourceCount,
      targetCount,
    });

    if (sourceCount !== targetCount) {
      throw new Error(
        `Verification failed for ${tableName}: source=${sourceCount}, target=${targetCount}`
      );
    }
  }

  console.log("\nVerification summary:");

  for (const result of results) {
    console.log(
      `  ${result.tableName}: ${result.sourceCount} → ${result.targetCount} ✓`
    );
  }

  console.log("\nAll migration counts verified successfully.");
}

/**
 * Migrate one restaurant.
 */
async function migrateRestaurant(restaurantId) {
  console.log("\n========================================");
  console.log(
    `${DRY_RUN ? "DRY RUN" : "MIGRATION"} - Restaurant ${restaurantId}`
  );
  console.log("========================================");

  const schemaName = await ensureTenantSchema(restaurantId);

  /**
   * Dry-run does not create schema, therefore it cannot query
   * tenant tables. It only reports source data.
   */
  if (DRY_RUN) {
    console.log(
      `\n[DRY-RUN] Migration plan for ${schemaName}:`
    );

    for (const table of MIGRATION_TABLES) {
      const tableName = table.tableName;

      if (!(await publicTableExists(tableName))) {
        console.log(`  ${tableName}: SKIP - source table missing`);
        continue;
      }

      if (tableName === "User") {
        const count = await platformPrisma.user.count({
          where: {
            restaurantId,
            role: {
              in: STAFF_ROLES,
            },
          },
        });

        console.log(
          `  User: ${count} staff users would be copied`
        );

        continue;
      }

      const count = await getPublicCount(
        tableName,
        restaurantId,
        table.sourceWhere
      );

      console.log(
        `  ${tableName}: ${count} records would be copied`
      );
    }

    console.log(
      `\n[DRY-RUN] No schema created, no data changed.`
    );

    return;
  }

  /**
   * All tables except User.
   */
  for (const table of MIGRATION_TABLES) {
    const tableName = table.tableName;

    if (tableName === "User") {
      continue;
    }

    await copyTable({
      restaurantId,
      schemaName,
      tableName,
      whereClause: table.sourceWhere,
      targetWhere: table.targetWhere,
      whereParams: [restaurantId],
    });
  }

  /**
   * Staff users only.
   *
   * ADMIN / SUPER_ADMIN are deliberately excluded.
   */
  await copyTable({
    restaurantId,
    schemaName,
    tableName: "User",
    whereClause: `"restaurantId" = $1 AND "role" IN ('MANAGER', 'CASHIER', 'KITCHEN', 'WAITER')`,
    whereParams: [restaurantId],
  });

  /**
   * Verify everything before considering migration successful.
   */
  await verifyStaffUsers(restaurantId, schemaName);
  await verifyMigration(restaurantId, schemaName);

  /**
   * Only after successful verification do we link the restaurant.
   */
  await platformPrisma.restaurant.update({
    where: { id: restaurantId },
    data: {
      tenantSchema: schemaName,
    },
  });

  console.log(
    `\nRestaurant ${restaurantId} successfully linked to ${schemaName}`
  );

  console.log(
    `IMPORTANT: Public source records were NOT deleted.`
  );
}

/**
 * Get restaurants that need migration.
 */
async function getRestaurants() {
  if (ONLY_RESTAURANT_ID) {
    const restaurant = await platformPrisma.restaurant.findUnique({
      where: {
        id: ONLY_RESTAURANT_ID,
      },
      select: {
        id: true,
      },
    });

    if (!restaurant) {
      throw new Error(
        `Restaurant ${ONLY_RESTAURANT_ID} does not exist`
      );
    }

    return [restaurant];
  }

  return platformPrisma.restaurant.findMany({
    where: {
      deletedAt: null,
    },
    orderBy: {
      id: "asc",
    },
    select: {
      id: true,
    },
  });
}

/**
 * Main.
 */
async function main() {
  console.log("========================================");
  console.log("PUBLIC → TENANT DATA MIGRATION");
  console.log("========================================");

  console.log(
    `Mode: ${DRY_RUN ? "DRY RUN - NO DATA WILL CHANGE" : "LIVE MIGRATION"}`
  );

  if (ONLY_RESTAURANT_ID) {
    console.log(
      `Restaurant filter: ${ONLY_RESTAURANT_ID}`
    );
  } else {
    console.log("Restaurant filter: ALL ACTIVE RESTAURANTS");
  }

  const restaurants = await getRestaurants();

  console.log(
    `Restaurants selected: ${restaurants.length}`
  );

  for (const restaurant of restaurants) {
    await migrateRestaurant(restaurant.id);
  }

  console.log("\n========================================");
  console.log(
    DRY_RUN
      ? "DRY RUN COMPLETE"
      : "MIGRATION COMPLETE"
  );
  console.log("========================================");
}

main()
  .catch((error) => {
    console.error("\n[MIGRATION FAILED]");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await platformPrisma.$disconnect();
  });