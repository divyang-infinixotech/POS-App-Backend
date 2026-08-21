/**
 * Super Admin gateway administration helpers: platform payment metrics and a
 * filtered payment-history listing. All values are computed from PostgreSQL —
 * no invented numbers. Secrets are never returned by these functions.
 */
const prisma = require("../config/prisma");
const {
  getGatewayStatus,
  getGatewayConfig,
  saveGatewayConfig,
  setGatewayEnabled,
} = require("./gateway-config.service");

/** Platform metrics for the SA subscription/payment dashboard. */
async function getPaymentMetrics() {
  const now = new Date();
  // Expiring = expiry within the next 7 days AND still active. Expired and
  // cancelled subscriptions are deliberately NOT counted as expiring.
  const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Active = stored ACTIVE AND not yet past its expiry (logical expiry).
  // Rows whose date has passed but the cron has not persisted yet must not
  // count as active — same semantics as the lifecycle model everywhere else.
  const [activeSubscriptions, expiringSubscriptions, monthlyRevenueAgg, yearlyRevenueAgg, paymentStats, planRevenueAgg] = await Promise.all([
    prisma.subscription.count({ where: { status: "ACTIVE", expiryDate: { gte: now } } }),
    prisma.subscription.count({ where: { status: "ACTIVE", expiryDate: { gt: now, lte: sevenDays } } }),
    prisma.subscriptionPayment.aggregate({
      _sum: { amount: true },
      where: { status: "PAID", billingCycle: "MONTHLY" },
    }),
    prisma.subscriptionPayment.aggregate({
      _sum: { amount: true },
      where: { status: "PAID", billingCycle: "YEARLY" },
    }),
    prisma.subscriptionPayment.groupBy({
      by: ["status"],
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.subscriptionPayment.groupBy({
      by: ["planName"],
      _sum: { amount: true },
      _count: { _all: true },
      where: { status: "PAID" },
      orderBy: { _sum: { amount: "desc" } },
      take: 5,
    }),
  ]);

  return {
    activeSubscriptions,
    expiringSubscriptions,
    monthlyRevenue: monthlyRevenueAgg._sum.amount || 0,
    yearlyRevenue: yearlyRevenueAgg._sum.amount || 0,
    paymentStats: paymentStats.map((s) => ({
      status: s.status,
      count: s._count._all,
      amount: s._sum.amount || 0,
    })),
    planRevenue: planRevenueAgg.map((p) => ({
      plan: p.planName,
      amount: p._sum.amount || 0,
      count: p._count._all,
    })),
  };
}

/**
 * Filtered platform payment history.
 * Query params: search, restaurantId, plan, status, action, method, from, to,
 * page, limit.
 */
async function listAllPayments(query = {}) {
  const where = {};

  if (query.restaurantId) where.restaurantId = Number(query.restaurantId);
  if (query.plan) where.planName = query.plan;
  if (query.status) where.status = query.status;
  if (query.action) where.action = query.action;
  if (query.method) where.paymentMethod = query.method;
  // Billing-cycle filter — the SA payments UI sends `cycle=MONTHLY|YEARLY`.
  if (query.billingCycle || query.cycle) {
    const c = String(query.billingCycle || query.cycle).toUpperCase();
    where.billingCycle = c === "YEARLY" ? "YEARLY" : "MONTHLY";
  }

  if (query.search) {
    where.OR = [
      { planName: { contains: query.search, mode: "insensitive" } },
      { planCode: { contains: query.search, mode: "insensitive" } },
      { razorpayPaymentId: { contains: query.search, mode: "insensitive" } },
      { razorpayOrderId: { contains: query.search, mode: "insensitive" } },
      { restaurant: { name: { contains: query.search, mode: "insensitive" } } },
    ];
  }

  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = new Date(query.from);
    if (query.to) where.createdAt.lte = new Date(query.to);
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    prisma.subscriptionPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: { restaurant: { select: { id: true, name: true } } },
    }),
    prisma.subscriptionPayment.count({ where }),
  ]);

  return {
    payments: rows.map((p) => ({
      id: p.id,
      restaurantId: p.restaurantId,
      restaurantName: p.restaurant?.name,
      planCode: p.planCode,
      planName: p.planName,
      action: p.action,
      billingCycle: p.billingCycle,
      amount: p.amount,
      status: p.status,
      paymentMethod: p.paymentMethod,
      razorpayOrderId: p.razorpayOrderId,
      razorpayPaymentId: p.razorpayPaymentId,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      errorMessage: p.errorMessage,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

module.exports = {
  getGatewayStatus,
  getGatewayConfig,
  saveGatewayConfig,
  setGatewayEnabled,
  getPaymentMetrics,
  listAllPayments,
};
