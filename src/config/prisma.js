const { PrismaClient } = require("@prisma/client");

// SQL query logging is development-only: in production it would dump every
// query (including PII inside WHERE clauses) to the logs and add overhead.
const isProduction = process.env.NODE_ENV === "production";

const prisma = new PrismaClient({
  log: isProduction ? ["warn", "error"] : ["query", "info", "warn", "error"],
});

module.exports = prisma;