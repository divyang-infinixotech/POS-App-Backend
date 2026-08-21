/**
 * Simulates the exact requireFeature("...") middleware logic (feature.middleware.js)
 * against the live database for a given restaurant — proving the permission fix
 * without needing a login password.
 *
 * Usage: node scripts/verify-require-feature.js <restaurantId> <featureKey> [featureKey...]
 * Example: node scripts/verify-require-feature.js 9 dashboard settings printers
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const restaurantId = Number(process.argv[2]);
const featuresToCheck = process.argv.slice(3);
if (!restaurantId || featuresToCheck.length === 0) {
  console.error("Usage: node scripts/verify-require-feature.js <restaurantId> <featureKey> [featureKey...]");
  process.exit(1);
}

const DEFAULT_FEATURES = ["dashboard", "pos", "menu", "billing", "tables", "active_orders"];

// 1:1 copy of the middleware's decision logic
function middlewareDecision(subscription, required) {
  if (!subscription) return { allowed: false, message: "No subscription found" };
  let status = subscription.status;
  const now = new Date();
  if ((status === "ACTIVE" || status === "TRIAL") && subscription.expiryDate && subscription.expiryDate < now) {
    status = "EXPIRED";
  }
  if (status === "EXPIRED" || status === "CANCELLED" || status === "SUSPENDED") {
    return { allowed: false, message: "Your subscription is " + status.toLowerCase() + "." };
  }
  const features =
    Array.isArray(subscription.features) && subscription.features.length > 0
      ? subscription.features
      : DEFAULT_FEATURES;
  if (!required.some((f) => features.includes(f))) {
    return { allowed: false, message: required[0] + " is not included in your current subscription plan." };
  }
  return { allowed: true, message: "allowed" };
}

async function main() {
  const sub = await prisma.subscription.findUnique({
    where: { restaurantId },
    select: { plan: true, status: true, expiryDate: true, features: true },
  });
  console.log("RESTAURANT", restaurantId, "| plan:", sub ? sub.plan : "NO SUB", "| status:", sub && sub.status);
  console.log("stored features:", sub ? JSON.stringify(sub.features) : "-");
  console.log("");

  let allGood = true;
  for (const f of featuresToCheck) {
    const decision = middlewareDecision(sub, [f]);
    const expected = f === "dashboard" ? "ALLOW" : "DENY";
    const actual = decision.allowed ? "ALLOW" : "DENY";
    const pass = actual === expected;
    if (!pass) allGood = false;
    console.log(
      `requireFeature("${f}"): ${actual}  (expected ${expected})  ${pass ? "✅" : "❌"}  ${decision.message}`
    );
  }

  console.log("");
  console.log(allGood ? "VERIFIED: dashboard granted; non-included modules still denied." : "MISMATCH FOUND");
  process.exit(allGood ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("ERR:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
