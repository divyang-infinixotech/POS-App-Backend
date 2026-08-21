const PDFDocument = require("pdfkit");

const exportSalesPDF = (bills, res, restaurantName = "Restaurant", extra = {}) => {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    bufferPages: true
  });

  doc.pipe(res);

  const pageWidth = 595.28;
  const leftMargin = 40;
  const rightMargin = 40;
  const contentWidth = pageWidth - leftMargin - rightMargin;
  let y = 40;

  // Helpers
  const centerText = (text, size = 10, bold = false, color = "#333333") => {
    doc.fontSize(size)
       .font(bold ? "Helvetica-Bold" : "Helvetica")
       .fillColor(color);
    const tw = doc.widthOfString(text);
    doc.text(text, leftMargin + (contentWidth - tw) / 2, y, { lineBreak: false });
  };

  const hr = (yp, color = "#CCCCCC") => {
    doc.moveTo(leftMargin, yp)
       .lineTo(pageWidth - rightMargin, yp)
       .strokeColor(color).lineWidth(0.5).stroke();
  };

  // ─── HEADER ───
  centerText(restaurantName, 18, true, "#1a1a1a");
  y += 24;
  centerText("Sales Report", 14, false, "#555555");
  y += 8;
  centerText(`Generated: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, 8, false, "#999999");
  y += 16;
  hr(y);
  y += 12;

  // ─── SUMMARY SECTION ───
  let totalSales = 0;
  let totalTax = 0;
  let totalDiscount = 0;
  let totalOrders = bills.length;

  bills.forEach(b => {
    totalSales += Number(b.grandTotal || 0);
    totalTax += Number(b.taxAmount || 0);
    totalDiscount += Number(b.discount || 0);
  });

  doc.fontSize(10).font("Helvetica-Bold").fillColor("#333333");
  doc.text("Summary", leftMargin, y);
  y += 16;

  doc.fontSize(8.5).font("Helvetica").fillColor("#555555");
  const summaryItems = [
    { label: "Total Bills", value: String(totalOrders) },
    { label: "Total Sales", value: `\u20B9${totalSales.toFixed(2)}` },
    { label: "Total Tax", value: `\u20B9${totalTax.toFixed(2)}` },
    { label: "Total Discount", value: `\u20B9${totalDiscount.toFixed(2)}` },
    { label: "Net Sales", value: `\u20B9${(totalSales - totalDiscount).toFixed(2)}` }
  ];

  // Two-column summary layout
  const colWidth = contentWidth / 3;
  summaryItems.forEach((item, idx) => {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const xp = leftMargin + col * colWidth;
    const yp = y + row * 20;
    doc.text(item.label, xp, yp);
    doc.font("Helvetica-Bold").fillColor("#333333");
    doc.text(item.value, xp, yp + 10);
    doc.font("Helvetica").fillColor("#555555");
  });

  y += 50;
  hr(y);
  y += 12;

  // ─── TABLE ───
  // Column positions
  const cols = {
    billNo: leftMargin,
    orderNo: leftMargin + 100,
    table: leftMargin + 190,
    subtotal: leftMargin + 250,
    tax: leftMargin + 310,
    total: leftMargin + 370,
    status: leftMargin + 440
  };

  // Table header
  doc.fontSize(8).font("Helvetica-Bold").fillColor("#FFFFFF");
  doc.rect(leftMargin, y - 4, contentWidth, 18).fillColor("#333333").fill();
  doc.fillColor("#FFFFFF");
  const hY = y;
  doc.text("Bill No", cols.billNo + 3, hY + 1);
  doc.text("Order No", cols.orderNo + 3, hY + 1);
  doc.text("Table", cols.table + 3, hY + 1);
  doc.text("Subtotal", cols.subtotal + 3, hY + 1, { width: 60, align: "right" });
  doc.text("Tax", cols.tax + 3, hY + 1, { width: 60, align: "right" });
  doc.text("Total", cols.total + 3, hY + 1, { width: 70, align: "right" });
  doc.text("Status", cols.status + 3, hY + 1);
  y += 20;

  // Table rows
  bills.forEach((bill, idx) => {
    // Page break
    if (y > 740) {
      doc.addPage();
      y = 40;
      doc.fontSize(8).font("Helvetica-Bold").fillColor("#FFFFFF");
      doc.rect(leftMargin, y - 4, contentWidth, 18).fillColor("#333333").fill();
      doc.fillColor("#FFFFFF");
      doc.text("Bill No", cols.billNo + 3, y + 1);
      doc.text("Order No", cols.orderNo + 3, y + 1);
      doc.text("Table", cols.table + 3, y + 1);
      doc.text("Subtotal", cols.subtotal + 3, y + 1, { width: 60, align: "right" });
      doc.text("Tax", cols.tax + 3, y + 1, { width: 60, align: "right" });
      doc.text("Total", cols.total + 3, y + 1, { width: 70, align: "right" });
      doc.text("Status", cols.status + 3, y + 1);
      y += 20;
    }

    // Alternate row bg
    if (idx % 2 === 1) {
      doc.rect(leftMargin, y - 2, contentWidth, 16).fillColor("#f5f5f5").fill();
    }

    doc.fillColor("#333333");
    doc.fontSize(7.5).font("Helvetica");
    doc.text(String(bill.billNo || ""), cols.billNo + 3, y, { width: 95 });
    doc.text(String(bill.order?.orderNo || ""), cols.orderNo + 3, y, { width: 85 });
    doc.text(String(bill.order?.table?.tableNo || bill.tableNo || "-"), cols.table + 3, y, { width: 55 });
    doc.text(`₹${Number(bill.subtotal || 0).toFixed(2)}`, cols.subtotal + 3, y, { width: 60, align: "right" });
    doc.text(`₹${Number(bill.taxAmount || 0).toFixed(2)}`, cols.tax + 3, y, { width: 60, align: "right" });
    doc.text(`₹${Number(bill.grandTotal || 0).toFixed(2)}`, cols.total + 3, y, { width: 70, align: "right" });

    const statusColor = bill.status === "PAID" ? "#16A34A" : bill.status === "CANCELLED" ? "#DC2626" : "#CA8A04";
    doc.fillColor(statusColor).font("Helvetica-Bold");
    doc.text(String(bill.status || "UNPAID"), cols.status + 3, y, { width: 60 });
    doc.fillColor("#333333").font("Helvetica");

    y += 18;
  });

  // ─── CATEGORY-WISE SALES SECTION ───
  const categorySales = Array.isArray(extra.categorySales) ? extra.categorySales : [];
  if (categorySales.length > 0) {
    y += 16;
    hr(y);
    y += 10;
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#333333");
    doc.text("Category-wise Sales", leftMargin, y);
    y += 16;

    const catCols = {
      name: leftMargin,
      qty: leftMargin + 230,
      orders: leftMargin + 300,
      revenue: leftMargin + 360,
      pct: leftMargin + 445
    };

    doc.fontSize(8).font("Helvetica-Bold").fillColor("#FFFFFF");
    doc.rect(leftMargin, y - 4, contentWidth, 18).fillColor("#333333").fill();
    doc.fillColor("#FFFFFF");
    doc.text("Category", catCols.name + 3, y + 1);
    doc.text("Items Sold", catCols.qty + 3, y + 1, { width: 60, align: "right" });
    doc.text("Orders", catCols.orders + 3, y + 1, { width: 50, align: "right" });
    doc.text("Revenue", catCols.revenue + 3, y + 1, { width: 75, align: "right" });
    doc.text("% of Sales", catCols.pct + 3, y + 1, { width: 50, align: "right" });
    y += 20;

    categorySales.forEach((c, idx) => {
      if (y > 740) {
        doc.addPage();
        y = 40;
        doc.fontSize(8).font("Helvetica-Bold").fillColor("#FFFFFF");
        doc.rect(leftMargin, y - 4, contentWidth, 18).fillColor("#333333").fill();
        doc.fillColor("#FFFFFF");
        doc.text("Category", catCols.name + 3, y + 1);
        doc.text("Items Sold", catCols.qty + 3, y + 1, { width: 60, align: "right" });
        doc.text("Orders", catCols.orders + 3, y + 1, { width: 50, align: "right" });
        doc.text("Revenue", catCols.revenue + 3, y + 1, { width: 75, align: "right" });
        doc.text("% of Sales", catCols.pct + 3, y + 1, { width: 50, align: "right" });
        y += 20;
      }
      if (idx % 2 === 1) {
        doc.rect(leftMargin, y - 2, contentWidth, 16).fillColor("#f5f5f5").fill();
      }
      doc.fillColor("#333333").fontSize(7.5).font("Helvetica");
      doc.text(String(c.categoryName || ""), catCols.name + 3, y, { width: 220 });
      doc.text(String(Number(c.quantitySold || 0)), catCols.qty + 3, y, { width: 60, align: "right" });
      doc.text(String(Number(c.orderCount || 0)), catCols.orders + 3, y, { width: 50, align: "right" });
      doc.text(`₹${Number(c.revenue || 0).toFixed(2)}`, catCols.revenue + 3, y, { width: 75, align: "right" });
      doc.text(`${Number(c.percentageOfTotalSales || 0).toFixed(1)}%`, catCols.pct + 3, y, { width: 50, align: "right" });
      y += 18;
    });
  }

  // ─── ITEM-WISE SALES SECTION ───
  const itemSales = Array.isArray(extra.itemSales) ? extra.itemSales : [];
  if (itemSales.length > 0) {
    y += 16;
    hr(y);
    y += 10;
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#333333");
    doc.text("Item-wise Sales", leftMargin, y);
    y += 16;

    const itemCols = {
      name: leftMargin,
      category: leftMargin + 190,
      qty: leftMargin + 300,
      orders: leftMargin + 360,
      revenue: leftMargin + 420
    };

    doc.fontSize(8).font("Helvetica-Bold").fillColor("#FFFFFF");
    doc.rect(leftMargin, y - 4, contentWidth, 18).fillColor("#333333").fill();
    doc.fillColor("#FFFFFF");
    doc.text("Item", itemCols.name + 3, y + 1);
    doc.text("Category", itemCols.category + 3, y + 1);
    doc.text("Qty", itemCols.qty + 3, y + 1, { width: 50, align: "right" });
    doc.text("Orders", itemCols.orders + 3, y + 1, { width: 50, align: "right" });
    doc.text("Revenue", itemCols.revenue + 3, y + 1, { width: 75, align: "right" });
    y += 20;

    itemSales.forEach((i, idx) => {
      if (y > 740) {
        doc.addPage();
        y = 40;
        doc.fontSize(8).font("Helvetica-Bold").fillColor("#FFFFFF");
        doc.rect(leftMargin, y - 4, contentWidth, 18).fillColor("#333333").fill();
        doc.fillColor("#FFFFFF");
        doc.text("Item", itemCols.name + 3, y + 1);
        doc.text("Category", itemCols.category + 3, y + 1);
        doc.text("Qty", itemCols.qty + 3, y + 1, { width: 50, align: "right" });
        doc.text("Orders", itemCols.orders + 3, y + 1, { width: 50, align: "right" });
        doc.text("Revenue", itemCols.revenue + 3, y + 1, { width: 75, align: "right" });
        y += 20;
      }
      if (idx % 2 === 1) {
        doc.rect(leftMargin, y - 2, contentWidth, 16).fillColor("#f5f5f5").fill();
      }
      doc.fillColor("#333333").fontSize(7.5).font("Helvetica");
      doc.text(String(i.itemName || ""), itemCols.name + 3, y, { width: 180 });
      doc.text(String(i.category || ""), itemCols.category + 3, y, { width: 100 });
      doc.text(String(Number(i.quantitySold || 0)), itemCols.qty + 3, y, { width: 50, align: "right" });
      doc.text(String(Number(i.orderCount || 0)), itemCols.orders + 3, y, { width: 50, align: "right" });
      doc.text(`₹${Number(i.revenue || 0).toFixed(2)}`, itemCols.revenue + 3, y, { width: 75, align: "right" });
      y += 18;
    });
  }

  // ─── FOOTER ───
  y += 10;
  hr(y);
  y += 10;

  doc.fontSize(8).font("Helvetica").fillColor("#999999");
  centerText(`Generated by Restaurant POS | ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, 7, false, "#999999");
  y += 12;

  // Page numbers
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).font("Helvetica").fillColor("#999999");
    doc.text(`Page ${i + 1} of ${totalPages}`, leftMargin, doc.page.height - 25, {
      align: "center", width: contentWidth
    });
  }

  doc.end();
};

module.exports = {
  exportSalesPDF
};
