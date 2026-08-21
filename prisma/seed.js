  const {
    PrismaClient,
    UserRole,
    TableStatus,
    OrderType,
    OrderStatus,
    KOTStatus,
    BillStatus,
    PaymentMethod,
    PaymentStatus,
    CustomerType,
    SubscriptionStatus,
  } = require("@prisma/client");
  const bcrypt = require("bcryptjs");

  const prisma = new PrismaClient();

  // ═══════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function pick(arr) {
    return arr[randomInt(0, arr.length - 1)];
  }

  function daysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(randomInt(8, 23), randomInt(0, 59), randomInt(0, 59), 0);
    return d;
  }

  function hoursAgo(hours) {
    const d = new Date();
    d.setHours(d.getHours() - hours);
    d.setMinutes(randomInt(0, 59), randomInt(0, 59), 0);
    return d;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  DATA DEFINITIONS (preserved from original)
  // ═══════════════════════════════════════════════════════════════════

  const CATEGORIES_DATA = [
    { name: "Starters", color: "#FF6B35", icon: "flame" },
    { name: "Soups", color: "#F7C59F", icon: "coffee" },
    { name: "Chinese", color: "#E63946", icon: "utensils-crossed" },
    { name: "North Indian", color: "#D4A373", icon: "utensils" },
    { name: "South Indian", color: "#2A9D8F", icon: "cooking-pot" },
    { name: "Pizza", color: "#E76F51", icon: "pizza" },
    { name: "Burger", color: "#8D6E63", icon: "sandwich" },
    { name: "Sandwich", color: "#BC6C25", icon: "sandwich" },
    { name: "Pasta", color: "#DDA15E", icon: "wheat" },
    { name: "Rice", color: "#F4A261", icon: "grain" },
    { name: "Biryani", color: "#CC5500", icon: "cooking-pot" },
    { name: "Desserts", color: "#E5989B", icon: "cake" },
    { name: "Ice Cream", color: "#B5838D", icon: "ice-cream" },
    { name: "Beverages", color: "#6D597A", icon: "wine" },
    { name: "Tea", color: "#B5651D", icon: "coffee" },
    { name: "Coffee", color: "#3E2723", icon: "coffee" },
    { name: "Fresh Juice", color: "#E76F51", icon: "apple" },
    { name: "Mocktails", color: "#00B4D8", icon: "wine" },
  ];

  const FLOORS_DATA = [
    { name: "Ground Floor", sortOrder: 1 },
    { name: "First Floor", sortOrder: 2 },
    { name: "Family Section", sortOrder: 3 },
    { name: "Outdoor", sortOrder: 4 },
    { name: "VIP Lounge", sortOrder: 5 },
  ];

  const USERS_DATA = [
    { name: "Rajesh Kumar", email: "rajesh@restaurant.com", role: "MANAGER", phone: "9876543201" },
    { name: "Priya Sharma", email: "priya@restaurant.com", role: "MANAGER", phone: "9876543202" },
    { name: "Amit Singh", email: "amit@restaurant.com", role: "CASHIER", phone: "9876543210" },
    { name: "Sneha Patel", email: "sneha@restaurant.com", role: "CASHIER", phone: "9876543211" },
    { name: "Vikram Joshi", email: "vikram@restaurant.com", role: "CASHIER", phone: "9876543212" },
    { name: "Neha Gupta", email: "neha@restaurant.com", role: "CASHIER", phone: "9876543213" },
    { name: "Rohit Verma", email: "rohit@restaurant.com", role: "WAITER", phone: "9876543220" },
    { name: "Sunil Kumar", email: "sunil@restaurant.com", role: "WAITER", phone: "9876543221" },
    { name: "Deepak Yadav", email: "deepak@restaurant.com", role: "WAITER", phone: "9876543222" },
    { name: "Anita Desai", email: "anita@restaurant.com", role: "WAITER", phone: "9876543223" },
    { name: "Manoj Tiwari", email: "manoj@restaurant.com", role: "WAITER", phone: "9876543224" },
    { name: "Chef Anand", email: "anand@restaurant.com", role: "KITCHEN", phone: "9876543230" },
    { name: "Chef Ravi", email: "ravi@restaurant.com", role: "KITCHEN", phone: "9876543231" },
    { name: "Chef Meera", email: "meera@restaurant.com", role: "KITCHEN", phone: "9876543232" },
  ];

  const MENU_BY_CATEGORY = {
    Starters: [
      { name: "Crispy Corn Chaat", price: 180, costPrice: 80, sku: "ST-001" },
      { name: "Paneer Tikka", price: 280, costPrice: 130, sku: "ST-002" },
      { name: "Chicken Tikka", price: 320, costPrice: 150, sku: "ST-003" },
      { name: "Hara Bhara Kebab", price: 240, costPrice: 100, sku: "ST-004" },
      { name: "Fish Fingers", price: 350, costPrice: 170, sku: "ST-005" },
      { name: "Spring Rolls", price: 200, costPrice: 90, sku: "ST-006" },
    ],
    Soups: [
      { name: "Tomato Soup", price: 150, costPrice: 60, sku: "SO-001" },
      { name: "Hot & Sour Soup", price: 180, costPrice: 75, sku: "SO-002" },
      { name: "Chicken Manchow Soup", price: 220, costPrice: 100, sku: "SO-003" },
      { name: "Sweet Corn Soup", price: 170, costPrice: 70, sku: "SO-004" },
      { name: "Mushroom Soup", price: 200, costPrice: 85, sku: "SO-005" },
    ],
    Chinese: [
      { name: "Veg Manchurian", price: 220, costPrice: 100, sku: "CH-001" },
      { name: "Chilli Chicken", price: 320, costPrice: 150, sku: "CH-002" },
      { name: "Gobi Manchurian", price: 200, costPrice: 80, sku: "CH-003" },
      { name: "Schezwan Noodles", price: 250, costPrice: 110, sku: "CH-004" },
      { name: "Fried Rice", price: 230, costPrice: 100, sku: "CH-005" },
      { name: "Chicken Fried Rice", price: 280, costPrice: 130, sku: "CH-006" },
    ],
    "North Indian": [
      { name: "Butter Chicken", price: 380, costPrice: 180, sku: "NI-001" },
      { name: "Dal Makhani", price: 260, costPrice: 100, sku: "NI-002" },
      { name: "Palak Paneer", price: 280, costPrice: 120, sku: "NI-003" },
      { name: "Chicken Curry", price: 320, costPrice: 150, sku: "NI-004" },
      { name: "Butter Naan", price: 50, costPrice: 15, sku: "NI-005" },
      { name: "Tandoori Roti", price: 30, costPrice: 8, sku: "NI-006" },
      { name: "Mixed Veg Curry", price: 250, costPrice: 100, sku: "NI-007" },
    ],
    "South Indian": [
      { name: "Masala Dosa", price: 180, costPrice: 70, sku: "SI-001" },
      { name: "Idli (2 pcs)", price: 90, costPrice: 30, sku: "SI-002" },
      { name: "Medu Vada (2 pcs)", price: 100, costPrice: 35, sku: "SI-003" },
      { name: "Rava Dosa", price: 200, costPrice: 80, sku: "SI-004" },
      { name: "Onion Uttapam", price: 180, costPrice: 70, sku: "SI-005" },
      { name: "Sambar Rice", price: 220, costPrice: 90, sku: "SI-006" },
    ],
    Pizza: [
      { name: "Margherita Pizza", price: 350, costPrice: 150, sku: "PZ-001" },
      { name: "Farmhouse Pizza", price: 420, costPrice: 180, sku: "PZ-002" },
      { name: "Pepperoni Pizza", price: 480, costPrice: 210, sku: "PZ-003" },
      { name: "BBQ Chicken Pizza", price: 520, costPrice: 230, sku: "PZ-004" },
      { name: "Cheese Burst Pizza", price: 450, costPrice: 190, sku: "PZ-005" },
    ],
    Burger: [
      { name: "Aloo Tikki Burger", price: 120, costPrice: 50, sku: "BR-001" },
      { name: "Veggie Burger", price: 150, costPrice: 65, sku: "BR-002" },
      { name: "Chicken Burger", price: 200, costPrice: 90, sku: "BR-003" },
      { name: "Crispy Chicken Burger", price: 240, costPrice: 110, sku: "BR-004" },
      { name: "Double Cheese Burger", price: 280, costPrice: 130, sku: "BR-005" },
    ],
    Sandwich: [
      { name: "Veg Club Sandwich", price: 180, costPrice: 80, sku: "SW-001" },
      { name: "Grilled Cheese Sandwich", price: 160, costPrice: 70, sku: "SW-002" },
      { name: "Chicken Sandwich", price: 220, costPrice: 100, sku: "SW-003" },
      { name: "Paneer Tikka Sandwich", price: 210, costPrice: 90, sku: "SW-004" },
    ],
    Pasta: [
      { name: "White Sauce Pasta", price: 250, costPrice: 110, sku: "PA-001" },
      { name: "Red Sauce Pasta", price: 230, costPrice: 100, sku: "PA-002" },
      { name: "Chicken Alfredo Pasta", price: 320, costPrice: 150, sku: "PA-003" },
      { name: "Arabbiata Pasta", price: 260, costPrice: 110, sku: "PA-004" },
    ],
    Rice: [
      { name: "Steamed Rice", price: 120, costPrice: 40, sku: "RC-001" },
      { name: "Jeera Rice", price: 150, costPrice: 50, sku: "RC-002" },
      { name: "Veg Pulao", price: 220, costPrice: 90, sku: "RC-003" },
      { name: "Ghee Rice", price: 180, costPrice: 65, sku: "RC-004" },
      { name: "Lemon Rice", price: 160, costPrice: 55, sku: "RC-005" },
    ],
    Biryani: [
      { name: "Veg Biryani", price: 280, costPrice: 120, sku: "BY-001" },
      { name: "Chicken Biryani", price: 350, costPrice: 160, sku: "BY-002" },
      { name: "Mutton Biryani", price: 450, costPrice: 210, sku: "BY-003" },
      { name: "Hyderabadi Biryani", price: 380, costPrice: 170, sku: "BY-004" },
      { name: "Egg Biryani", price: 250, costPrice: 100, sku: "BY-005" },
    ],
    Desserts: [
      { name: "Gulab Jamun (2 pcs)", price: 100, costPrice: 35, sku: "DS-001" },
      { name: "Rasmalai", price: 120, costPrice: 45, sku: "DS-002" },
      { name: "Brownie with Ice Cream", price: 220, costPrice: 90, sku: "DS-003" },
      { name: "Kheer", price: 140, costPrice: 50, sku: "DS-004" },
      { name: "Fruit Custard", price: 160, costPrice: 60, sku: "DS-005" },
      { name: "Cheesecake", price: 250, costPrice: 110, sku: "DS-006" },
    ],
    "Ice Cream": [
      { name: "Vanilla Ice Cream", price: 90, costPrice: 35, sku: "IC-001" },
      { name: "Chocolate Ice Cream", price: 100, costPrice: 40, sku: "IC-002" },
      { name: "Strawberry Ice Cream", price: 100, costPrice: 40, sku: "IC-003" },
      { name: "Mango Ice Cream", price: 110, costPrice: 45, sku: "IC-004" },
      { name: "Butterscotch Ice Cream", price: 120, costPrice: 50, sku: "IC-005" },
    ],
    Beverages: [
      { name: "Mineral Water (1L)", price: 40, costPrice: 15, sku: "BV-001" },
      { name: "Soft Drink (Can)", price: 60, costPrice: 25, sku: "BV-002" },
      { name: "Cold Coffee", price: 150, costPrice: 60, sku: "BV-003" },
      { name: "Sweet Lassi", price: 120, costPrice: 45, sku: "BV-004" },
      { name: "Buttermilk", price: 80, costPrice: 25, sku: "BV-005" },
    ],
    Tea: [
      { name: "Masala Chai", price: 40, costPrice: 10, sku: "TE-001" },
      { name: "Green Tea", price: 50, costPrice: 15, sku: "TE-002" },
      { name: "Lemon Tea", price: 50, costPrice: 15, sku: "TE-003" },
      { name: "Ginger Tea", price: 45, costPrice: 12, sku: "TE-004" },
      { name: "Iced Tea", price: 80, costPrice: 25, sku: "TE-005" },
    ],
    Coffee: [
      { name: "Filter Coffee", price: 80, costPrice: 30, sku: "CF-001" },
      { name: "Espresso", price: 100, costPrice: 35, sku: "CF-002" },
      { name: "Cappuccino", price: 130, costPrice: 50, sku: "CF-003" },
      { name: "Cafe Latte", price: 150, costPrice: 55, sku: "CF-004" },
      { name: "Mocha", price: 170, costPrice: 65, sku: "CF-005" },
    ],
    "Fresh Juice": [
      { name: "Orange Juice", price: 130, costPrice: 50, sku: "FJ-001" },
      { name: "Watermelon Juice", price: 110, costPrice: 40, sku: "FJ-002" },
      { name: "Mixed Fruit Juice", price: 160, costPrice: 65, sku: "FJ-003" },
      { name: "Mosambi Juice", price: 120, costPrice: 45, sku: "FJ-004" },
      { name: "Pineapple Juice", price: 140, costPrice: 55, sku: "FJ-005" },
    ],
    Mocktails: [
      { name: "Virgin Mojito", price: 180, costPrice: 70, sku: "MK-001" },
      { name: "Blue Lagoon", price: 200, costPrice: 80, sku: "MK-002" },
      { name: "Pina Colada", price: 220, costPrice: 90, sku: "MK-003" },
      { name: "Strawberry Delight", price: 190, costPrice: 75, sku: "MK-004" },
      { name: "Sunrise Splash", price: 210, costPrice: 85, sku: "MK-005" },
    ],
  };

  const TABLE_CONFIG = [
    { floor: "Ground Floor", start: 1, end: 12, capacities: [2, 4, 4, 4, 6, 6, 2, 4, 4, 4, 6, 6] },
    { floor: "First Floor", start: 13, end: 22, capacities: [2, 4, 4, 4, 6, 6, 2, 4, 4, 6, 6] },
    { floor: "Family Section", start: 23, end: 30, capacities: [6, 6, 8, 8, 6, 6, 8, 8] },
    { floor: "Outdoor", start: 31, end: 36, capacities: [4, 4, 6, 6, 4, 4] },
    { floor: "VIP Lounge", start: 37, end: 40, capacities: [8, 8, 10, 12] },
  ];

  const NON_VEG_SKUS = [
    "NI-001", "NI-004", "CH-002", "CH-006",
    "ST-003", "ST-005", "SO-003",
    "PZ-003", "PZ-004", "BR-003", "BR-004",
    "SW-003", "PA-003",
    "BY-002", "BY-003", "BY-004",
  ];

  // ═══════════════════════════════════════════════════════════════════
  //  MAIN SEED FUNCTION
  // ═══════════════════════════════════════════════════════════════════

  async function main() {
    console.log("Seeding database...\n");

    const hash = await bcrypt.hash("password123", 10);
    const superAdminHash = await bcrypt.hash("SuperAdmin@123", 10);

    // ─── 1. SUPER ADMIN ─────────────────────────────────────────────
    await prisma.user.upsert({
      where: { email: "superadmin@pos.com" },
      update: { isActive: true },
      create: {
        name: "Super Admin",
        email: "superadmin@pos.com",
        phone: "9999999999",
        password: superAdminHash,
        role: UserRole.SUPER_ADMIN,
        isActive: true,
      },
    });
    console.log("Super Admin ready");

    // ─── 1.5 MODULES (database-driven catalog — plan permissions are relational) ─
    const MODULES = [
      { key: "dashboard", name: "Dashboard", icon: "layout-dashboard", sortOrder: 1 },
      { key: "pos", name: "POS Ordering", icon: "shopping-cart", sortOrder: 2 },
      { key: "billing", name: "Billing & Payments", icon: "receipt", sortOrder: 3 },
      { key: "floors", name: "Floor Management", icon: "building", sortOrder: 4 },
      { key: "tables", name: "Table Management", icon: "layers", sortOrder: 5 },
      { key: "kitchen", name: "Kitchen (KOT)", icon: "chef-hat", sortOrder: 6 },
      { key: "active_orders", name: "Active Orders", icon: "clock", sortOrder: 7 },
      { key: "menu", name: "Menu & Stock", icon: "utensils", sortOrder: 8 },
      { key: "customers", name: "Customers", icon: "contact", sortOrder: 9 },
      { key: "staff", name: "Staff", icon: "users", sortOrder: 10 },
      { key: "reports", name: "Reports & Sales", icon: "bar-chart", sortOrder: 11 },
      { key: "inventory", name: "Inventory", icon: "boxes", sortOrder: 12 },
      { key: "settings", name: "Settings", icon: "settings", sortOrder: 13 },
      { key: "printers", name: "Printer Management", icon: "printer", sortOrder: 14 },
      { key: "qr_ordering", name: "QR Ordering", icon: "qr-code", sortOrder: 15 },
      { key: "api_access", name: "API Access", icon: "code", sortOrder: 16 },
      { key: "multi_terminal", name: "Multi-Terminal", icon: "monitor", sortOrder: 17 },
    ];
    const BASIC_MODULES = ["dashboard", "pos", "billing", "floors", "tables", "kitchen", "active_orders", "menu", "customers", "staff", "reports", "settings", "printers"];
    const PREMIUM_MODULES = MODULES.map((m) => m.key);

    // ─── 1.6 PLANS (only Basic and Premium by default — no hardcoded config) ───
    const PLANS = [
      { code: "BASIC", name: "Basic", description: "For small single-outlet restaurants.", monthlyPrice: 999, yearlyPrice: 9990, billingCycle: "MONTHLY", trialDays: 0, maxUsers: 10, maxTables: 30, maxFloors: 2, maxMenuItems: 250, maxPrinters: 2, maxBranches: 1, maxOrdersPerMonth: 5000, storageLimitMB: 500, isActive: true, isDefault: true, sortOrder: 1, modules: BASIC_MODULES },
      { code: "PREMIUM", name: "Premium", description: "For multi-branch establishments.", monthlyPrice: 9999, yearlyPrice: 99990, billingCycle: "YEARLY", trialDays: 0, maxUsers: 100, maxTables: 300, maxFloors: 10, maxMenuItems: null, maxPrinters: 10, maxBranches: 10, maxOrdersPerMonth: null, storageLimitMB: 10000, isActive: true, isDefault: false, sortOrder: 2, modules: PREMIUM_MODULES },
    ];

    // Upsert module catalog
    const moduleIdByKey = {};
    for (const mod of MODULES) {
      const m = await prisma.planModule.upsert({
        where: { key: mod.key },
        update: { name: mod.name, icon: mod.icon, sortOrder: mod.sortOrder, isActive: true },
        create: { ...mod },
      });
      moduleIdByKey[mod.key] = m.id;
    }

    // Upsert plans + relational permissions + backfill existing subscription snapshots
    const seededPlanIds = [];
    for (const pl of PLANS) {
      const features = pl.modules;
      const { modules: _modules, ...planBase } = pl; // `modules` is seed-only; never written to Plan
      const plan = await prisma.plan.upsert({
        where: { code: pl.code },
        update: {
          name: pl.name, description: pl.description, monthlyPrice: pl.monthlyPrice, yearlyPrice: pl.yearlyPrice,
          billingCycle: pl.billingCycle, trialDays: pl.trialDays, maxUsers: pl.maxUsers, maxTables: pl.maxTables,
          maxFloors: pl.maxFloors, maxMenuItems: pl.maxMenuItems, maxPrinters: pl.maxPrinters, maxBranches: pl.maxBranches,
          maxOrdersPerMonth: pl.maxOrdersPerMonth, storageLimitMB: pl.storageLimitMB, features,
          isActive: true, isDefault: pl.isDefault, sortOrder: pl.sortOrder,
        },
        create: { ...planBase, features },
      });
      seededPlanIds.push(plan.id);
      // Relational permissions (full replace — source of truth for module access)
      await prisma.planModulePermission.deleteMany({ where: { planId: plan.id } });
      await prisma.planModulePermission.createMany({
        data: MODULES.map((mod) => ({ planId: plan.id, moduleId: moduleIdByKey[mod.key], isEnabled: features.includes(mod.key) })),
      });
      // Backfill existing subscriptions so live restaurants inherit the new module set immediately
      await prisma.subscription.updateMany({ where: { planId: plan.id }, data: { features } });
    }
    // Legacy snapshots (plans that predate the Dashboard module) must keep it — Dashboard
    // was implicitly always-on before this feature. Adds it when missing.
    const legacySubs = await prisma.subscription.findMany({
      where: { NOT: { planId: { in: seededPlanIds } } },
      select: { id: true, features: true },
    });
    for (const ls of legacySubs) {
      const features = Array.isArray(ls.features) ? ls.features : [];
      if (!features.includes("dashboard")) {
        await prisma.subscription.update({ where: { id: ls.id }, data: { features: ["dashboard", ...features] } });
      }
    }

    // Remove leftover plans (TRIAL/PRO/ENTERPRISE/...) that are NOT assigned to any restaurant,
    // so a fresh install contains only Basic and Premium. Assigned plans are kept (deletion is blocked by design).
    const legacyPlans = await prisma.plan.findMany({
      where: { code: { notIn: ["BASIC", "PREMIUM"] } },
      include: { _count: { select: { subscriptions: true } } },
    });
    for (const legacy of legacyPlans) {
      if (legacy._count.subscriptions === 0) {
        await prisma.plan.delete({ where: { id: legacy.id } }); // permissions cascade
        console.log("Removed legacy plan: " + legacy.code);
      }
    }
    console.log(PLANS.length + " subscription plans ready (Basic, Premium) with " + MODULES.length + " catalog modules");

    // ─── 2. RESTAURANT ──────────────────────────────────────────────
    let restaurant = await prisma.restaurant.findFirst({
      where: { name: "The Golden Grill" },
    });

    if (!restaurant) {
      restaurant = await prisma.restaurant.create({
        data: {
          name: "The Golden Grill",
          ownerName: "Vikram Singh",
          phone: "9876543210",
          email: "info@goldengrill.com",
          gstNumber: "27AABCU9603R1ZV",
          fssaiNumber: "11521995001234",
          address: "MG Road, Camp",
          city: "Pune",
          state: "Maharashtra",
          country: "India",
          pincode: "411001",
          status: "ACTIVE",
        },
      });
      console.log("Restaurant created: The Golden Grill");

      // ─── 3. RESTAURANT SETTINGS ────────────────────────────────────
      await prisma.restaurantSetting.create({
        data: {
          restaurantId: restaurant.id,
          restaurantName: "The Golden Grill",
          currency: "INR",
          taxPercentage: 0, // No default taxes — components are created manually by the restaurant
          serviceCharge: 0,
          roundOffEnabled: true,
          billPrefix: "BILL",
          invoicePrefix: "INV",
          kotPrefix: "KOT",
          receiptFooter: "Thank You! Visit Again.",
          enableKitchenDisplay: true,
          enableKotStatusTracking: true,
          timezone: "Asia/Kolkata",
        },
      });

      // ─── 4. PRINTER SETTINGS ──────────────────────────────────────
      await prisma.printerSetting.create({
        data: {
          restaurantId: restaurant.id,
          printerName: "Default Printer",
          printerWidth: 80,
          autoPrintBill: true,
          autoPrintKOT: true,
        },
      });

      // ─── 5. SUBSCRIPTION ───────────────────────────────────────────
      const premiumPlan = await prisma.plan.findUnique({ where: { code: "PREMIUM" } });
      const expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      await prisma.subscription.create({
        data: {
          restaurantId: restaurant.id,
          planId: premiumPlan ? premiumPlan.id : null,
          plan: "PREMIUM",
          status: SubscriptionStatus.ACTIVE,
          startDate: new Date(),
          expiryDate,
          nextRenewalDate: expiryDate,
          billingCycle: "YEARLY",
          maxUsers: 100,
          maxTables: 300,
          maxMenuItems: null,
          maxFloors: 10,
          maxPrinters: 10,
          maxBranches: 10,
          storageLimitMB: 10000,
          features: premiumPlan ? premiumPlan.features : ["pos", "menu", "billing", "tables", "active_orders"],
          amount: 9999,
          autoRenew: true,
        },
      });
      if (restaurant.subscriptionPlan !== "PREMIUM") {
        await prisma.restaurant.update({ where: { id: restaurant.id }, data: { subscriptionPlan: "PREMIUM" } });
      }

      // ─── 6. WALK-IN CUSTOMER ──────────────────────────────────────
      await prisma.customer.create({
        data: { restaurantId: restaurant.id, name: "Walk-in Customer", type: CustomerType.WALK_IN },
      });

      console.log("Restaurant + settings + printer + subscription + walk-in customer created");
    } else {
      console.log("Restaurant already exists");
    }

    // ─── 7. DELETE TRANSACTIONAL DATA ONLY ──────────────────────────
    // Never delete: Restaurant, RestaurantSetting, PrinterSetting,
    // Subscription, Users, Categories, MenuItems, Floors, RestaurantTables.
    await prisma.payment.deleteMany({ where: { restaurantId: restaurant.id } });
    await prisma.bill.deleteMany({ where: { restaurantId: restaurant.id } });
    await prisma.kOT.deleteMany({ where: { restaurantId: restaurant.id } });
    await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } });
    await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } });
    // Reset tables to AVAILABLE for fresh order generation
    await prisma.restaurantTable.updateMany({
      where: { restaurantId: restaurant.id },
      data: { status: TableStatus.AVAILABLE },
    });
    console.log("Transactional data cleared (payments, bills, KOTs, orders)");

    // ─── 8. CATEGORIES (upsert — idempotent) ────────────────────────
    const categoryMap = {};
    for (let i = 0; i < CATEGORIES_DATA.length; i++) {
      const cat = CATEGORIES_DATA[i];
      const created = await prisma.category.upsert({
        where: { restaurantId_name: { restaurantId: restaurant.id, name: cat.name } },
        update: { color: cat.color, icon: cat.icon, isActive: true },
        create: {
          name: cat.name,
          color: cat.color,
          icon: cat.icon,
          sortOrder: i + 1,
          isActive: true,
          restaurantId: restaurant.id,
        },
      });
      categoryMap[cat.name] = created.id;
    }
    console.log(CATEGORIES_DATA.length + " categories ready");

    // ─── 9. MENU ITEMS (upsert — idempotent uses @@unique([restaurantId, sku])) ─
    let itemCounter = 0;
    for (const [catName, items] of Object.entries(MENU_BY_CATEGORY)) {
      const categoryId = categoryMap[catName];
      if (!categoryId) continue;
      for (const item of items) {
        itemCounter++;
        const isNonVeg = NON_VEG_SKUS.includes(item.sku);
        await prisma.menuItem.upsert({
          where: {
            restaurantId_sku: { restaurantId: restaurant.id, sku: item.sku },
          },
          update: {
            name: item.name,
            price: item.price,
            costPrice: item.costPrice,
            isAvailable: true,
            isVeg: !isNonVeg,
          },
          create: {
            name: item.name,
            sku: item.sku,
            description: "Delicious " + item.name + " prepared with fresh ingredients.",
            shortDescription: isNonVeg ? "Non-Vegetarian" : "Vegetarian",
            price: item.price,
            costPrice: item.costPrice,
            gstPercentage: 0, // No default GST — tax is configured manually per restaurant
            taxInclusive: true,
            preparationTime: randomInt(5, 25),
            kitchenCategory: catName,
            displayOrder: items.indexOf(item) + 1,
            isVeg: !isNonVeg,
            isAvailable: true,
            isFeatured: itemCounter <= 10,
            isRecommended: itemCounter >= 20 && itemCounter <= 30,
            currentStock: randomInt(20, 100),
            minStock: 10,
            maxStock: 200,
            unit: "piece",
            categoryId: categoryId,
            restaurantId: restaurant.id,
          },
        });
      }
    }
    console.log(itemCounter + " menu items ready");

    // ─── 10. RELOAD MENU ITEMS FROM DATABASE ────────────────────────
    // CRITICAL: Always use fresh IDs from the database, never stale in-memory objects.
    // This prevents P2003 foreign key violations (OrderItem_menuItemId_fkey).
    const allMenuItems = await prisma.menuItem.findMany({
      where: { restaurantId: restaurant.id, isAvailable: true },
    });
    console.log(allMenuItems.length + " menu items loaded from database");

    // ─── 11. FLOORS (upsert — idempotent) ───────────────────────────
    const floorMap = {};
    for (const floor of FLOORS_DATA) {
      const created = await prisma.floor.upsert({
        where: { restaurantId_name: { restaurantId: restaurant.id, name: floor.name } },
        update: { sortOrder: floor.sortOrder },
        create: {
          name: floor.name,
          sortOrder: floor.sortOrder,
          restaurantId: restaurant.id,
        },
      });
      floorMap[floor.name] = created.id;
    }
    console.log(Object.keys(floorMap).length + " floors ready");

    // ─── 12. RESTAURANT TABLES (upsert — idempotent) ────────────────
    const allTables = [];
    for (const cfg of TABLE_CONFIG) {
      const floorId = floorMap[cfg.floor] || null;
      for (let i = cfg.start; i <= cfg.end; i++) {
        const tableNo = "T" + String(i).padStart(2, "0");
        const capacity = cfg.capacities[i - cfg.start] || 4;
        const table = await prisma.restaurantTable.upsert({
          where: { restaurantId_tableNo: { restaurantId: restaurant.id, tableNo } },
          update: { capacity, status: TableStatus.AVAILABLE, floorId },
          create: {
            tableNo,
            capacity,
            status: TableStatus.AVAILABLE,
            floorId,
            restaurantId: restaurant.id,
          },
        });
        allTables.push(table);
      }
    }
    console.log(allTables.length + " tables ready");

    // ─── 13. USERS (upsert — idempotent) ────────────────────────────
    await prisma.user.upsert({
      where: { email: "admin@restaurant.com" },
      update: { isActive: true },
      create: {
        restaurantId: restaurant.id,
        name: "Admin",
        email: "admin@restaurant.com",
        password: hash,
        role: UserRole.ADMIN,
        isActive: true,
        phone: "9876543244",
      },
    });
    await prisma.user.upsert({
  where: { email: "manager@restaurant.com" },
  update: {
    isActive: true,
    phone: "9876543256",
  },
  create: {
    restaurantId: restaurant.id,
    name: "Manager",
    email: "manager@restaurant.com",
    password: hash,
    role: UserRole.MANAGER,
    isActive: true,
    phone: "9876543256",
  },
});
    for (const u of USERS_DATA) {
      await prisma.user.upsert({
        where: { email: u.email },
        update: { isActive: true },
        create: {
          restaurantId: restaurant.id,
          name: u.name,
          email: u.email,
          password: hash,
          role: UserRole[u.role],
          isActive: true,
          phone: u.phone,
        },
      });
    }
    console.log(USERS_DATA.length + 2 + " users ready");

    // ─── 14. REGULAR CUSTOMER ───────────────────────────────────────
    let regCust = await prisma.customer.findFirst({
      where: { restaurantId: restaurant.id, type: CustomerType.REGULAR },
    });
    if (!regCust) {
      regCust = await prisma.customer.create({
        data: {
          restaurantId: restaurant.id,
          name: "Regular Guest",
          type: CustomerType.REGULAR,
          phone: "8888888888",
        },
      });
    }

    // ─── 15–18. ORDERS, KOT, BILLS, PAYMENTS ─────────────────────
    // All menuItemId references use FRESH IDs from the database (allMenuItems).
    const statusPool = [
      OrderStatus.COMPLETED, OrderStatus.COMPLETED, OrderStatus.COMPLETED,
      OrderStatus.COMPLETED, OrderStatus.COMPLETED,
      OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY,
      OrderStatus.CANCELLED,
    ];
    // Today's orders: heavily favor COMPLETED so dashboard KPIs show revenue
    const todayStatusPool = [
      OrderStatus.COMPLETED, OrderStatus.COMPLETED, OrderStatus.COMPLETED,
      OrderStatus.COMPLETED, OrderStatus.COMPLETED, OrderStatus.COMPLETED,
      OrderStatus.COMPLETED,
      OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY,
    ];
    const payMethods = [PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.UPI];

    let oCnt = 0, kCnt = 0, bCnt = 0, pCnt = 0;

    for (let oi = 0; oi < 100; oi++) {
      oCnt++;
      const orderNo = "ORD-" + String(oCnt).padStart(4, "0");
      const itemCount = randomInt(2, 6);

      // Pick items from the FRESHLY LOADED database array
      const sel = [];
      for (let si = 0; si < itemCount; si++) {
        sel.push(pick(allMenuItems));
      }

      const orderItems = sel.map(function (item) {
        const qty = randomInt(1, 3);
        return {
          quantity: qty,
          price: item.price,
          tax: parseFloat(((item.price * qty * 0) / 100).toFixed(2)),
          total: parseFloat((item.price * qty).toFixed(2)),
          menuItemId: item.id, // Always the DB id
        };
      });

      const sub = parseFloat(orderItems.reduce(function (s, o) { return s + o.total; }, 0).toFixed(2));
      const tax = parseFloat(orderItems.reduce(function (s, o) { return s + o.tax; }, 0).toFixed(2));
      const disc = oi % 7 === 0 ? parseFloat((sub * 0.1).toFixed(2)) : 0;
      const svc = oi % 5 === 0 ? parseFloat((sub * 0.05).toFixed(2)) : 0;
      const total = parseFloat((sub + tax + svc - disc).toFixed(2));
      const todayOrder = oi < 25;
      const status = pick(todayOrder ? todayStatusPool : statusPool);
      const d = todayOrder ? hoursAgo(randomInt(1, 6)) : daysAgo(randomInt(1, 30));
      const dineIn = oi % 4 !== 0;
      const table = dineIn ? pick(allTables) : null;
      const cust = oi % 10 === 0 ? regCust : undefined;

      const order = await prisma.order.create({
        data: {
          orderNo,
          orderType: dineIn ? OrderType.DINE_IN : pick([OrderType.TAKEAWAY, OrderType.DELIVERY]),
          status,
          subtotal: sub,
          taxAmount: tax,
          totalAmount: total,
          tableId: table ? table.id : null,
          discount: disc,
          serviceCharge: svc,
          roundOff: 0,
          restaurantId: restaurant.id,
          customerId: cust ? cust.id : null,
          createdAt: d,
          updatedAt: d,
          cancelledAt: status === OrderStatus.CANCELLED ? d : null,
          orderItems: {
            create: orderItems.map(function (o) {
              return {
                quantity: o.quantity,
                price: o.price,
                tax: o.tax,
                total: o.total,
                menuItemId: o.menuItemId,
              };
            }),
          },
        },
      });

      // Update table status
      if (dineIn && table) {
        await prisma.restaurantTable.update({
          where: { id: table.id },
          data: {
            status:
              status === OrderStatus.COMPLETED || status === OrderStatus.CANCELLED
                ? TableStatus.AVAILABLE
                : TableStatus.OCCUPIED,
          },
        });
      }

      // ─── 16. KOT ──────────────────────────────────────────────────
      if (status !== OrderStatus.CANCELLED) {
        kCnt++;
        let ks = KOTStatus.PENDING;
        if (status === OrderStatus.COMPLETED) ks = KOTStatus.SERVED;
        else if (status === OrderStatus.READY) ks = KOTStatus.READY;
        else if (status === OrderStatus.PREPARING) ks = KOTStatus.PREPARING;
        await prisma.kOT.create({
          data: {
            kotNo: "KOT-" + String(kCnt).padStart(4, "0"),
            status: ks,
            orderId: order.id,
            printCount: 1,
            restaurantId: restaurant.id,
            createdAt: d,
            updatedAt: d,
          },
        });
      }

      // ─── 17. BILL + 18. PAYMENT ───────────────────────────────────
      if (status === OrderStatus.COMPLETED) {
        bCnt++;
        const pm = pick(payMethods);
        const billRef = await prisma.bill.create({
          data: {
            billNo: "BILL-" + String(bCnt).padStart(4, "0"),
            orderId: order.id,
            subtotal: sub,
            taxAmount: tax,
            discount: disc,
            serviceCharge: svc,
            roundOff: 0,
            grandTotal: total,
            paymentMethod: pm,
            status: BillStatus.PAID,
            paidAmount: total,
            balanceAmount: 0,
            paymentStatus: PaymentStatus.PAID,
            restaurantId: restaurant.id,
            createdAt: d,
            updatedAt: d,
          },
        });

        pCnt++;
        await prisma.payment.create({
          data: {
            paymentNo: "PAY-" + String(pCnt).padStart(4, "0"),
            billId: billRef.id,
            amount: total,
            paymentMethod: pm,
            restaurantId: restaurant.id,
            createdAt: d,
            updatedAt: d,
          },
        });
      }
    }

    // ─── SUMMARY ────────────────────────────────────────────────────
    console.log(oCnt + " orders created");
    console.log(kCnt + " KOTs created");
    console.log(bCnt + " bills created");
    console.log(pCnt + " payments created");

    console.log("");
    console.log("========================================");
    console.log("      SEED COMPLETE!");
    console.log("========================================");
    console.log("  Categories:   " + CATEGORIES_DATA.length);
    console.log("  Menu Items:   " + allMenuItems.length);
    console.log("  Tables:       " + allTables.length);
    console.log("  Orders:       " + oCnt);
    console.log("  KOTs:         " + kCnt);
    console.log("  Bills:        " + bCnt);
    console.log("  Payments:     " + pCnt);
    console.log("----------------------------------------");
    console.log("  Login Credentials:");
    console.log("  Super Admin:  superadmin@pos.com / SuperAdmin@123");
    console.log("  Admin:        admin@restaurant.com / password123");
    console.log("  Manager:      manager@restaurant.com / password123");
    console.log("========================================");
    console.log("");
  }

  main()
    .catch(function (error) {
      console.error("Seed failed:", error);
      process.exit(1);
    })
    .finally(async function () {
      await prisma.$disconnect();
    });
