/**
 * Runtime verification — proves the dashboard permission fix over HTTP.
 * Logs in as each provided user and calls GET /api/dashboard.
 *
 * Usage: node scripts/verify-dashboard-api.js [baseUrl]
 * Users are read from scripts/verify-users.json (email + password).
 */
require("dotenv").config();

const baseUrl = process.argv[2] || `http://localhost:${process.env.BACKEND_PORT || 5001}`;

const USERS = [
  { email: "admin@restaurant.com", password: "password123", label: "restaurant 1 (PREMIUM)" },
  { email: "Admin@nirka.in", password: "password123", label: "restaurant 9 'Nirka' (PRO - was broken)" },
];

async function main() {
  for (const u of USERS) {
    console.log(`\n=== ${u.label} (${u.email}) ===`);
    let login;
    try {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      login = await res.json();
      console.log(`login: HTTP ${res.status} | success=${login.success} | message=${login.message || ""}`);
    } catch (e) {
      console.log(`login: REQUEST FAILED - ${e.message}`);
      continue;
    }
    if (!login.token) {
      console.log("(no token — skipping dashboard call; password may differ for this tenant)");
      continue;
    }
    console.log(`subscription: plan=${login.subscription && login.subscription.plan} | hasDashboard=${
      Array.isArray(login.subscription && login.subscription.features)
        ? login.subscription.features.includes("dashboard")
        : "?"
    }`);
    try {
      const dash = await fetch(`${baseUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${login.token}` },
      });
      const body = await dash.json();
      const summary = body && body.data && body.data.summary;
      console.log(
        `GET /api/dashboard: HTTP ${dash.status} | success=${body && body.success} | ` +
        `todayOrders=${summary ? summary.todayOrders : "n/a"} | todayRevenue=${summary ? summary.todayRevenue : "n/a"}`
      );
      console.log(dash.status === 200 ? "✅ DASHBOARD ACCESS GRANTED" : "❌ STILL BLOCKED");
    } catch (e) {
      console.log(`dashboard call FAILED - ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error("Verification error:", e.message);
  process.exit(1);
});
