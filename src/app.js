const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const errorHandler = require("./middleware/error.middleware");
const {
    apiLimiter
} = require("./middleware/rate-limit.middleware");

// ─── Ensure logs directory exists (for winston file transport) ───
const logsDir = path.join(__dirname, "..", "logs");
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
} catch (err) {
  console.warn("⚠ Could not create logs directory:", err.message);
}

// ─── Route imports ───
const authRoutes = require("./routes/auth.routes");
const adminRoutes = require("./routes/admin.routes");
const userRoutes = require("./routes/user.routes");
const restaurantRoutes = require("./routes/restaurant.routes");
const tableRoutes = require("./routes/table.routes");
const menuRoutes = require("./routes/menu.routes");
const categoryRoutes = require("./routes/category.routes");
const orderRoutes = require("./routes/order.routes");
const kotRoutes = require("./routes/kot.routes");
const billRoutes = require("./routes/bill.routes");
const settingRoutes = require("./routes/setting.routes");
const paymentRoutes = require("./routes/payment.routes");
const printRoutes = require("./routes/print.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const reportRoutes = require("./routes/report.routes");
const printerRoutes = require("./routes/printer.routes");
const auditRoutes = require("./routes/audit.routes");
const customerRoutes = require("./routes/customer.routes");
const floorRoutes = require("./routes/floor.routes");
const subscriptionRoutes = require("./routes/subscription.routes");
const notificationRoutes = require("./routes/notification.routes");
const superAdminRoutes = require("./routes/super-admin.routes");

const app = express();
app.set("trust proxy", 1);

// ─── Allowed origins (shared with Socket.IO — see config/origins.js) ───
const { isOriginAllowed } = require("./config/origins");

// ─── Security headers (before CORS so preflight also gets them) ───
app.use(
    helmet({
        crossOriginResourcePolicy: false
    })
);

// ─── CORS (handle OPTIONS preflight explicitly) ───
app.use(
    cors({
        origin: function (origin, callback) {
            // Allow requests with no origin (e.g. curl, Postman, server-to-server)
            if (isOriginAllowed(origin)) {
                return callback(null, true);
            }
            // Block unknown origins cleanly (403, never a 500)
            const err = new Error("Origin not allowed");
            err.statusCode = 403;
            return callback(err);
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
],
        optionsSuccessStatus: 204
    })
);

// ─── Rate limiter ───
app.use(apiLimiter);

// ─── Body parser ───
// Razorpay webhook needs the RAW body for HMAC signature verification — parse
// it BEFORE the global JSON parser so req.body stays a Buffer on that path.
app.use("/api/subscriptions/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ─── Serve uploaded files (logos, etc.) ───
const uploadsDir = path.join(__dirname, "..", "uploads");
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (err) {
  console.warn("Could not create uploads directory:", err.message);
}
app.use("/uploads", express.static(uploadsDir));

// ─── Request logger (development only) ───
// Never logs query strings — PDF/KOT download links pass ?token= and logging
// the raw URL would write JWTs into the log files.
// Production relies on the winston logger (startup/errors/business failures).
app.use((req, res, next) => {
  if (process.env.NODE_ENV === "production") return next();
  const start = Date.now();
  const clean = (url) => String(url).split("?")[0];
  console.log(`➡ ${req.method} ${clean(req.originalUrl)}`);
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`⬅ ${req.method} ${clean(req.originalUrl)} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─── Routes ───
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/tables", tableRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/kot", kotRoutes);
app.use("/api/bills", billRoutes);
app.use("/api/settings", settingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/print", printRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/printer", printerRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/floors", floorRoutes);
app.use("/api/restaurants", restaurantRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/notifications", notificationRoutes);

// ─── Super Admin Routes ───
app.use("/api/super-admin", superAdminRoutes);

// ─── Root health-check ───
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Restaurant POS Backend Running",
    });
});

// ─── 404 catch-all ───
app.use((req, res) => {
    console.warn(`⚠ 404 — ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        success: false,
        message: `Route ${req.method} ${req.originalUrl} not found`
    });
});

// ─── Global error handler ───
app.use(errorHandler);

module.exports = app;