const prisma = require("../config/prisma");
const ExcelJS = require("exceljs");
const { Parser } = require("json2csv");

/**
 * Convert a date filter value to a Date.
 *
 * The restaurant frontend sends date-only strings like "2026-08-18". Parsing
 * them with `new Date("2026-08-18")` yields UTC midnight — a one-day shift for
 * IST restaurants (orders created 00:00–05:30 local would be excluded from
 * "today"). Date-only values are therefore interpreted as business-local
 * (Asia/Kolkata) midnight / end-of-day. Full ISO timestamps (with a time or
 * offset) are passed through untouched.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function toDateFilterValue(value, isEndOfDay) {
  if (!value) return null;
  if (DATE_ONLY.test(String(value))) {
    // Parse as Asia/Kolkata local time: the POS business timezone.
    const local = `${value}${isEndOfDay ? "T23:59:59.999" : "T00:00:00.000"}+05:30`;
    const d = new Date(local);
    return Number.isNaN(d.getTime()) ? new Date(value) : d;
  }
  const d = new Date(value);
  if (isEndOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Build a common restaurant-scoped date-filter where clause.
 * Returns an empty object if restaurantId is null (SUPER_ADMIN).
 */
function dateWhere(restaurantId, from, to, dateField = "createdAt") {
  const where = {};
  if (restaurantId) {
    where.restaurantId = restaurantId;
  }
  const gte = toDateFilterValue(from, false);
  const lte = toDateFilterValue(to, true);
  if (gte || lte) {
    const dateFilter = {};
    if (gte) dateFilter.gte = gte;
    if (lte) dateFilter.lte = lte;
    where[dateField] = dateFilter;
  }
  return where;
}

/**
 * Shared aggregation source for ALL sales calculations (KPIs, item-wise,
 * category-wise, exports).
 *
 * A sale is defined by the existing backend billing rule: a Bill that is
 * PAID and NOT cancelled, within the selected date range (by bill.createdAt
 * — i.e. the date the money was actually received).
 *
 * This guarantees that Total Sales, item revenue, category revenue and every
 * quantity always reconcile — the previous implementation mixed PAID bills
 * (getSalesReport) with COMPLETED orders (item/category reports) and filtered
 * the two on different date fields (bill.createdAt vs order.createdAt), which
 * made the reports disagree. Multi-tenant isolation is preserved: the bill
 * query is always scoped by restaurantId.
 */
async function getPaidSalesItems(restaurantId, from, to) {
  const billWhere = dateWhere(restaurantId, from, to, "createdAt");
  billWhere.isCancelled = false;
  billWhere.status = "PAID";

  const bills = await prisma.bill.findMany({
    where: billWhere,
    select: { id: true, orderId: true },
  });

  if (bills.length === 0) {
    return { bills, orderIds: [], orderItems: [] };
  }

  const orderIds = [...new Set(bills.map((b) => b.orderId))];

  const orderItems = await prisma.orderItem.findMany({
    where: { orderId: { in: orderIds } },
    select: {
      quantity: true,
      total: true,
      orderId: true,
      menuItem: {
        select: {
          id: true,
          name: true,
          image: true,
          category: { select: { id: true, name: true } },
        },
      },
    },
  });

  return { bills, orderIds, orderItems };
}

