#!/usr/bin/env node

/**
 * Tenant Schema Migration Runner
 *
 * Applies SQL changes to every tenant PostgreSQL schema.
 *
 * Usage:
 *   node scripts/tenant-migration-runner.js --sql-file=scripts/sql/file.sql
 *   node scripts/tenant-migration-runner.js --sql-file=scripts/sql/file.sql --restaurant-id=1
 *   node scripts/tenant-migration-runner.js --sql-file=scripts/sql/file.sql --dry-run
 */

const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient({
  log: ["warn", "error"],
});

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const args = process.argv.slice(2);

const sqlFileArg = args.find((a) => a.startsWith("--sql-file="));
const sqlArg = args.find((a) => a.startsWith("--sql="));
const restaurantIdArg = args.find((a) =>
  a.startsWith("--restaurant-id=")
);

const DRY_RUN = args.includes("--dry-run");
const VERBOSE =
  args.includes("--verbose") || args.includes("-v");

let SQL = "";

if (sqlFileArg) {
  const filePath = sqlFileArg.substring("--sql-file=".length);
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    console.error(`SQL file not found: ${resolved}`);
    process.exit(1);
  }

  SQL = fs.readFileSync(resolved, "utf8");
} else if (sqlArg) {
  SQL = sqlArg.substring("--sql=".length);
} else {
  console.error(
    "Provide --sql='...' or --sql-file=path/to/file.sql"
  );
  process.exit(1);
}

const SINGLE_RESTAURANT = restaurantIdArg
  ? Number(
      restaurantIdArg.substring("--restaurant-id=".length)
    )
  : null;

// -----------------------------------------------------------------------------
// SQL splitter
//
// Important:
// We cannot simply SQL.split(";") because PL/pgSQL blocks contain semicolons:
//
// DO $$
// BEGIN
//     ...
// END $$;
//
// This splitter keeps semicolons inside dollar-quoted blocks intact.
// -----------------------------------------------------------------------------

function splitSqlStatements(sql) {
  const statements = [];

  let current = "";
  let dollarQuoteTag = null;
  let singleQuote = false;
  let doubleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    // -------------------------------------------------------------------------
    // Inside dollar-quoted block
    // -------------------------------------------------------------------------

    if (dollarQuoteTag) {
      current += char;

      if (
        sql.startsWith(dollarQuoteTag, i)
      ) {
        // We already added the first character.
        const remainingTag = dollarQuoteTag.substring(1);

        if (sql.startsWith(remainingTag, i + 1)) {
          current += remainingTag;
          i += remainingTag.length;

          dollarQuoteTag = null;
        }
      }

      continue;
    }

    // -------------------------------------------------------------------------
    // Single quoted string
    // -------------------------------------------------------------------------

    if (singleQuote) {
      current += char;

      if (char === "'" && next === "'") {
        current += next;
        i++;
        continue;
      }

      if (char === "'") {
        singleQuote = false;
      }

      continue;
    }

    // -------------------------------------------------------------------------
    // Double quoted identifier
    // -------------------------------------------------------------------------

    if (doubleQuote) {
      current += char;

      if (char === '"' && next === '"') {
        current += next;
        i++;
        continue;
      }

      if (char === '"') {
        doubleQuote = false;
      }

      continue;
    }

    // -------------------------------------------------------------------------
    // Start single quote
    // -------------------------------------------------------------------------

    if (char === "'") {
      singleQuote = true;
      current += char;
      continue;
    }

    // -------------------------------------------------------------------------
    // Start double quote
    // -------------------------------------------------------------------------

    if (char === '"') {
      doubleQuote = true;
      current += char;
      continue;
    }

    // -------------------------------------------------------------------------
    // Start dollar quote
    //
    // Supports:
    // $$ ... $$
    // $tag$ ... $tag$
    // -------------------------------------------------------------------------

    if (char === "$") {
      const rest = sql.substring(i);

      const match = rest.match(
        /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/
      );

      if (match) {
        dollarQuoteTag = match[0];
        current += dollarQuoteTag;
        i += dollarQuoteTag.length - 1;
        continue;
      }
    }

    // -------------------------------------------------------------------------
    // Statement terminator
    // -------------------------------------------------------------------------

    if (char === ";") {
      const statement = current.trim();

      if (statement) {
        statements.push(statement);
      }

      current = "";
      continue;
    }

    current += char;
  }

  const last = current.trim();

  if (last) {
    statements.push(last);
  }

  return statements;
}

