// ─── UNCAUGHT EXCEPTION / REJECTION HANDLERS (placed first) ───
process.on("uncaughtException", (err) => {
  console.error("\n❌ UNCAUGHT EXCEPTION:");
  console.error(err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("\n❌ UNHANDLED REJECTION:");
  console.error(reason);
  process.exit(1);
});

require("dotenv").config();

// Quick sanity: ensure critical env vars exist
if (!process.env.DATABASE_URL) {
  console.error("\n❌ FATAL: DATABASE_URL is not set in .env");
  console.error("   Copy .env.example to .env and fill in the values.");
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error("\n❌ FATAL: JWT_SECRET is not set in .env");
  console.error("   Copy .env.example to .env and fill in the values.");
  process.exit(1);
}

// ─── Payment gateway (Razorpay) readiness check ───
// Reports only presence — NEVER print key values. The backend boots without
// keys and degrades to a clear 503 on checkout until they are configured.
const rzpKeyId = !!process.env.RAZORPAY_KEY_ID;
const rzpKeySecret = !!process.env.RAZORPAY_KEY_SECRET;
const rzpWebhookSecret = !!process.env.RAZORPAY_WEBHOOK_SECRET;
if (rzpKeyId && rzpKeySecret && rzpWebhookSecret) {
  console.log("✓ Razorpay configured (key id, key secret, webhook secret)");
} else if (rzpKeyId && rzpKeySecret) {
  console.log("⚠ Razorpay partially configured — missing RAZORPAY_WEBHOOK_SECRET (webhooks disabled)");
} else {
  console.log("⚠ Razorpay not configured — subscription checkout returns 503 until RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET are set in .env");
}

const http = require("http");

let app;
try {
  app = require("./app");
} catch (err) {
  console.error("\n❌ FATAL: Failed to load app module:");
  console.error(err);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || process.env.BACKEND_PORT, 10) || 5001;

// ─── Create HTTP server (required by Socket.IO) ───
const server = http.createServer(app);

// ─── Initialize Socket.IO ───
try {
  const { initSocket } = require("./services/socket");
  initSocket(server);
} catch (err) {
  console.error("⚠ Could not initialize Socket.IO:", err.message);
}

server.listen(PORT, () => {
  try {
    const logger = require("./logger/logger");
    logger.info(`Server running on port ${PORT}`);
  } catch (err) {
    console.log(`✓ Server running on ${PORT}`);
  }
  console.log(`✓ Backend ready on port ${PORT}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || "development"}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error("   Kill the other process or use a different port.");
  } else {
    console.error("\n❌ Server error:", err);
  }
  process.exit(1);
});

// ─── Subscriptions cron ───
try {
  const subscriptionExpiryJob = require("./cron/subscription.cron");
  subscriptionExpiryJob();
} catch (err) {
  console.error("⚠ Warning: Could not load subscription cron:", err.message);
}

// ─── Orphan menu-image cleanup cron ───
try {
  const imageCleanupJob = require("./cron/image-cleanup.cron");
  imageCleanupJob();
} catch (err) {
  console.error("⚠ Warning: Could not load image cleanup cron:", err.message);
}

// ─── Graceful shutdown (SIGTERM / SIGINT) ───
// Closes the HTTP server (which stops Socket.IO), then disconnects Prisma so
// the process exits without hanging database connections. A short timeout
// force-exits if a keep-alive connection refuses to close.
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  try {
    server.closeIdleConnections?.();
  } catch (_) { /* ignore */ }

  const forceExit = setTimeout(() => {
    console.error("❌ Forced shutdown after 10s timeout.");
    process.exit(1);
  }, 10000);
  forceExit.unref();

  server.close(async () => {
    try {
      const { getIO } = require("./services/socket");
      const io = getIO();
      io.close();
    } catch (_) { /* Socket.IO not initialized */ }
    try {
      const prisma = require("./config/prisma");
      await prisma.$disconnect();
    } catch (_) { /* ignore */ }
    clearTimeout(forceExit);
    console.log("✓ Shutdown complete.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));