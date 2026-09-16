/**
 * Quick unit test for splitSQL in src/utils/tenantSchema.js.
 * Verifies semicolons inside `--` comments and $$ blocks never split statements.
 * Run: node qa/test-split-sql.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "tenantSchema.js"), "utf8");
const match = src.match(/function splitSQL\(sql\) \{[\s\S]*?\n\}/);
if (!match) { console.error("splitSQL not found"); process.exit(1); }
// eslint-disable-next-line no-new-func
const splitSQL = new Function("return " + match[0].replace("function splitSQL", "function"))();

const sql = [
  "-- Menu item dietary type (authoritative; legacy isVeg boolean kept in sync)",
  "DO $$ BEGIN",
  "  CREATE TYPE \"DietaryType\" AS ENUM ('VEG', 'NON_VEG');",
  "EXCEPTION WHEN duplicate_object THEN null;",
  "END $$;",
  "",
  "-- another; comment; with semicolons",
  "DO $$ BEGIN",
  "  CREATE TYPE \"OrderType\" AS ENUM ('DINE_IN', 'TAKEAWAY');",
  "EXCEPTION WHEN duplicate_object THEN null;",
  "END $$;",
  "CREATE TABLE t (id int);",
].join("\n");

const out = splitSQL(sql);
console.log("statements:", out.length);
out.forEach((s, i) => console.log("-- stmt", i + 1, ":", JSON.stringify(s.replace(/\n/g, " ").slice(0, 70))));

const ok =
  out.length === 3 &&
  out[0].includes("CREATE TYPE \"DietaryType\"") &&
  out[1].includes("CREATE TYPE \"OrderType\"") &&
  out[2] === "CREATE TABLE t (id int)";

if (!ok) { console.error("FAIL"); process.exit(1); }
console.log("PASS: splitSQL handles comment + dollar-quote semicolons");
