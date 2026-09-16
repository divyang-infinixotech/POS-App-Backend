require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

async function main() {
  // Where do enums named DietaryType exist?
  const types = await platformPrisma.$queryRawUnsafe(
    `SELECT n.nspname AS schema, t.typname FROM pg_type t
     JOIN pg_namespace n ON t.typnamespace = n.oid
     WHERE t.typname IN ('DietaryType','DietaryMode','DietaryAccess')
     ORDER BY n.nspname, t.typname`
  );
  console.log("Enum types found:", JSON.stringify(types, null, 2));

  // Current column typing in restaurant_1
  const cols = await platformPrisma.$queryRawUnsafe(
    `SELECT table_name, column_name, data_type, udt_name, udt_schema
     FROM information_schema.columns
     WHERE table_schema = 'restaurant_1'
       AND ((table_name = 'MenuItem' AND column_name = 'dietaryType')
         OR (table_name = 'RestaurantSetting' AND column_name = 'dietaryMode')
         OR (table_name = 'User' AND column_name = 'dietaryAccess'))`
  );
  console.log("restaurant_1 dietary columns:", JSON.stringify(cols, null, 2));

  await platformPrisma.$disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
