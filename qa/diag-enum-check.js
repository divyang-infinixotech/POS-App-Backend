/* TEST-ONLY diagnostic: does the generated Prisma client know the new enum values? */
const { Prisma } = require("@prisma/client");
const enumObj =
  Prisma.BusinessType ||
  (Prisma.$Enums && Prisma.$Enums.BusinessType) ||
  null;
console.log(
  "Generated client BusinessType values:",
  enumObj ? Object.keys(enumObj).join(", ") : "NOT EXPOSED"
);

/* Verify the runtime require path resolves the real generated client */
try {
  const { PrismaClient } = require("@prisma/client");
  const p = new PrismaClient();
  const { PrismaClient: PC } = p;
  console.log("PrismaClient constructor present:", typeof PrismaClient === "function");
} catch (e) {
  console.log("PrismaClient error:", e.message);
}

/* Live DB enum (SELECT-only) */
(async () => {
  try {
    const { PrismaClient } = require("@prisma/client");
    const client = new PrismaClient();
    const rows = await client.$queryRawUnsafe(
      "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'BusinessType' ORDER BY enumsortorder"
    );
    console.log("LIVE DB BusinessType:", rows.map((r) => r.enumlabel).join(", "));
    await client.$disconnect();
  } catch (e) {
    console.log("DB error:", e.message);
  }
})();
