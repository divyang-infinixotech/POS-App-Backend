const PDFDocument = require("pdfkit");

/**
 * Generate a branded 80mm thermal receipt PDF with restaurant details and professional formatting
 */
const generateReceipt = async (bill, res) => {
  const doc = new PDFDocument({
    size: [226, 1000], // 80mm receipt
    margin: 8,
    bufferPages: true
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=Receipt_${bill.billNo || "bill"}.pdf`);

  doc.pipe(res);

  const pageWidth = 226;
  const leftMargin = 8;
  const rightMargin = 8;
  const contentWidth = pageWidth - leftMargin - rightMargin;
  let y = 15;

  // Helper: draw separator line
  const hr = (yp) => {
    doc.moveTo(leftMargin, yp)
       .lineTo(pageWidth - rightMargin, yp)
       .strokeColor("#333333")
       .lineWidth(0.5)
       .stroke();
  };

  // Helper: center text
  const centerText = (text, size = 10, bold = false) => {
    doc.fontSize(size).font(bold ? "Helvetica-Bold" : "Helvetica");
    const tw = doc.widthOfString(text);
    doc.text(text, leftMargin + (contentWidth - tw) / 2, y, { lineBreak: false });
  };

  // ─── Header: Restaurant Info ───
  if (bill.logo || bill.restaurant?.logo) {
    try {
      doc.image(bill.logo || bill.restaurant.logo, leftMargin + 10, y, {
        fit: [60, 40], align: "center", valign: "center"
      });
      y += 45;
    } catch (e) { /* skip logo */ }
  }

  centerText(bill.restaurantName || "Restaurant", 14, true);
  y += 16;

  if (bill.address) {
    centerText(bill.address, 7);
    y += 10;
  }

  const contactParts = [];
  if (bill.phone) contactParts.push(bill.phone);
  if (bill.email) contactParts.push(bill.email);
  if (contactParts.length > 0) {
    centerText(contactParts.join(" | "), 7);
    y += 10;
  }

  const regParts = [];
  if (bill.gstNumber) regParts.push(`GST: ${bill.gstNumber}`);
  if (bill.fssaiNumber) regParts.push(`FSSAI: ${bill.fssaiNumber}`);
  if (regParts.length > 0) {
    centerText(regParts.join(" | "), 6.5);
    y += 10;
  }

  // ─── Separator ───
  y += 3;
  hr(y);
  y += 6;

  centerText("TAX INVOICE / BILL", 10, true);
  y += 12;

  // ─── Bill Info ───
  doc.fontSize(7.5).font("Helvetica");
  const infoLines = [
    `Bill No: ${bill.billNo || "N/A"}`,
    `Date: ${new Date(bill.createdAt || new Date()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    `Order No: ${bill.order?.orderNo || bill.orderNo || "N/A"}`,
    `Table: ${bill.order?.table?.tableNo || bill.tableName || "N/A"}`
  ];
  infoLines.forEach(line => {
    doc.text(line, leftMargin, y);
    y += 9;
  });

  // ─── Separator ───
  hr(y);
  y += 5;

  // ─── Items Table Header ───
  doc.fontSize(7.5).font("Helvetica-Bold");
  const qtyX = leftMargin + contentWidth - 65;
  const amtX = leftMargin + contentWidth - 25;
  doc.text("ITEM", leftMargin, y);
  doc.text("QTY", qtyX, y);
  doc.text("AMT", amtX, y);
  y += 9;
  hr(y - 2);
  y += 3;

  // ─── Items ───
  doc.fontSize(7).font("Helvetica");
  const items = bill.order?.orderItems || [];
  items.forEach((item, idx) => {
    const itemName = item.menuItem?.name || item.name || "Item";
    const qty = item.quantity;
    const total = Number(item.total || (item.price * item.quantity)) || 0;

    // Page break
    if (y > 700) {
      doc.addPage();
      y = 30;
      doc.fontSize(7.5).font("Helvetica-Bold");
      doc.text("ITEM", leftMargin, y);
      doc.text("QTY", qtyX, y);
      doc.text("AMT", amtX, y);
      y += 9;
      hr(y - 2);
      y += 3;
      doc.fontSize(7).font("Helvetica");
    }

    doc.text(itemName, leftMargin, y, { width: qtyX - leftMargin - 2 });
    doc.text(String(qty), qtyX, y);
    doc.text(`\u20B9${total.toFixed(2)}`, amtX, y);
    y += 12;

    if (item.notes) {
      doc.fontSize(6).font("Helvetica-Oblique");
      doc.text(`  Note: ${item.notes}`, leftMargin, y);
      y += 8;
      doc.fontSize(7).font("Helvetica");
    }
  });

  // ─── Totals ───
  y += 3;
  hr(y);
  y += 5;

  doc.fontSize(8).font("Helvetica");

  const addLine = (label, value, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica");
    doc.text(label, leftMargin, y);
    doc.text(`\u20B9${Number(value).toFixed(2)}`, amtX - 10, y, { width: 50, align: "right" });
    y += 11;
  };

  addLine("Subtotal:", bill.subtotal || 0);
  if (Number(bill.discount || 0) > 0) {
    let discountLabel = "Discount:";
    if (bill.discountType === "PERCENTAGE") {
      discountLabel = `Discount (${Number(bill.discountValue || 0)}%):`;
    } else if (bill.discountType === "FLAT" && Number(bill.discountValue || 0) > 0) {
      discountLabel = `Discount (\u20B9${Number(bill.discountValue).toFixed(0)}):`;
    }
    addLine(discountLabel, -Number(bill.discount));
  }
  if (Number(bill.serviceCharge || 0) > 0) addLine("Service Charge:", bill.serviceCharge);
  if (Number(bill.taxAmount || 0) > 0) addLine("Tax:", bill.taxAmount);
  if (Number(bill.roundOff || 0) !== 0) addLine("Round Off:", bill.roundOff);

  hr(y - 2);
  y += 3;
  addLine("GRAND TOTAL:", bill.grandTotal || 0, true);

  // Payment info
  if (bill.payments && bill.payments.length > 0) {
    y += 2;
    doc.fontSize(7).font("Helvetica-Bold");
    doc.text("Payment(s):", leftMargin, y);
    y += 8;
    doc.fontSize(7).font("Helvetica");
    bill.payments.forEach(p => {
      doc.text(`  ${p.paymentMethod || "CASH"}: \u20B9${Number(p.amount).toFixed(2)}`, leftMargin, y);
      y += 8;
    });
  }

  // ─── Footer ───
  y += 6;
  hr(y);
  y += 8;

  const footerMsg = bill.receiptFooter || bill.restaurant?.receiptFooter || "Thank You! Visit Again.";
  centerText(footerMsg, 8, true);
  y += 14;

  centerText("Generated by Restaurant POS", 6);
  y += 7;
  centerText(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), 6);

  // Page numbers
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.fontSize(6).font("Helvetica");
    const tp = doc.page.height - 20;
    centerText(`Page ${i + 1} of ${totalPages}`, 6);
  }

  doc.end();
};

module.exports = { generateReceipt };