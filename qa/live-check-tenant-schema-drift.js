require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

(async () => {
  const q = async (sql, params) => platformPrisma.$queryRawUnsafe(sql, ...(params || []));
  for (const schema of ["restaurant_1", "restaurant_472"]) {
    console.log(`\n=== ${schema} ===`);
    const cols = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('User','OrderItem','KOTItem') ORDER BY table_name, ordinal_position`, [schema]);
    const byTable = {};
    for (const c of cols) { (byTable[c.table_name] = byTable[c.table_name] || []).push(c.column_name); }
    for (const t of ["User", "OrderItem", "KOTItem"]) {
      console.log(`  ${t}: ${(byTable[t] || []).join(", ") || "(table missing)"}`);
    }
  }
  await platformPrisma.$disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