// ── SALES REPORT – KPI cards + bills list ──
const getSalesReport = async (restaurantId, from, to) => {

  const billWhere = dateWhere(restaurantId, from, to, "createdAt");
  billWhere.isCancelled = false;
  billWhere.status = "PAID";

  const paidBills = await prisma.bill.findMany({
    where: billWhere,
    include: {
      order: {
        include: {
          table: true,
          orderItems: {
            select: {
              id: true,
              quantity: true,
              total: true,
              menuItem: {
                select: {
                  id: true,
                  name: true,
                  image: true,
                  category: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      },
      payments: {
        select: {
          paymentMethod: true,
          amount: true,
          status: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Total Sales (sum of grandTotal from PAID bills)
  const totalSales = paidBills.reduce((s, b) => s + Number(b.grandTotal || 0), 0);
  const totalTax = paidBills.reduce((s, b) => s + Number(b.taxAmount || 0), 0);
  const totalDiscount = paidBills.reduce((s, b) => s + Number(b.discount || 0), 0);
  const netSales = totalSales; // grandTotal already accounts for discounts, charges, tax
  const averageBillValue = paidBills.length ? totalSales / paidBills.length : 0;

  // Cancelled Orders count
  const cancelledOrderWhere = dateWhere(restaurantId, from, to, "createdAt");
  cancelledOrderWhere.status = "CANCELLED";
  cancelledOrderWhere.isDeleted = false;
  const cancelledOrders = await prisma.order.count({ where: cancelledOrderWhere });

  // Completed Orders count
  const completedOrderWhere = dateWhere(restaurantId, from, to, "createdAt");
  completedOrderWhere.status = "COMPLETED";
  completedOrderWhere.isDeleted = false;
  const completedOrders = await prisma.order.count({ where: completedOrderWhere });

  // Total Orders (non-cancelled, non-deleted)
  const totalOrderWhere = dateWhere(restaurantId, from, to, "createdAt");
  totalOrderWhere.isDeleted = false;
  totalOrderWhere.status = { notIn: ["CANCELLED"] };
  const totalOrders = await prisma.order.count({ where: totalOrderWhere });

  // Payment Summary from PAID bills' payments
  const paidBillIds = paidBills.map((b) => b.id);
  const payments =
    paidBillIds.length > 0
      ? await prisma.payment.findMany({
          where: {
            billId: { in: paidBillIds },
            status: "PAID",
          },
        })
      : [];

  const paymentSummary = {};
  payments.forEach((p) => {
    const method = p.paymentMethod || "OTHER";
    if (!paymentSummary[method]) paymentSummary[method] = 0;
    paymentSummary[method] += Number(p.amount);
  });

  // Average Order Value (Total Sales / Completed Orders)
  const averageOrderValue = completedOrders > 0 ? totalSales / completedOrders : 0;

  // ── Item / Category Analytics (from the same PAID-bill source as Total Sales) ──
  const itemAgg = {};
  const catAgg = {};
  let totalItemsSold = 0;
  let totalItemRevenue = 0;

  paidBills.forEach((b) => {
    (b.order?.orderItems || []).forEach((oi) => {
      const mi = oi.menuItem;
      if (!mi) return;
      const qty = Number(oi.quantity) || 0;
      const rev = Number(oi.total) || 0;
      totalItemsSold += qty;
      totalItemRevenue += rev;

      if (!itemAgg[mi.id]) {
        itemAgg[mi.id] = { menuItemId: mi.id, itemName: mi.name, image: mi.image || null, quantitySold: 0, revenue: 0 };
      }
      itemAgg[mi.id].quantitySold += qty;
      itemAgg[mi.id].revenue += rev;

      if (mi.category) {
        if (!catAgg[mi.category.id]) {
          catAgg[mi.category.id] = { categoryId: mi.category.id, categoryName: mi.category.name, quantitySold: 0, revenue: 0 };
        }
        catAgg[mi.category.id].quantitySold += qty;
        catAgg[mi.category.id].revenue += rev;
      }
    });
  });

  const itemList = Object.values(itemAgg).sort((a, b) => b.quantitySold - a.quantitySold);
  const catList = Object.values(catAgg).sort((a, b) => b.quantitySold - a.quantitySold);

  const analytics = {
    totalItemsSold,
    totalCategoriesSold: catList.length,
    averageItemSellingPrice: totalItemsSold > 0 ? Math.round((totalItemRevenue / totalItemsSold) * 100) / 100 : 0,
    topSellingItem: itemList[0]
      ? { itemName: itemList[0].itemName, quantitySold: itemList[0].quantitySold, revenue: itemList[0].revenue, image: itemList[0].image }
      : null,
    topSellingCategory: catList[0]
      ? { categoryName: catList[0].categoryName, quantitySold: catList[0].quantitySold, revenue: catList[0].revenue }
      : null,
    topItems: itemList.slice(0, 5),
  };

  return {
    summary: {
      totalBills: paidBills.length,
      totalSales,
      totalTax,
      totalDiscount,
      netSales,
      averageBillValue,
      totalOrders,
      completedOrders,
      cancelledOrders,
      averageOrderValue,
    },
    analytics,
    paymentSummary,
    bills: paidBills,
  };
};

// ── ITEM SALES REPORT ──
// Uses the same PAID-bill source as Total Sales. Supports an optional
// categoryId filter (no-op when omitted).
const getItemSalesReport = async (restaurantId, from, to, categoryId) => {
  const { orderItems } = await getPaidSalesItems(restaurantId, from, to);

  const report = {};
  orderItems.forEach((item) => {
    const mi = item.menuItem;
    if (!mi) return;
    if (categoryId && mi.category && mi.category.id !== categoryId) return;

    const id = mi.id;
    if (!report[id]) {
      report[id] = {
        menuItemId: id,
        itemName: mi.name,
        image: mi.image || null,
        categoryId: mi.category?.id || null,
        category: mi.category?.name || "Uncategorized",
        quantitySold: 0,
        revenue: 0,
        orderIds: new Set(),
      };
    }
    report[id].quantitySold += item.quantity;
    report[id].revenue += Number(item.total);
    report[id].orderIds.add(item.orderId);
  });

  const list = Object.values(report).map((r) => {
    const { orderIds, ...rest } = r;
    return {
      ...rest,
      orderCount: orderIds.size,
      // Average Selling Price = Revenue ÷ Quantity Sold
      averageSellingPrice: r.quantitySold > 0 ? Math.round((r.revenue / r.quantitySold) * 100) / 100 : 0,
    };
  });

  const totalRevenue = list.reduce((s, r) => s + r.revenue, 0);

  return list
    .map((r) => ({
      ...r,
      // Percentage of Total Sales = Item Revenue ÷ All Items Revenue
      percentageOfTotalSales: totalRevenue > 0 ? Math.round((r.revenue / totalRevenue) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.quantitySold - a.quantitySold);
};

// ── CATEGORY SALES REPORT ──
// Uses the same PAID-bill source as Total Sales. Includes a per-category item
// breakdown (items[]) so the UI can expand a category row without extra calls.
const getCategorySalesReport = async (restaurantId, from, to) => {
  const { orderItems } = await getPaidSalesItems(restaurantId, from, to);

  const report = {};
  orderItems.forEach((item) => {
    const mi = item.menuItem;
    if (!mi || !mi.category) return;

    const cat = mi.category;
    if (!report[cat.id]) {
      report[cat.id] = {
        categoryId: cat.id,
        categoryName: cat.name,
        quantitySold: 0,
        revenue: 0,
        orderIds: new Set(),
        items: {},
      };
    }
    report[cat.id].quantitySold += item.quantity;
    report[cat.id].revenue += Number(item.total);
    report[cat.id].orderIds.add(item.orderId);

    if (!report[cat.id].items[mi.id]) {
      report[cat.id].items[mi.id] = {
        menuItemId: mi.id,
        itemName: mi.name,
        image: mi.image || null,
        quantitySold: 0,
        revenue: 0,
      };
    }
    report[cat.id].items[mi.id].quantitySold += item.quantity;
    report[cat.id].items[mi.id].revenue += Number(item.total);
  });

  const reportList = Object.values(report).map((r) => {
    const items = Object.values(r.items)
      .map((it) => ({
        ...it,
        averageSellingPrice: it.quantitySold > 0 ? Math.round((it.revenue / it.quantitySold) * 100) / 100 : 0,
      }))
      .sort((a, b) => b.quantitySold - a.quantitySold);

    return {
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      quantitySold: r.quantitySold,
      revenue: r.revenue,
      orderCount: r.orderIds.size,
      averageItemPrice: r.quantitySold > 0 ? Math.round((r.revenue / r.quantitySold) * 100) / 100 : 0,
      items,
    };
  });

  const totalRevenue = reportList.reduce((s, r) => s + r.revenue, 0);

  return reportList
    .map((r) => ({
      ...r,
      // Percentage of Total Sales = Category Revenue ÷ All Categories Revenue
      percentageOfTotalSales: totalRevenue > 0 ? Math.round((r.revenue / totalRevenue) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
};

// ── PAYMENT REPORT ──
const getPaymentReport = async (

    restaurantId,

    from,

    to

) => {

  const where = dateWhere(restaurantId, from, to, "createdAt");
  where.status = "PAID";

  const payments = await prisma.payment.findMany({
    where,
    include: {
      bill: {
        select: { billNo: true, grandTotal: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const summary = {};
  let totalPayments = 0;
  let totalAmount = 0;
  payments.forEach((p) => {
    const method = p.paymentMethod || "OTHER";
    if (!summary[method]) summary[method] = 0;
    summary[method] += Number(p.amount);
    totalAmount += Number(p.amount);
    totalPayments++;
  });

  return {
    summary: { ...summary, totalPayments, totalAmount },
    payments,
  };
};

// ── ORDER REPORT ──
// Supports optional server-side pagination: pass `page` (1-based) and
// `pageSize`. When omitted, the full list is returned (backwards compatible).
const getOrderReport = async (restaurantId, from, to, statusFilter, page, pageSize) => {
  const where = dateWhere(restaurantId, from, to, "createdAt");
  where.isDeleted = false;
  if (statusFilter) where.status = statusFilter;

  // Paginated count + totals come from the full filtered set (never the page
  // slice) so the summary and KPI cards always reflect the whole range.
  const [totalOrders, amountAgg, statusGroups] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.aggregate({ where, _sum: { totalAmount: true, discount: true } }),
    prisma.order.groupBy({ by: ["status"], where, _count: { _all: true } }),
  ]);

  const statusCount = {};
  statusGroups.forEach((g) => { statusCount[g.status] = g._count._all; });

  const orders = await prisma.order.findMany({
    where,
    include: {
      table: { select: { tableNo: true } },
      customer: { select: { name: true, phone: true } },
      orderItems: {
        select: { quantity: true, total: true, menuItem: { select: { name: true } } },
      },
      bill: {
        select: {
          billNo: true,
          status: true,
          paymentStatus: true,
          grandTotal: true,
          payments: {
            select: { paymentMethod: true, amount: true },
            where: { status: "PAID" },
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    ...(page && pageSize ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
  });

  // Build enriched order list with computed fields
  const enrichedOrders = orders.map((o) => ({
    id: o.id,
    orderNo: o.orderNo,
    orderType: o.orderType,
    status: o.status,
    subtotal: o.subtotal,
    taxAmount: o.taxAmount,
    totalAmount: o.totalAmount,
    discount: o.discount,
    discountType: o.discountType,
    discountValue: o.discountValue,
    serviceCharge: o.serviceCharge,
    roundOff: o.roundOff,
    notes: o.notes,
    cancelReason: o.cancelReason,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    completedAt: o.completedAt,
    cancelledAt: o.cancelledAt,
    table: o.table,
    customer: o.customer,
    itemsCount: o.orderItems ? o.orderItems.length : 0,
    orderItems: o.orderItems,
    bill: o.bill
      ? {
          billNo: o.bill.billNo,
          status: o.bill.status,
          paymentStatus: o.bill.paymentStatus,
          grandTotal: o.bill.grandTotal,
          paymentMethod: o.bill.payments?.length > 1
            ? "MULTIPLE"
            : (o.bill.payments?.[0]?.paymentMethod || null),
          paymentAmount: o.bill.payments?.reduce((s, p) => s + Number(p.amount), 0) || 0,
        }
      : null,
  }));

  const totalAmount = Number(amountAgg?._sum?.totalAmount || 0);
  const totalDiscount = Number(amountAgg?._sum?.discount || 0);
  const completedCount = statusCount.COMPLETED || 0;
  const cancelledCount = statusCount.CANCELLED || 0;
  const pendingCount = statusCount.PENDING || 0;
  const preparingCount = statusCount.PREPARING || 0;
  const readyCount = (statusCount.READY || 0) + (statusCount.SERVED || 0);

  return {
    summary: { totalOrders, totalAmount, totalDiscount, completedCount, cancelledCount, pendingCount, preparingCount, readyCount },
    orders: enrichedOrders,
    ...(page && pageSize
      ? { pagination: { page: Number(page), pageSize: Number(pageSize), total: totalOrders, totalPages: Math.max(1, Math.ceil(totalOrders / pageSize)) } }
      : {}),
  };
};

// ── REVENUE TREND CHART ──
const getRevenueTrend = async (restaurantId, from, to, interval = "daily") => {
  const where = dateWhere(restaurantId, from, to, "createdAt");
  where.isCancelled = false;
  where.status = "PAID";

  const bills = await prisma.bill.findMany({
    where,
    select: { grandTotal: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (bills.length === 0) return [];

  const buckets = {};
  bills.forEach((b) => {
    const d = new Date(b.createdAt);
    let key;
    if (interval === "monthly") {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    } else if (interval === "weekly") {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    if (!buckets[key]) buckets[key] = 0;
    buckets[key] += Number(b.grandTotal || 0);
  });

  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, revenue]) => ({ date, revenue: Math.round(revenue * 100) / 100 }));
};

// ── SALES BILLS (for export) ──
const getSalesBills = async (restaurantId, from, to) => {
  const where = dateWhere(restaurantId, from, to, "createdAt");
  where.isCancelled = false;
  where.status = "PAID";

  return await prisma.bill.findMany({
    where,
    include: { order: { include: { table: true } } },
    orderBy: { createdAt: "desc" },
  });
};

// ── DAILY REPORT ──
const getDailyReport = async (restaurantId, date) => {
  // Date-only strings are business-local (Asia/Kolkata) — same rule as dateWhere.
  const reportDate = date && DATE_ONLY.test(String(date))
    ? toDateFilterValue(date, false)
    : (date ? new Date(date) : new Date());
  const start = new Date(reportDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(reportDate);
  end.setHours(23, 59, 59, 999);

  const buildWhere = () => {
    const w = { createdAt: { gte: start, lte: end } };
    if (restaurantId) w.restaurantId = restaurantId;
    return w;
  };

  const billWhere = { ...buildWhere(), isCancelled: false, status: "PAID" };
  const orderWhere = { ...buildWhere(), isDeleted: false };
  const paymentWhere = { ...buildWhere(), status: "PAID" };

  const [bills, orders, payments] = await Promise.all([
    prisma.bill.findMany({ where: billWhere }),
    prisma.order.findMany({ where: orderWhere }),
    prisma.payment.findMany({ where: paymentWhere }),
  ]);

  let totalSales = 0, totalTax = 0, totalDiscount = 0;
  bills.forEach((b) => {
    totalSales += Number(b.grandTotal || 0);
    totalTax += Number(b.taxAmount || 0);
    totalDiscount += Number(b.discount || 0);
  });

  const paymentSummary = {};
  payments.forEach((p) => {
    const method = p.paymentMethod || "OTHER";
    if (!paymentSummary[method]) paymentSummary[method] = 0;
    paymentSummary[method] += Number(p.amount);
  });

  const orderSummary = { PENDING: 0, PREPARING: 0, READY: 0, SERVED: 0, COMPLETED: 0, CANCELLED: 0, HOLD: 0 };
  orders.forEach((o) => { if (orderSummary[o.status] !== undefined) orderSummary[o.status]++; });

  return {
    summary: {
      date: start,
      totalOrders: orders.length,
      completedOrders: orderSummary.COMPLETED || 0,
      cancelledOrders: orderSummary.CANCELLED || 0,
      totalBills: bills.length,
      totalSales,
      totalTax,
      totalDiscount,
      netSales: totalSales,
      averageBillValue: bills.length > 0 ? totalSales / bills.length : 0,
    },
    payments: paymentSummary,
    orders: orderSummary,
  };
};

// ── EXPORT – EXCEL ──
// extra = { categorySales, itemSales } — renders Category-wise & Item-wise
// sheets so exports include the full category → item analytics.
const exportSalesExcel = async (bills, extra = {}) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Restaurant POS";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Sales Report");

    // Column definitions
    sheet.columns = [
        { header: "Bill No", key: "billNo", width: 18 },
        { header: "Order No", key: "orderNo", width: 20 },
        { header: "Table", key: "table", width: 12 },
        { header: "Subtotal", key: "subtotal", width: 14 },
        { header: "Tax", key: "tax", width: 14 },
        { header: "Grand Total", key: "grandTotal", width: 16 },
        { header: "Status", key: "status", width: 14 },
        { header: "Date", key: "date", width: 14 },
        { header: "Time", key: "time", width: 10 },
    ];

    // Style the header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF333333" }
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    headerRow.height = 22;

    // Add data rows with formatting
    let totalSubtotal = 0;
    let totalTax = 0;
    let totalGrand = 0;

    bills.forEach((bill, idx) => {
        const d = bill.createdAt ? new Date(bill.createdAt) : new Date();
        const dateStr = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
        const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

        const subtotal = Number(bill.subtotal || 0);
        const tax = Number(bill.taxAmount || 0);
        const grandTotal = Number(bill.grandTotal || 0);

        totalSubtotal += subtotal;
        totalTax += tax;
        totalGrand += grandTotal;

        const row = sheet.addRow({
            billNo: String(bill.billNo || ""),
            orderNo: String(bill.order?.orderNo || ""),
            table: bill.order?.table?.tableNo != null ? String(bill.order.table.tableNo) : "-",
            subtotal: subtotal,
            tax: tax,
            grandTotal: grandTotal,
            status: bill.status || "UNPAID",
            date: dateStr,
            time: timeStr,
        });

        // Alternate row colors
        if (idx % 2 === 1) {
            row.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FFF5F5F5" }
            };
        }

        // Currency format for money columns
        const currencyFormat = '\u20B9#,##0.00';
        row.getCell("subtotal").numFmt = currencyFormat;
        row.getCell("tax").numFmt = currencyFormat;
        row.getCell("grandTotal").numFmt = currencyFormat;

        // Center alignment for non-money columns
        row.getCell("table").alignment = { horizontal: "center" };
        row.getCell("status").alignment = { horizontal: "center" };
        row.getCell("date").alignment = { horizontal: "center" };
        row.getCell("time").alignment = { horizontal: "center" };

        row.height = 18;
    });

    // ─── Summary Row ───
    const summaryRow = sheet.addRow({
        billNo: "TOTAL",
        subtotal: totalSubtotal,
        tax: totalTax,
        grandTotal: totalGrand,
    });
    summaryRow.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    summaryRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF16A34A" }
    };
    summaryRow.getCell("subtotal").numFmt = '\u20B9#,##0.00';
    summaryRow.getCell("tax").numFmt = '\u20B9#,##0.00';
    summaryRow.getCell("grandTotal").numFmt = '\u20B9#,##0.00';
    summaryRow.height = 22;

    // Merge summary row cells
    sheet.mergeCells(`A${summaryRow.number}:C${summaryRow.number}`);
    summaryRow.getCell("billNo").alignment = { horizontal: "right", vertical: "middle" };

    // ─── Footer Row ───
    const footerRow = sheet.addRow({
        billNo: `Generated: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    });
    footerRow.font = { name: "Calibri", size: 9, italic: true, color: { argb: "FF999999" } };
    footerRow.height = 18;

    // Auto-filter on header
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: 9 }
    };

    // ─── Category-wise Sales sheet ───
    const categorySales = Array.isArray(extra.categorySales) ? extra.categorySales : [];
    if (categorySales.length > 0) {
        const catSheet = workbook.addWorksheet("Category-wise Sales");
        catSheet.columns = [
            { header: "Category", key: "category", width: 22 },
            { header: "Items Sold", key: "qty", width: 12 },
            { header: "Orders", key: "orders", width: 10 },
            { header: "Revenue", key: "revenue", width: 16 },
            { header: "% of Sales", key: "pct", width: 12 },
            { header: "Avg Item Price", key: "avg", width: 16 },
        ];
        const catHeader = catSheet.getRow(1);
        catHeader.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        catHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF333333" } };
        catHeader.alignment = { vertical: "middle", horizontal: "center" };
        catHeader.height = 22;

        let catTotalQty = 0, catTotalRev = 0, catTotalOrders = 0;
        categorySales.forEach((c, idx) => {
            const qty = Number(c.quantitySold || 0);
            const rev = Number(c.revenue || 0);
            const orders = Number(c.orderCount || 0);
            catTotalQty += qty; catTotalRev += rev; catTotalOrders += orders;
            const row = catSheet.addRow({
                category: String(c.categoryName || ""),
                qty, orders, revenue: rev,
                pct: `${Number(c.percentageOfTotalSales || 0).toFixed(1)}%`,
                avg: qty > 0 ? rev / qty : 0,
            });
            if (idx % 2 === 1) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
            row.getCell("revenue").numFmt = "\\u20B9#,##0.00";
            row.getCell("avg").numFmt = "\\u20B9#,##0.00";
            row.height = 18;
        });
        const catTotal = catSheet.addRow({
            category: "TOTAL", qty: catTotalQty, orders: catTotalOrders,
            revenue: catTotalRev, pct: "100%", avg: catTotalQty > 0 ? catTotalRev / catTotalQty : 0,
        });
        catTotal.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        catTotal.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16A34A" } };
        catTotal.getCell("revenue").numFmt = "\\u20B9#,##0.00";
        catTotal.getCell("avg").numFmt = "\\u20B9#,##0.00";
        catTotal.height = 22;
        catSheet.mergeCells(`A${catTotal.number}:B${catTotal.number}`);
        catTotal.getCell("category").alignment = { horizontal: "right", vertical: "middle" };
        catSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
    }

    // ─── Item-wise Sales sheet ───
    const itemSales = Array.isArray(extra.itemSales) ? extra.itemSales : [];
    if (itemSales.length > 0) {
        const itemSheet = workbook.addWorksheet("Item-wise Sales");
        itemSheet.columns = [
            { header: "Item", key: "item", width: 28 },
            { header: "Category", key: "category", width: 20 },
            { header: "Qty Sold", key: "qty", width: 10 },
            { header: "Orders", key: "orders", width: 10 },
            { header: "Revenue", key: "revenue", width: 16 },
            { header: "Avg Price", key: "avg", width: 14 },
            { header: "% of Sales", key: "pct", width: 12 },
        ];
        const itemHeader = itemSheet.getRow(1);
        itemHeader.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        itemHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF333333" } };
        itemHeader.alignment = { vertical: "middle", horizontal: "center" };
        itemHeader.height = 22;

        let itemTotalQty = 0, itemTotalRev = 0, itemTotalOrders = 0;
        itemSales.forEach((i, idx) => {
            const qty = Number(i.quantitySold || 0);
            const rev = Number(i.revenue || 0);
            const orders = Number(i.orderCount || 0);
            itemTotalQty += qty; itemTotalRev += rev; itemTotalOrders += orders;
            const row = itemSheet.addRow({
                item: String(i.itemName || ""),
                category: String(i.category || ""),
                qty, orders, revenue: rev,
                avg: qty > 0 ? rev / qty : 0,
                pct: `${Number(i.percentageOfTotalSales || 0).toFixed(1)}%`,
            });
            if (idx % 2 === 1) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
            row.getCell("revenue").numFmt = "\\u20B9#,##0.00";
            row.getCell("avg").numFmt = "\\u20B9#,##0.00";
            row.height = 18;
        });
        const itemTotal = itemSheet.addRow({
            item: "TOTAL", category: "", qty: itemTotalQty, orders: itemTotalOrders,
            revenue: itemTotalRev, avg: itemTotalQty > 0 ? itemTotalRev / itemTotalQty : 0, pct: "100%",
        });
        itemTotal.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        itemTotal.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16A34A" } };
        itemTotal.getCell("revenue").numFmt = "\\u20B9#,##0.00";
        itemTotal.getCell("avg").numFmt = "\\u20B9#,##0.00";
        itemTotal.height = 22;
        itemSheet.mergeCells(`A${itemTotal.number}:B${itemTotal.number}`);
        itemTotal.getCell("item").alignment = { horizontal: "right", vertical: "middle" };
        itemSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 7 } };
    }

    return workbook;
};



const PDFDocument = require("pdfkit");

/**
 * @deprecated Use exportSalesPDF from report-pdf.service.js instead.
 * This simplified version is preserved for backward compatibility only;
 * the controller routes to the report-pdf.service.js version.
 */
const exportSalesPDFLegacy = (bills, res) => {
    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);
    doc.fontSize(22).text("Sales Report");
    doc.moveDown();
    bills.forEach(bill => {
        doc.fontSize(12);
        doc.text(`Bill No : ${bill.billNo}`);
        doc.text(`Order No : ${bill.order.orderNo}`);
        doc.text(`Table : ${bill.order.table?.tableNo || "-"}`);
        doc.text(`Subtotal : \u20B9${bill.subtotal}`);
        doc.text(`Tax : \u20B9${bill.taxAmount}`);
        doc.text(`Grand Total : \u20B9${bill.grandTotal}`);
        doc.text(`Status : ${bill.status}`);
        doc.moveDown();
    });
    doc.end();
};

// ── EXPORT – CSV ──
// extra = { categorySales, itemSales } — appends category & item sections.
const exportSalesCSV = (bills, extra = {}) => {
  const rows = bills.map((bill) => {
    const d = bill.createdAt ? new Date(bill.createdAt) : new Date();
    const dateStr = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return {
      "Bill No": String(bill.billNo || ""),
      "Order No": String(bill.order?.orderNo || ""),
      Table: bill.order?.table?.tableNo != null ? String(bill.order.table.tableNo) : "-",
      Subtotal: Number(bill.subtotal || 0),
      Tax: Number(bill.taxAmount || 0),
      "Grand Total": Number(bill.grandTotal || 0),
      Status: bill.status || "UNPAID",
      Date: dateStr,
      Time: timeStr,
    };
  });

  const totalSubtotal = rows.reduce((s, r) => s + r.Subtotal, 0);
  const totalTax = rows.reduce((s, r) => s + r.Tax, 0);
  const totalGrand = rows.reduce((s, r) => s + r["Grand Total"], 0);
  rows.push({
    "Bill No": "TOTAL", "Order No": "", Table: "",
    Subtotal: totalSubtotal, Tax: totalTax, "Grand Total": totalGrand,
    Status: "", Date: "", Time: "",
  });

  const fields = ["Bill No", "Order No", "Table", "Subtotal", "Tax", "Grand Total", "Status", "Date", "Time"];
  const parser = new Parser({ fields });
  const lines = [parser.parse(rows)];

  const categorySales = Array.isArray(extra.categorySales) ? extra.categorySales : [];
  const itemSales = Array.isArray(extra.itemSales) ? extra.itemSales : [];

  if (categorySales.length > 0) {
    const catRows = categorySales.map((c) => ({
      Category: String(c.categoryName || ""),
      "Items Sold": Number(c.quantitySold || 0),
      Orders: Number(c.orderCount || 0),
      Revenue: Number(c.revenue || 0),
      "% of Sales": `${Number(c.percentageOfTotalSales || 0).toFixed(1)}%`,
      "Avg Item Price": Number(c.quantitySold) > 0 ? Math.round((Number(c.revenue) / Number(c.quantitySold)) * 100) / 100 : 0,
    }));
    const catTotal = {
      Category: "TOTAL",
      "Items Sold": catRows.reduce((s, r) => s + r["Items Sold"], 0),
      Orders: catRows.reduce((s, r) => s + r.Orders, 0),
      Revenue: catRows.reduce((s, r) => s + r.Revenue, 0),
      "% of Sales": "100%",
      "Avg Item Price": catRows.reduce((s, r) => s + r["Items Sold"], 0) > 0
        ? Math.round((catRows.reduce((s, r) => s + r.Revenue, 0) / catRows.reduce((s, r) => s + r["Items Sold"], 0)) * 100) / 100
        : 0,
    };
    catRows.push(catTotal);
    lines.push("");
    lines.push("CATEGORY-WISE SALES");
    lines.push(new Parser({ fields: ["Category", "Items Sold", "Orders", "Revenue", "% of Sales", "Avg Item Price"] }).parse(catRows));
  }

  if (itemSales.length > 0) {
    const itemRows = itemSales.map((i) => ({
      Item: String(i.itemName || ""),
      Category: String(i.category || ""),
      "Qty Sold": Number(i.quantitySold || 0),
      Orders: Number(i.orderCount || 0),
      Revenue: Number(i.revenue || 0),
      "Avg Price": Number(i.averageSellingPrice || 0),
      "% of Sales": `${Number(i.percentageOfTotalSales || 0).toFixed(1)}%`,
    }));
    const itemTotal = {
      Item: "TOTAL",
      Category: "",
      "Qty Sold": itemRows.reduce((s, r) => s + r["Qty Sold"], 0),
      Orders: itemRows.reduce((s, r) => s + r.Orders, 0),
      Revenue: itemRows.reduce((s, r) => s + r.Revenue, 0),
      "Avg Price": itemRows.reduce((s, r) => s + r["Qty Sold"], 0) > 0
        ? Math.round((itemRows.reduce((s, r) => s + r.Revenue, 0) / itemRows.reduce((s, r) => s + r["Qty Sold"], 0)) * 100) / 100
        : 0,
      "% of Sales": "100%",
    };
    itemRows.push(itemTotal);
    lines.push("");
    lines.push("ITEM-WISE SALES");
    lines.push(new Parser({ fields: ["Item", "Category", "Qty Sold", "Orders", "Revenue", "Avg Price", "% of Sales"] }).parse(itemRows));
  }

  return lines.join("\n");
};

// ── ORDER REPORT EXPORT: EXCEL ──
const exportOrderExcel = async (orders) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Restaurant POS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Order Report");

  sheet.columns = [
    { header: "Order No", key: "orderNo", width: 20 },
    { header: "Date", key: "date", width: 14 },
    { header: "Type", key: "type", width: 14 },
    { header: "Table", key: "table", width: 10 },
    { header: "Customer", key: "customer", width: 20 },
    { header: "Items", key: "items", width: 8 },
    { header: "Subtotal", key: "subtotal", width: 14 },
    { header: "Discount", key: "discount", width: 14 },
    { header: "Tax", key: "tax", width: 14 },
    { header: "Total", key: "total", width: 16 },
    { header: "Status", key: "status", width: 14 },
    { header: "Payment", key: "payment", width: 12 },
    { header: "Bill No", key: "billNo", width: 18 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF333333" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
  headerRow.height = 22;

  let totalSub = 0, totalDisc = 0, totalTax = 0, totalAmt = 0;
  const currencyFormat = "\u20B9#,##0.00";

  orders.forEach((o, idx) => {
    const d = new Date(o.createdAt);
    const dateStr = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    const subtotal = Number(o.subtotal || 0);
    const disc = Number(o.discount || 0);
    const tax = Number(o.taxAmount || 0);
    const total = Number(o.totalAmount || 0);
    totalSub += subtotal; totalDisc += disc; totalTax += tax; totalAmt += total;

    const row = sheet.addRow({
      orderNo: String(o.orderNo || ""),
      date: dateStr,
      type: o.orderType || "-",
      table: o.table?.tableNo || "-",
      customer: o.customer?.name || "Walk-in",
      items: o.itemsCount || 0,
      subtotal, discount: disc, tax, total,
      status: o.status || "PENDING",
      payment: o.bill?.paymentMethod || "-",
      billNo: o.bill?.billNo || "-",
    });

    if (idx % 2 === 1) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
    ["subtotal", "discount", "tax", "total"].forEach((k) => {
      row.getCell(k).numFmt = currencyFormat;
    });
    row.height = 18;
  });

  const summaryRow = sheet.addRow({
    orderNo: "TOTAL", items: "", subtotal: totalSub, discount: totalDisc,
    tax: totalTax, total: totalAmt,
  });
  summaryRow.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  summaryRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16A34A" } };
  ["subtotal", "discount", "tax", "total"].forEach((k) => {
    summaryRow.getCell(k).numFmt = currencyFormat;
  });
  summaryRow.height = 22;
  sheet.mergeCells(`A${summaryRow.number}:C${summaryRow.number}`);
  summaryRow.getCell("orderNo").alignment = { horizontal: "right", vertical: "middle" };

  sheet.addRow({ orderNo: `Generated: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 13 } };

  return workbook;
};

// ── ORDER REPORT EXPORT: CSV ──
const exportOrderCSV = (orders) => {
  const rows = orders.map((o) => ({
    "Order No": String(o.orderNo || ""),
    Date: new Date(o.createdAt).toLocaleDateString("en-IN"),
    Type: o.orderType || "",
    Table: o.table?.tableNo || "",
    Customer: o.customer?.name || "Walk-in",
    Items: o.itemsCount || 0,
    Subtotal: Number(o.subtotal || 0),
    Discount: Number(o.discount || 0),
    Tax: Number(o.taxAmount || 0),
    Total: Number(o.totalAmount || 0),
    Status: o.status || "",
    Payment: o.bill?.paymentMethod || "",
    "Bill No": o.bill?.billNo || "",
  }));

  const totalSub = rows.reduce((s, r) => s + r.Subtotal, 0);
  const totalDisc = rows.reduce((s, r) => s + r.Discount, 0);
  const totalTax = rows.reduce((s, r) => s + r.Tax, 0);
  const totalAmt = rows.reduce((s, r) => s + r.Total, 0);
  rows.push({
    "Order No": "TOTAL", Date: "", Type: "", Table: "", Customer: "", Items: "",
    Subtotal: totalSub, Discount: totalDisc, Tax: totalTax, Total: totalAmt,
    Status: "", Payment: "", "Bill No": "",
  });

  const fields = ["Order No", "Date", "Type", "Table", "Customer", "Items", "Subtotal", "Discount", "Tax", "Total", "Status", "Payment", "Bill No"];
  return new Parser({ fields }).parse(rows);
};

module.exports = {
  getSalesReport,
  getItemSalesReport,
  getCategorySalesReport,
  getPaymentReport,
  getOrderReport,
  getRevenueTrend,
  getSalesBills,
  exportSalesPDF: exportSalesPDFLegacy,
  exportSalesExcel,
  exportSalesCSV,
  exportOrderExcel,
  exportOrderCSV,
  getDailyReport,
};