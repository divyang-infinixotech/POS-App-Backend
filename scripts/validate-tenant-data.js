/**
 * Data validation (Part 19) — runs read-only checks against every tenant schema:
 *   1. Orphan Subcategory (categoryId not found)
 *   2. Invalid MenuItem hierarchy (subcategoryId exists but belongs to another category)
 *   3. Duplicate subcategories within the same category
 *   4. Invalid dietary values (MenuItem.dietaryType, RestaurantSetting.dietaryMode, User.dietaryAccess)
 *   5. Invalid floor assignments (UserFloorAssignment pointing at missing user/floor)
 *   6. Cross-tenant references (rows whose restaurantId differs from the schema's restaurant)
 *   7. Duplicate UserFloorAssignment rows (userId, floorId)
 *
 * READ-ONLY: no data is modified. Exit code 1 when any violation is found.
 *
 * Run: node scripts/validate-tenant-data.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { platformPrisma } = require("../src/config/tenantPrisma");

const VALID_DIETARY_TYPES = ["VEG", "NON_VEG"];
const VALID_DIETARY_MODES = ["VEG_ONLY", "VEG_AND_NON_VEG"];
const VALID_DIETARY_ACCESS = ["VEG_ONLY", "VEG_AND_NON_VEG"];

(async () => {
  const restaurants = await platformPrisma.restaurant.findMany({
    where: { tenantSchema: { not: null } },
    select: { id: true, tenantSchema: true },
    orderBy: { id: "asc" },
  });
  const tenants = restaurants.filter((r) => /^restaurant_\d+$/.test(r.tenantSchema));
  console.log(`Validating ${tenants.length} tenant schema(s)...\n`);

  let totalViolations = 0;

  for (const r of tenants) {
    const S = r.tenantSchema;
    const q = (sql) => platformPrisma.$queryRawUnsafe(sql);
    const violations = [];

    const add = (check, rows) => {
      if (rows.length > 0) violations.push({ check, rows });
    };

    try {
      // 1. Orphan Subcategory: categoryId does not exist in Category
      add(
        "orphan subcategory",
        await q(`SELECT s.id, s.name, s."categoryId" FROM "${S}"."Subcategory" s
                 LEFT JOIN "${S}"."Category" c ON c.id = s."categoryId"
                 WHERE c.id IS NULL`)
      );

      // 2. Invalid MenuItem hierarchy: subcategory belongs to another category
      add(
        "menuitem with subcategory of another category",
        await q(`SELECT m.id, m.name, m."categoryId", m."subcategoryId"
                 FROM "${S}"."MenuItem" m
                 JOIN "${S}"."Subcategory" s ON s.id = m."subcategoryId"
                 WHERE s."categoryId" <> m."categoryId"`)
      );

      // 3. Duplicate subcategories within the same category
      add(
        "duplicate subcategory in category",
        await q(`SELECT "categoryId", name, COUNT(*)::int AS cnt
                 FROM "${S}"."Subcategory" GROUP BY "categoryId", name HAVING COUNT(*) > 1`)
      );

      // 4. Invalid dietary values
      add(
        "invalid MenuItem.dietaryType",
        await q(`SELECT id, name, "dietaryType" FROM "${S}"."MenuItem"
                 WHERE "dietaryType" IS NULL OR "dietaryType" NOT IN ('VEG','NON_VEG')`)
      );
      add(
        "invalid RestaurantSetting.dietaryMode",
        await q(`SELECT "restaurantId", "dietaryMode" FROM "${S}"."RestaurantSetting"
                 WHERE "dietaryMode" IS NULL OR "dietaryMode" NOT IN ('VEG_ONLY','VEG_AND_NON_VEG')`)
      );
      add(
        "invalid User.dietaryAccess",
        await q(`SELECT id, name, "dietaryAccess" FROM "${S}"."User"
                 WHERE "dietaryAccess" IS NULL OR "dietaryAccess" NOT IN ('VEG_ONLY','VEG_AND_NON_VEG')`)
      );

      // 5. Invalid floor assignments (missing user or floor)
      add(
        "floor assignment with missing user",
        await q(`SELECT a.id, a."userId", a."floorId" FROM "${S}"."UserFloorAssignment" a
                 LEFT JOIN "${S}"."User" u ON u.id = a."userId"
                 WHERE u.id IS NULL`)
      );
      add(
        "floor assignment with missing floor",
        await q(`SELECT a.id, a."userId", a."floorId" FROM "${S}"."UserFloorAssignment" a
                 LEFT JOIN "${S}"."Floor" f ON f.id = a."floorId"
                 WHERE f.id IS NULL`)
      );

      // 6. Cross-tenant references: rows stamped with another restaurant's id.
      // The "User" table of legacy schemas predates the restaurantId column —
      // check column existence so the report never false-fails on them.
      const hasUserRestaurantId = (
        await q(
          `SELECT COUNT(*)::int AS c FROM information_schema.columns
           WHERE table_schema = '${S}' AND table_name = 'User' AND column_name = 'restaurantId'`
        )
      )[0].c > 0;
      add(
        "category cross-tenant",
        await q(`SELECT id, name FROM "${S}"."Category" WHERE "restaurantId" <> ${Number(r.id)}`)
      );
      add(
        "subcategory cross-tenant",
        await q(`SELECT id, name FROM "${S}"."Subcategory" WHERE "restaurantId" <> ${Number(r.id)}`)
      );
      add(
        "menuitem cross-tenant",
        await q(`SELECT id, name FROM "${S}"."MenuItem" WHERE "restaurantId" <> ${Number(r.id)}`)
      );
      add(
        "floor cross-tenant",
        await q(`SELECT id, name FROM "${S}"."Floor" WHERE "restaurantId" <> ${Number(r.id)}`)
      );
      if (hasUserRestaurantId) {
        add(
          "user cross-tenant",
          await q(`SELECT id, name FROM "${S}"."User" WHERE "restaurantId" IS NOT NULL AND "restaurantId" <> ${Number(r.id)}`)
        );
      }

      // 7. Duplicate UserFloorAssignment rows
      add(
        "duplicate user-floor assignment",
        await q(`SELECT "userId", "floorId", COUNT(*)::int AS cnt
                 FROM "${S}"."UserFloorAssignment" GROUP BY "userId", "floorId" HAVING COUNT(*) > 1`)
      );
    } catch (err) {
      violations.push({ check: "schema query failed", rows: [{ error: err.message }] });
    }

    if (violations.length === 0) {
      console.log(`✅ ${S}: all checks clean`);
    } else {
      console.log(`❌ ${S}: ${violations.length} violation group(s)`);
      for (const v of violations) {
        console.log(`   - ${v.check}: ${JSON.stringify(v.rows.slice(0, 5))}`);
      }
      totalViolations += violations.length;
    }
  }

  console.log(`\n${totalViolations === 0 ? "✅ ALL DATA VALIDATION CHECKS PASSED (0 violations)" : `❌ ${totalViolations} violation group(s) found`}`);
  if (totalViolations > 0) process.exitCode = 1;
  await platformPrisma.$disconnect();
})().catch((err) => {
  console.error("Validation crashed:", err.message);
  process.exit(1);
});
