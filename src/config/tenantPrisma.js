/**
 * Tenant Prisma Architecture
 *
 * Provides per-tenant PostgreSQL schema isolation using Prisma's `schema` option.
 * Every restaurant gets its own PostgreSQL schema (e.g. restaurant_1, restaurant_2).
 *
 * Architecture:
 *   platformPrisma → public schema (Restaurant, Plan, Subscription, User, etc.)
 *   tenantDb       → restaurant_X schema (Orders, Menu, Customers, etc.)
 *
 * Usage in controllers:
 *   const { platformPrisma } = require("../config/tenantPrisma");
 *   // For restaurant data, use req.tenantDb (attached by middleware)
 *   // For platform data, use platformPrisma
 */
const { PrismaClient } = require("@prisma/client");

// ─── Platform Prisma Client (public schema — default) ───────────────────────
const isProduction = process.env.NODE_ENV === "production";
const platformPrisma = new PrismaClient({
  log: isProduction ? ["warn", "error"] : ["info", "warn", "error"],
});

// ─── Tenant Client Cache ────────────────────────────────────────────────────
// Key: schema name (e.g. "restaurant_1"), Value: { client, createdAt }
const tenantClientCache = new Map();

/**
 * Generate a safe PostgreSQL schema name from a restaurant ID.
 * Format: restaurant_{id}
 * NEVER allow arbitrary user input as schema name.
 */
function generateSchemaName(restaurantId) {
  const id = Number(restaurantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid restaurant ID for schema generation: ${restaurantId}`);
  }
  return `restaurant_${id}`;
}

/**
 * Validate that a schema name matches the expected pattern.
 * Prevents schema injection attacks.
 */
function isValidSchemaName(name) {
  return /^restaurant_\d+$/.test(name);
}

/**
 * Get or create a cached PrismaClient for a tenant schema.
 * Clients are cached to avoid creating new connections on every request.
 *
 * @param {string} schemaName - The PostgreSQL schema name (e.g. "restaurant_1")
 * @returns {PrismaClient} PrismaClient configured for the tenant schema
 */
function getTenantClient(schemaName) {
  if (!isValidSchemaName(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  if (tenantClientCache.has(schemaName)) {
    return tenantClientCache.get(schemaName).client;
  }

  // Prisma 6.x with prisma.config.ts requires { url: "..." } for datasources.
  // Append ?schema=tenantSchema to the DATABASE_URL to set search_path.
  const baseUrl = process.env.DATABASE_URL;
  const separator = baseUrl.includes("?") ? "&" : "?";
  const tenantUrl = `${baseUrl}${separator}schema=${schemaName}`;

  const client = new PrismaClient({
    log: isProduction ? ["warn", "error"] : ["info", "warn", "error"],
    datasources: {
      db: {
        url: tenantUrl,
      },
    },
  });

  tenantClientCache.set(schemaName, {
    client,
    createdAt: new Date(),
  });

  return client;
}

/**
 * Get tenant client by restaurant ID.
 * Resolves the schema name from the restaurant record.
 *
 * @param {number} restaurantId
 * @returns {Promise<{ client: PrismaClient, schemaName: string }>}
 */
async function getTenantClientByRestaurantId(restaurantId) {
  const restaurant = await platformPrisma.restaurant.findUnique({
    where: { id: Number(restaurantId) },
    select: { tenantSchema: true, status: true },
  });

  if (!restaurant) {
    throw new Error(`Restaurant ${restaurantId} not found`);
  }

  if (restaurant.status !== "ACTIVE") {
    throw new Error(`Restaurant ${restaurantId} is ${restaurant.status}`);
  }

  if (!restaurant.tenantSchema) {
    throw new Error(`Restaurant ${restaurantId} has no tenant schema assigned`);
  }

  const client = getTenantClient(restaurant.tenantSchema);
  return { client, schemaName: restaurant.tenantSchema };
}

/**
 * Invalidate (disconnect and remove) a cached tenant client.
 * Call this when a restaurant schema is dropped or reassigned.
 */
async function invalidateTenantClient(schemaName) {
  if (tenantClientCache.has(schemaName)) {
    const { client } = tenantClientCache.get(schemaName);
    try {
      await client.$disconnect();
    } catch (err) {
      console.error(`[TenantDB] Error disconnecting client for ${schemaName}:`, err.message);
    }
    tenantClientCache.delete(schemaName);
  }
}

/**
 * Disconnect all cached tenant clients. Call on server shutdown.
 */
async function disconnectAllTenants() {
  for (const [schemaName, { client }] of tenantClientCache) {
    try {
      await client.$disconnect();
    } catch (err) {
      console.error(`[TenantDB] Error disconnecting ${schemaName}:`, err.message);
    }
  }
  tenantClientCache.clear();
}

/**
 * Middleware: attaches `req.tenantDb` (PrismaClient for the restaurant's schema)
 * and `req.tenantSchema` to every request from an authenticated restaurant user.
 *
 * Must be used AFTER the auth middleware (protect) that sets req.user.
 * SUPER_ADMIN requests do NOT get a tenantDb — they use platformPrisma.
 */
const tenantMiddleware = async (req, res, next) => {
  try {
    // Super Admin does not belong to a restaurant — skip tenant resolution
    if (!req.user || req.user.role === "SUPER_ADMIN" || !req.user.restaurantId) {
      return next();
    }

    const { client, schemaName } = await getTenantClientByRestaurantId(req.user.restaurantId);
    req.tenantDb = client;
    req.tenantSchema = schemaName;
    next();
  } catch (error) {
    console.error(`[TenantDB] Middleware error: ${error.message}`);
    return res.status(403).json({
      success: false,
      message: `Cannot access restaurant data: ${error.message}`,
    });
  }
};

module.exports = {
  platformPrisma,
  generateSchemaName,
  isValidSchemaName,
  getTenantClient,
  getTenantClientByRestaurantId,
  invalidateTenantClient,
  disconnectAllTenants,
  tenantMiddleware,
};
