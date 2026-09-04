const express = require("express");
const audit = require("../middleware/audit.middleware");

const router = express.Router();

const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const validate = require("../middleware/validate.middleware");
const requireFeature = require("../middleware/feature.middleware");

const {
    createOrderSchema,
    cancelOrderSchema,
    changeTableSchema,
    updateOrderSchema,
    updateDiscountSchema
} = require("../validators/order.validator");
const {
    addOrderItemSchema,
    updateOrderItemSchema
    
} = require("../validators/order-item.validator");

const {

    createOrder,

    getOrders,
    getActiveOrders,

    getOrderById,
    updateOrder,
    addOrderItem,
    updateOrderItem,
    deleteOrderItem,
    updateOrderStatus,
    updateDiscount,

    cancelOrder,
    holdOrder,
    resumeOrder,
    changeTable,
    deleteOrder,
    mergeOrders,
    updateOrderNotes

} = require("../controllers/order.controller");

router.post(
    "/",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature("pos"),
    validate(createOrderSchema),
    createOrder
);

// Order listing powers the Active Orders board (and its Hold/Completed/Cancelled
// tabs). KITCHEN is deliberately excluded — kitchen staff only access Kitchen
// Tickets (GET /api/kots), never the order board. WAITER keeps its access.
router.get(
    "/",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature(["active_orders", "pos"]),
    getOrders
);

// Shared by the Active Orders screen (active_orders) and the Kitchen screen (kitchen)
// KITCHEN is deliberately excluded — kitchen staff only access Kitchen Tickets (GET /api/kots),
// never the Active Orders board. WAITER keeps its existing access.
router.get(
    "/active",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature(["active_orders", "kitchen"]),
    getActiveOrders
);

// Single-order view is used by Active Orders, the POS checkout overlay, and the
// order-taking wizard — never by the Kitchen screen (KOTs embed the order data
// the kitchen needs). KITCHEN is denied so it cannot pull full order/bill data.
router.get(
    "/:id",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature(["pos", "active_orders", "kitchen"]),
    getOrderById
);

// Status updates are performed from the Active Orders and Kitchen screens (and the POS checkout flow)
router.patch(
    "/:id/status",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "KITCHEN"),
    requireFeature(["active_orders", "kitchen", "pos"]),
    updateOrderStatus
);
router.post(
    "/:id/items",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature("pos"),
    validate(addOrderItemSchema),
    audit("ORDER", "UPDATE", (req) => `Added item to Order ${req.params.id}`),
    addOrderItem
);
router.patch(
    "/:id/discount",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature(["active_orders", "pos"]),
    validate(updateDiscountSchema),
    audit("ORDER", "UPDATE", (req) => `Updated discount for Order ${req.params.id}`),
    updateDiscount
);
router.patch(
    "/:id/cancel",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER"),
    requireFeature(["active_orders", "pos"]),
    validate(cancelOrderSchema),
    audit("ORDER", "CANCEL", (req) => `Cancelled Order ${req.params.id}`),
    cancelOrder
);
router.patch(
    "/:id/hold",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER"),
    requireFeature(["active_orders", "pos"]),
    audit("ORDER", "UPDATE", (req) => `Order ${req.params.id} placed on hold`),
    holdOrder
);
router.patch(
    "/:id/resume",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature(["active_orders", "pos"]),
    audit("ORDER", "UPDATE", (req) => `Order ${req.params.id} resumed`),
    resumeOrder
);
router.patch(
    "/:id/change-table",
    protect,
    authorize("ADMIN", "MANAGER", "WAITER"),
    requireFeature(["tables", "pos"]),
    validate(changeTableSchema),
    audit("ORDER", "UPDATE", (req) => `Moved Order ${req.params.id} to Table ${req.body.tableId}`),
    changeTable
);
router.patch(
    "/:orderId/items/:itemId",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature(["active_orders", "pos"]),
    validate(updateOrderItemSchema),
    audit("ORDER", "UPDATE", (req) => `Updated item ${req.params.itemId} in Order ${req.params.orderId}`),
    updateOrderItem
);
router.put(
    "/:id",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature(["active_orders", "pos"]),
    validate(updateOrderSchema),
    audit("ORDER", "UPDATE", (req) => `Updated Order ${req.params.id}`),
    updateOrder
);
router.delete(
    "/:orderId/items/:itemId",
    protect,
    authorize("ADMIN"),
    requireFeature(["active_orders", "pos"]),
    audit("ORDER", "DELETE", (req) => `Deleted item ${req.params.itemId} from Order ${req.params.orderId}`),
    deleteOrderItem
);
router.delete(
    "/:id",
    protect,
    authorize("ADMIN"),
    requireFeature(["active_orders", "pos"]),
    audit("ORDER", "DELETE", (req) => `Deleted Order ${req.params.id}`),
    deleteOrder
);

// ── Merge Orders ──
router.post(
    "/:id/merge",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature(["tables", "pos"]),
    audit("ORDER", "MERGE", (req) => `Merged Order ${req.params.id} into ${req.body.targetOrderId}`),
    mergeOrders
);

// ── Split Orders ──
router.post(
    "/split",
    protect,
    authorize("ADMIN", "MANAGER"),
    requireFeature(["tables", "pos"]),
    audit("ORDER", "SPLIT", (req) => `Split merge group ${req.body.mergeGroupId}`),
    require("../controllers/order.controller").splitOrders
);

// ── Update Order Notes ──
router.patch(
    "/:id/notes",
    protect,
    authorize("ADMIN", "MANAGER", "CASHIER", "WAITER"),
    requireFeature(["active_orders", "pos"]),
    updateOrderNotes
);

module.exports = router;