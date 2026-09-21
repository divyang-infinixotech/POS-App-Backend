// Execution-based regression test for the "Assignment to constant variable" bug.
// Exercises the ACTUAL createOrder control flow without a database by stubbing
// prisma/tx and req/res. A regression re-introducing a const reassignment (or
// any TDZ/const mutation on the BASIC_POS path) throws here.
const path = require("path");

let failures = 0;
const check = (cond, label) => {
  console.log((cond ? "PASS" : "FAIL") + " - " + label);
  if (!cond) failures++;
};



// ── Stub modules that hit the DB / socket layer BEFORE the controller is
// required (the controller captures its imports at require-time) ──
const stub = (p, exports) => {
  const resolved = path.resolve(__dirname, "../..", p);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub("src/services/inventory.service.js", { deductStockForOrderCreation: async () => {}, deductStockForAddedItems: async () => {}, adjustStockForOrderChange: async () => {}, restoreStockForCancelledOrder: async () => {} });
stub("src/services/notification.service.js", { createNotification: async () => {} });
stub("src/services/socket.js", { emitOrderEvent: () => {} });
stub("src/utils/floorAccess.js", { orderFloorScopeFor: async () => null, orderFloorAccessError: async () => null, tableScopeFor: async () => null, floorAccessDenied: () => null, getAssignedFloorIds: async () => [] });
stub("src/utils/orderAccess.js", { orderTypeAccessError: async () => null });
stub("src/utils/dietary.js", { dietaryItemError: async () => null });
stub("src/services/order.service.js", { recalculateOrder: async () => {} });

// ── Stub the tenant prisma config before the controller is required ──
const configPath = path.resolve(__dirname, "../..",  "src/config/tenantPrisma.js");
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, exports: {
    platformPrisma: {
      restaurant: { findUnique: async () => ({ businessType: "BAKERY" }) },
    },
  },
};

const controller = require(path.resolve(__dirname, "../..",  "src/controllers/order.controller.js"));
check(typeof controller.createOrder === "function", "createOrder is exported");

// ── Build a fake tenant prisma where every model call returns inert data ──
const makeModel = (name) => ({
  findFirst: async (q) => {
    if (name === "menuItem") {
      return { id: Number(q.where.id), name: "Veg Paneer Puff", price: 100, tax: 5, isAvailable: true, trackStock: false };
    }
    if (name === "customer") return { id: 11, name: "Walk-in Customer", type: "WALK_IN" };
    if (name === "restaurantSetting") return { enableCounterSale: false };
    return null;
  },
  findUnique: async (q) => {
    if (name === "order") {
      return {
        id: 205, orderNo: "ORD-000205", orderType: captured.orderType, tableId: null,
        table: null, customer: { id: 11, name: "Walk-in Customer" },
        kot: [{ id: 900, kotNo: "KOT-0091", status: "PENDING" }],
        orderItems: [{ id: 1, menuItemId: 7, quantity: 2, price: 100, notes: null, menuItem: { id: 7, name: "Veg Paneer Puff" } }],
      };
    }
    if (name === "restaurantTable") return null;
    return null;
  },
  create: async (q) => {
    if (name === "order") {
      captured.orderType = q.data.orderType;
      captured.tableId = q.data.tableId;
      captured.userId = q.data.userId;
      return { id: 205, orderNo: "ORD-000205", orderType: q.data.orderType, totalAmount: q.data.totalAmount };
    }
    if (name === "kOT") return { id: 900, kotNo: "KOT-0091", status: "PENDING" };
    if (name === "customer") return { id: 11 };
    return { id: 1 };
  },
  createMany: async () => ({ count: 1 }),
  update: async () => ({}),
  updateMany: async () => ({ count: 1 }),
  aggregate: async () => ({ _count: { id: 100 } }),
  groupBy: async () => [],
  count: async () => 0,
});
const captured = {};
const modelProxy = () => new Proxy({}, { get: (_t, m) => makeModel(String(m)) });
const tenantDb = new Proxy({}, {
  get: (_t, model) => {
    if (model === "$transaction") {
      return async (fn) => fn(modelProxy());
    }
    return makeModel(String(model));
  },
});

// ── req/res doubles ──
const res = {
  statusCode: 0, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
};

(async () => {
  // ── Case 1: BASIC_POS production order (the exact reported failure) ──
  const req = {
    tenantDb, body: { orderType: "DINE_IN", tableId: 999, items: [{ menuItemId: 7, quantity: 2 }] },
    user: { id: 5, restaurantId: 1, role: "CASHIER" },
  };
  let threw = null;
  try {
    await controller.createOrder(req, res);
  } catch (e) {
    threw = e;
  }
  check(threw === null, "BASIC_POS production order does not throw (" + (threw && threw.message) + ")");
  check(!(threw && /constant/i.test(threw.message)), 'No "Assignment to constant variable" error');
  check(res.statusCode === 201 || (res.body && res.body.success), "POST /api/orders returns success (201) for BASIC_POS production order");
  check(captured.orderType === "COUNTER_SALE", "Order persisted as COUNTER_SALE");
  check(captured.tableId === null || captured.tableId === undefined, "No table attached (client-supplied tableId dropped)");
  check(captured.userId === 5, "Authenticated user recorded as order owner");

  // ── Case 2: Quick Billing ON → no KOT ──
  let kotCreated = false;
  const qbDb = new Proxy({}, {
    get: (_t, model) => {
      if (model === "$transaction") return async (fn) => fn(modelProxy());
      const m = makeModel(String(model));
      if (String(model) === "kOT") {
        return { ...m, create: async () => { kotCreated = true; return { id: 1, kotNo: "KOT-X" }; } };
      }
      if (String(model) === "restaurantSetting") {
        return { findFirst: async () => ({ enableCounterSale: true }) };
      }
      return m;
    },
  });
  const res2 = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await controller.createOrder({ tenantDb: qbDb, body: { orderType: "COUNTER_SALE", items: [{ menuItemId: 7, quantity: 1 }] }, user: { id: 5, restaurantId: 1, role: "CASHIER" } }, res2);
  check(!(res2.body && res2.body.success === false), "Quick Billing order also succeeds");
  check(!kotCreated, "Quick Billing ON creates NO KOT");

  console.log(failures === 0 ? "\nALL ORDER-PATH CHECKS PASSED" : "\n" + failures + " FAILURE(S)");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
