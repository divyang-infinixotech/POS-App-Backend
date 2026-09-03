/**
 * Single source of truth for allowed browser origins (HTTP CORS + Socket.IO).
 *
 * Development defaults cover the Vite/React dev servers. In production the
 * CORS_ORIGINS env var (comma-separated) is required — see .env.example.
 * Falls back to ALLOWED_ORIGINS for backward compatibility.
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
  if (cached) return cached;
  // Support CORS_ORIGINS (preferred) or ALLOWED_ORIGINS (backward compat)
  const env = (process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS || "").trim();
  const frontendUrl = (process.env.FRONTEND_URL || "").trim();

  if (!env && !frontendUrl) {
    cached = DEV_ORIGINS;
  } else {
    const parts = [];
    if (env) {
      parts.push(...env.split(",").map((s) => s.trim()).filter(Boolean));
    }
    if (frontendUrl) {
      parts.push(frontendUrl);
    }
    // Merge with dev origins so development always works
    cached = [...new Set([...DEV_ORIGINS, ...parts])];
  }
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
  const allowed = getAllowedOrigins().includes(origin);
  if (!allowed && process.env.NODE_ENV !== 'production') {
    console.warn(`⚠ CORS blocked origin: ${origin}`);
  }
  return allowed;
}

module.exports = { getAllowedOrigins, isOriginAllowed };