// -----------------------------------------------------------------------------
// Create Prisma client for tenant schema
// -----------------------------------------------------------------------------

function createTenantPrisma(schemaName) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured"
    );
  }

  const url = new URL(databaseUrl);

  // Prisma PostgreSQL schema selection is done through
  // the connection URL, NOT:
  //
  // datasources: { db: { schema: schemaName } }
  //
  url.searchParams.set("schema", schemaName);

  if (VERBOSE) {
    console.log(
      `\n    Tenant database schema: ${schemaName}`
    );
  }

  return new PrismaClient({
    datasources: {
      db: {
        url: url.toString(),
      },
    },
    log: VERBOSE
      ? ["query", "info", "warn", "error"]
      : ["warn", "error"],
  });
}

// -----------------------------------------------------------------------------
// Migration
// -----------------------------------------------------------------------------

async function runMigration() {
  console.log(
    "═══════════════════════════════════════════════════════════"
  );

  console.log(
    "  Tenant Schema Migration Runner"
  );

  console.log(
    "═══════════════════════════════════════════════════════════"
  );

  console.log(
    `  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`
  );

  console.log(
    `  Target: ${
      SINGLE_RESTAURANT
        ? `Restaurant #${SINGLE_RESTAURANT}`
        : "All restaurants"
    }`
  );

  const statements = splitSqlStatements(SQL);

  console.log(
    `  SQL statements: ${statements.length}`
  );

  console.log(
    "═══════════════════════════════════════════════════════════\n"
  );

  // ---------------------------------------------------------------------------
  // Find restaurants
  // ---------------------------------------------------------------------------

  const where = SINGLE_RESTAURANT
    ? {
        id: SINGLE_RESTAURANT,
        tenantSchema: {
          not: null,
        },
      }
    : {
        deletedAt: null,
        tenantSchema: {
          not: null,
        },
      };

  const restaurants =
    await prisma.restaurant.findMany({
      where,
      select: {
        id: true,
        name: true,
        tenantSchema: true,
      },
      orderBy: {
        id: "asc",
      },
    });

  console.log(
    `Found ${restaurants.length} restaurant(s) with tenant schemas.\n`
  );

  let successCount = 0;
  let errorCount = 0;

  // ---------------------------------------------------------------------------
  // Run against each tenant
  // ---------------------------------------------------------------------------

  for (const restaurant of restaurants) {
    const schemaName = restaurant.tenantSchema;

    process.stdout.write(
      `  #${restaurant.id} "${restaurant.name}" (${schemaName})... `
    );

    if (DRY_RUN) {
      console.log("SKIP (dry run)");
      successCount++;
      continue;
    }

    let client = null;

    try {
      client = createTenantPrisma(schemaName);

      // Verify that the client is actually connected to
      // the requested tenant schema.
      const schemaResult =
        await client.$queryRawUnsafe(
          `SELECT current_schema() AS "schema"`
        );

      const currentSchema =
        schemaResult?.[0]?.schema;

      if (currentSchema !== schemaName) {
        throw new Error(
          `Tenant schema mismatch. Expected "${schemaName}", got "${currentSchema}"`
        );
      }

      if (VERBOSE) {
        console.log(
          `\n    Connected to ${currentSchema}`
        );
      }

      // Execute statements individually.
      // The custom splitter preserves DO $$ blocks.
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i];

        if (VERBOSE) {
          console.log(
            `    Executing statement ${i + 1}/${statements.length}`
          );
        }

        await client.$executeRawUnsafe(
          statement
        );
      }

      console.log("OK");
      successCount++;
    } catch (err) {
      console.log(
        `ERROR: ${err.message}`
      );

      if (VERBOSE) {
        console.error(err);
      }

      errorCount++;
    } finally {
      if (client) {
        await client.$disconnect();
      }
    }
  }

  console.log(
    "\n═══════════════════════════════════════════════════════════"
  );

  console.log(
    `  ✅ Success: ${successCount}  ❌ Failed: ${errorCount}`
  );

  console.log(
    "═══════════════════════════════════════════════════════════"
  );

  await prisma.$disconnect();

  if (errorCount > 0) {
    process.exit(1);
  }
}

runMigration().catch(async (err) => {
  console.error(
    "\nMigration failed:",
    err
  );

  await prisma.$disconnect();

  process.exit(1);
});