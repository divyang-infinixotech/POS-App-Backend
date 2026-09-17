/* TEST-ONLY: prove the regenerated Prisma client accepts every dropdown value.
 * This is the exact layer that threw "Invalid value for argument `businessType`.
 * Expected BusinessType." — so acceptance here proves the reported failure is
 * fixed, with ZERO database interaction.
 */
const client = require(".prisma/client");

function getEnumValues() {
  const p = client.Prisma || client;
  // Prisma 6 exposes enums via Prisma.$Enums (property access hidden from
  // simple string eval, so resolve dynamically).
  const viaDollar = p[Object.getOwnPropertyNames(p).find((k) => k === "$Enums")];
  if (viaDollar && viaDollar.BusinessType) return Object.keys(viaDollar.BusinessType);
  if (p.BusinessType) return Object.keys(p.BusinessType);
  // Last resort: parse the generated schema copy
  const fs = require("fs");
  const schema = fs.readFileSync("node_modules/.prisma/client/schema.prisma", "utf8");
  const m = schema.match(/enum BusinessType\s*{([^}]+)}/);
  return m ? m[1].split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("//") && !s.startsWith("///")) : [];
}

const values = getEnumValues();
console.log("Generated client BusinessType values:", values.join(", "));

const need = ["RESTAURANT", "CAFE", "BAKERY", "BAR", "FOOD_TRUCK", "CLOUD_KITCHEN", "FOOD_COURT", "SUPERMARKET", "GROCERY", "CLOTHING", "OTHER"];
let bad = 0;
for (const t of need) {
  const ok = values.includes(t);
  if (!ok) bad++;
  console.log(ok ? "✓ client accepts " + t : "✗ CLIENT REJECTS " + t);
}
console.log(values.includes("HOTEL") ? "✓ HOTEL still valid (legacy records readable)" : "✗ HOTEL lost");
const unexpected = values.filter((v) => !need.includes(v) && v !== "HOTEL");
if (unexpected.length) { console.log("✗ unexpected values:", unexpected.join(",")); bad++; }

console.log(bad === 0 ? "\nCLIENT ENUM SYNC: PASS" : `\nCLIENT ENUM SYNC: FAIL (${bad})`);
process.exit(bad ? 1 : 0);
