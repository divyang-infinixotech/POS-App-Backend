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
  // Mirrors the HTTP `protect` middleware: the identity (role, restaurant) is
  // re-validated against the DATABASE at connect time, so a disabled user, a
  // deleted user, a changed password, or a stale JWT with a mismatched
  // restaurant context can never subscribe to a tenant room. The JWT itself is
  // only a bearer credential — it never selects the room on its own.
  io.use(async (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { platformPrisma, getTenantClientByRestaurantId } = require("../config/tenantPrisma");

      const isPlatformUser =
        decoded.role === "SUPER_ADMIN" || decoded.role === "ADMIN";

      let user = null;
      let restaurantId = null;

      if (isPlatformUser) {
        user = await platformPrisma.user.findUnique({
          where: { id: decoded.id },
          include: { restaurant: true },
        });
        if (user && user.role === "ADMIN") {
          restaurantId = user.restaurantId;
          if (!restaurantId) throw new Error("User is not assigned to a restaurant");
          if (decoded.restaurantId && Number(decoded.restaurantId) !== Number(restaurantId)) {
            throw new Error("Invalid restaurant context");
          }
          if (!user.restaurant || user.restaurant.status !== "ACTIVE") {
            throw new Error("Restaurant not active");
          }
        }
      } else {
        // Tenant staff (MANAGER/CASHIER/KITCHEN/WAITER): resolve the tenant
        // schema from the JWT restaurant and verify the row there agrees.
        const rid = Number(decoded.restaurantId);
        if (!Number.isInteger(rid) || rid <= 0) {
          throw new Error("Invalid restaurant context");
        }
        const { client } = await getTenantClientByRestaurantId(rid);
        user = await client.user.findUnique({ where: { id: decoded.id } });
        if (!user) throw new Error("User not found");
        const allowedStaffRoles = ["MANAGER", "CASHIER", "KITCHEN", "WAITER"];
        if (!allowedStaffRoles.includes(user.role)) throw new Error("Invalid restaurant user role");
        if (!user.restaurantId || Number(user.restaurantId) !== rid) {
          throw new Error("Invalid restaurant context");
        }
        restaurantId = rid;
      }

      if (!user) throw new Error("User not found");
      if (user.deletedAt) throw new Error("User not found");
      if (user.isActive === false) throw new Error("Account disabled");
      if (user.passwordChangedAt) {
        const changedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
        if (decoded.iat && changedAtSec > decoded.iat) {
          throw new Error("Password changed — log in again");
        }
      }

      socket.user = {
        id: user.id,
        restaurantId,
        role: user.role,
      };
      next();
    } catch (err) {
      return next(new Error(err && err.message ? err.message : "Invalid token"));
    }
  });

  // ─── On connection ───
  io.on("connection", (socket) => {
    const { restaurantId, id: userId } = socket.user;

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
