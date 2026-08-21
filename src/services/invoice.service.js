const PDFDocument = require("pdfkit");

/**
 * Generate a branded A4 invoice PDF with restaurant details and professional formatting
 */
const generateInvoice = async (bill, res) => {
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    bufferPages: true,
    info: {
      Title: `Invoice ${bill.billNo || ""}`,
      Author: "Restaurant POS",
      Subject: "Tax Invoice"
    }
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=Invoice_${bill.billNo || "bill"}.pdf`);

  doc.pipe(res);

  const pw = 595.28; // A4 width
  const lm = 50, rm = 50, cw = pw - lm - rm;
  let y = 50;

  const hr = (yp, color = "#CCCCCC", w = 1) => {
    doc.moveTo(lm, yp).lineTo(pw - rm, yp).strokeColor(color).lineWidth(w).stroke();
  };

  const ct = (text, size = 10, bold = false, color = "#333333") => {
    doc.fontSize(size).font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(color);
    const tw = doc.widthOfString(text);
    doc.text(text, lm + (cw - tw) / 2, y, { lineBreak: false });
  };

  // ─── Header: Logo + Invoice Title ───
  const logoUrl = bill.logo || bill.restaurant?.logo || "";
  if (logoUrl) {
    try { doc.image(logoUrl, lm, y, { fit: [80, 60] }); } catch (e) {}
  }
  doc.fontSize(22).font("Helvetica-Bold").fillColor("#1a1a1a");
  doc.text("TAX INVOICE", pw - rm - doc.widthOfString("TAX INVOICE"), y);
  y += 8;
  doc.fontSize(9).font("Helvetica").fillColor("#666666");
  doc.text(`# ${bill.billNo || "N/A"}`, pw - rm - doc.widthOfString(`# ${bill.billNo || "N/A"}`), y);
  y += 20;

  // ─── Restaurant Details ───
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#333333");
  doc.text(bill.restaurantName || "Restaurant", lm, y); y += 16;
  doc.fontSize(8.5).font("Helvetica").fillColor("#555555");
  if (bill.address) { doc.text(bill.address, lm, y); y += 12; }
  if (bill.phone) { doc.text(`Phone: ${bill.phone}`, lm, y); y += 11; }
  if (bill.email) { doc.text(`Email: ${bill.email}`, lm, y); y += 11; }
  if (bill.gstNumber) { doc.text(`GST: ${bill.gstNumber}`, lm, y); y += 11; }
  if (bill.fssaiNumber) { doc.text(`FSSAI: ${bill.fssaiNumber}`, lm, y); y += 11; }

  // ─── Bill Details (Right) ───
  const bx = pw - rm - 200;
  doc.fontSize(8.5).font("Helvetica").fillColor("#555555");
  [
    { l: "Bill No:", v: bill.billNo || "N/A" },
    { l: "Date:", v: new Date(bill.createdAt || new Date()).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) },
    { l: "Order No:", v: bill.order?.orderNo || bill.orderNo || "N/A" },
    { l: "Table:", v: bill.order?.table?.tableNo || bill.tableName || "N/A" }
  ].forEach(d => {
    doc.text(d.l, bx, y, { width: 80 });
    doc.text(d.v, bx + 85, y, { width: 115, align: "right" });
    y += 11;
  });

  y = Math.max(y, 170);
  y += 8; hr(y, "#000000", 2); y += 12;

  // ─── Items Table ───
  const cI = lm, cQ = lm + 320, cR = lm + 360, cT = lm + 440;

  // Table Header
  doc.rect(lm, y - 4, cw, 18).fillColor("#333333").fill();
  doc.fillColor("#FFFFFF").fontSize(8).font("Helvetica-Bold");
  doc.text("ITEM", cI + 3, y + 1, { width: cQ - cI - 5 });
  doc.text("QTY", cQ + 3, y + 1, { width: 35, align: "center" });
  doc.text("RATE", cR + 3, y + 1, { width: 75, align: "right" });
  doc.text("AMOUNT", cT + 3, y + 1, { width: 70, align: "right" });
  y += 20;

  // Table Body
  const items = bill.order?.orderItems || [];
  items.forEach((item, idx) => {
    if (y > 720) {
      doc.addPage(); y = 50;
      doc.rect(lm, y - 4, cw, 18).fillColor("#333333").fill();
      doc.fillColor("#FFFFFF").fontSize(8).font("Helvetica-Bold");
      doc.text("ITEM", cI + 3, y + 1, { width: cQ - cI - 5 });
      doc.text("QTY", cQ + 3, y + 1, { width: 35, align: "center" });
      doc.text("RATE", cR + 3, y + 1, { width: 75, align: "right" });
      doc.text("AMOUNT", cT + 3, y + 1, { width: 70, align: "right" });
      y += 20;
    }
    const iName = item.menuItem?.name || item.name || "Item";
    if (idx % 2 === 1) doc.rect(lm, y - 2, cw, 16).fillColor("#f5f5f5").fill();
    doc.fillColor("#333333").fontSize(8).font("Helvetica");
    doc.text(iName, cI + 3, y, { width: cQ - cI - 5 });
    doc.text(String(item.quantity), cQ + 3, y, { width: 35, align: "center" });
    doc.text(`\u20B9${Number(item.price || 0).toFixed(2)}`, cR + 3, y, { width: 75, align: "right" });
    doc.text(`\u20B9${Number(item.total || (item.price * item.quantity) || 0).toFixed(2)}`, cT + 3, y, { width: 70, align: "right" });
    y += 20;
  });

  // ─── Totals ───
  y += 8; hr(y); y += 6;
  const tx = lm + 350;
  const al = (lbl, val, bold = false, size = 9) => {
    doc.fontSize(size).font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(bold ? "#1a1a1a" : "#555555");
    doc.text(lbl, tx, y, { width: 90 });
    doc.text(`\u20B9${Number(val).toFixed(2)}`, tx + 95, y, { width: 60, align: "right" });
    y += bold ? 16 : 13;
  };
  al("Subtotal:", bill.subtotal || 0);
  if (Number(bill.discount || 0) > 0) {
    let discountLabel = "Discount:";
    if (bill.discountType === "PERCENTAGE") {
      discountLabel = `Discount (${Number(bill.discountValue || 0)}%):`;
    } else if (bill.discountType === "FLAT" && Number(bill.discountValue || 0) > 0) {
      discountLabel = `Discount (\u20B9${Number(bill.discountValue).toFixed(0)}):`;
    }
    al(discountLabel, -Number(bill.discount));
  }
  if (Number(bill.serviceCharge || 0) > 0) al("Service Charge:", bill.serviceCharge);
  if (Number(bill.taxAmount || 0) > 0) al("Tax:", bill.taxAmount);
  if (Number(bill.roundOff || 0) !== 0) al("Round Off:", bill.roundOff);
  hr(y - 4, "#999999"); y += 4;
  al("GRAND TOTAL:", bill.grandTotal || 0, true, 12);

  // Payment details
  if (bill.payments && bill.payments.length > 0) {
    y += 6;
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#333333");
    doc.text("Payment Methods:", lm, y); y += 14;
    doc.fontSize(8).font("Helvetica").fillColor("#555555");
    bill.payments.forEach(p => {
      doc.text(`${p.paymentMethod || "CASH"}: \u20B9${Number(p.amount).toFixed(2)}`, lm + 10, y);
      y += 12;
    });
  }

  // ─── Footer ───
  y += 12; hr(y); y += 10;
  ct(bill.receiptFooter || bill.restaurant?.receiptFooter || "Thank you for your business!", 9, true, "#333333");
  y += 14;
  if (bill.gstNumber) {
    ct(`GST: ${bill.gstNumber} | Invoice: ${bill.billNo || "N/A"}`, 7.5, false, "#999999");
    y += 11;
  }
  ct(`Generated on ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, 7.5, false, "#999999");

  // Page numbers
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).font("Helvetica").fillColor("#999999");
    doc.text(`Page ${i + 1} of ${totalPages}`, lm, doc.page.height - 25, { align: "center", width: cw });
    doc.text("Generated by Restaurant POS", lm, doc.page.height - 16, { align: "center", width: cw });
  }
  doc.end();
};

module.exports = { generateInvoice };