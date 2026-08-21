const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { isOriginAllowed } = require("../config/origins");

let io = null;

/**
 * Initialize Socket.IO with the HTTP server.
 * Attaches JWT authentication middleware and manages per-restaurant rooms.
 * CORS policy is shared with the HTTP API (config/origins.js) so production
 * deployments configure one ALLOWED_ORIGINS list for both transports.
 */
function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: function (origin, callback) {
        if (isOriginAllowed(origin)) {
          return callback(null, true);
        }
        return callback(new Error("Origin not allowed"));
      },
      credentials: true,
      methods: ["GET", "POST"],
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ─── JWT Authentication middleware ───
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = {
        id: decoded.id,
        restaurantId: decoded.restaurantId || null,
        role: decoded.role,
      };
      next();
    } catch (err) {
      return next(new Error("Invalid token"));
    }
  });

  // ─── On connection ───
  io.on("connection", (socket) => {
    const { restaurantId, role, id: userId } = socket.user;

    // Socket connected

    // Join restaurant-specific room for scoped broadcasts
    if (restaurantId) {
      socket.join(`restaurant:${restaurantId}`);
      socket.join(`user:${userId}`); // personal notifications
    }

    socket.on("disconnect", (reason) => {
      // Socket disconnected
    });

    socket.on("error", (err) => {
      console.error(`⚠ Socket error for user=${userId}:`, err.message);
    });
  });

  // Socket.IO initialized
  return io;
}

/**
 * Get the Socket.IO server instance.
 */
function getIO() {
  if (!io) {
    throw new Error("Socket.IO not initialized. Call initSocket(server) first.");
  }
  return io;
}

// ─── Convenience emitters ───

function emitToRestaurant(restaurantId, event, data) {
  if (!io) return;
  io.to(`restaurant:${restaurantId}`).emit(event, data);
}

function emitToUser(userId, event, data) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

/**
 * Emit order-related events to a restaurant room.
 */
function emitOrderEvent(restaurantId, action, order) {
  emitToRestaurant(restaurantId, `order:${action}`, {
    action,
    order,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit KOT-related events to a restaurant room.
 */
function emitKotEvent(restaurantId, action, kot) {
  emitToRestaurant(restaurantId, `kot:${action}`, {
    action,
    kot,
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  initSocket,
  getIO,
  emitToRestaurant,
  emitToUser,
  emitOrderEvent,
  emitKotEvent,
};
