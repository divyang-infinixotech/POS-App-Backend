/**
 * Single source of truth for allowed browser origins (HTTP CORS + Socket.IO).
 *
 * Development defaults cover the Vite/React dev servers. In production the
 * ALLOWED_ORIGINS env var (comma-separated) is required — see .env.example.
 */
const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

let cached = null;

function getAllowedOrigins() {
  const env = (process.env.ALLOWED_ORIGINS || "").trim();
  if (!env) return DEV_ORIGINS;
  if (cached) return cached;
  cached = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return cached;
}

/**
 * Origin check used by both `cors` and `socket.io`:
 * - requests without an Origin header (curl, server-to-server, mobile) are allowed
 * - browsers from a configured origin are allowed
 * - anything else is rejected
 */
function isOriginAllowed(origin) {
  if (!origin) return true;
  return getAllowedOrigins().includes(origin);
}

module.exports = { getAllowedOrigins, isOriginAllowed };
