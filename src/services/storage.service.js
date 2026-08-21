/**
 * Storage abstraction for uploaded assets (menu item images).
 *
 * Drivers:
 *   - local      (default)  → stores processed images under <backend>/uploads and
 *                             serves them via express.static("/uploads") (see app.js).
 *   - cloudinary            → uses the existing `cloudinary` npm dependency when
 *                             CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
 *                             CLOUDINARY_API_SECRET are configured and
 *                             STORAGE_DRIVER=cloudinary.
 *
 * Images are NEVER stored inside PostgreSQL — only the URL + publicId reference
 * is persisted on the MenuItem row.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UPLOADS_ROOT = path.join(__dirname, "..", "..", "uploads");

const isCloudinaryConfigured = () =>
  process.env.STORAGE_DRIVER === "cloudinary" &&
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

let cloudinaryInstance = null;
if (isCloudinaryConfigured()) {
  try {
    cloudinaryInstance = require("cloudinary").v2;
    cloudinaryInstance.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  } catch (err) {
    console.warn("⚠ Cloudinary configured but could not load the client:", err.message);
    cloudinaryInstance = null;
  }
}

/**
 * Build a tenant-scoped, unique storage key.
 * e.g. menu/7/3f9c…a1.jpeg  (restaurantId embedded → multi-tenant ownership checks)
 */
const buildPublicId = (restaurantId, ext) => {
  const safeExt = String(ext || "jpg").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "jpg";
  const uuid = crypto.randomUUID();
  return `menu/${Number(restaurantId)}/${uuid}.${safeExt}`;
};

/** Extract the restaurantId embedded in a publicId (menu/{restaurantId}/{file}). */
const parseRestaurantId = (publicId) => {
  const parts = String(publicId || "").split("/");
  if (parts.length >= 3 && parts[0] === "menu" && /^\d+$/.test(parts[1])) {
    return Number(parts[1]);
  }
  return null;
};

/** True when a URL points at our own application storage. */
const isOwnStorageUrl = (url) =>
  typeof url === "string" &&
  (url.startsWith("/uploads/") || url.startsWith("https://res.cloudinary.com/"));

/** True when a URL points at a third-party host (googleusercontent, unsplash, etc.). */
const isExternalUrl = (url) =>
  typeof url === "string" && /^https?:\/\//i.test(url) && !isOwnStorageUrl(url);

// ─── Local driver ──────────────────────────────────────────────────────────────

const localSafePath = (key) => {
  // Prevent path traversal: resolve within uploads root and verify containment.
  const safeKey = String(key).replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(UPLOADS_ROOT, safeKey);
  if (!abs.startsWith(UPLOADS_ROOT + path.sep) && abs !== UPLOADS_ROOT) {
    throw new Error("Invalid storage key");
  }
  return abs;
};

const localDriver = {
  async upload(buffer, { key, mimetype }) {
    const abs = localSafePath(key);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    return {
      url: `/uploads/${String(key).replace(/\\/g, "/").replace(/^\/+/, "")}`,
      publicId: String(key).replace(/\\/g, "/").replace(/^\/+/, ""),
      mimetype,
    };
  },
  async remove(publicId) {
    const abs = localSafePath(publicId);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      fs.unlinkSync(abs);
      // Best-effort cleanup of now-empty tenant folders
      try {
        const dir = path.dirname(abs);
        if (dir.startsWith(UPLOADS_ROOT) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      } catch (_) {
        /* ignore */
      }
      return true;
    }
    return false;
  },
  /** List all stored keys with their mtime (used by the orphan cleanup cron). */
  listKeys() {
    const keys = [];
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, relPath);
        else if (entry.isFile()) {
          keys.push({ key: relPath.replace(/\\/g, "/"), mtime: fs.statSync(full).mtime });
        }
      }
    };
    const menuRoot = path.join(UPLOADS_ROOT, "menu");
    if (fs.existsSync(menuRoot)) walk(menuRoot, "menu");
    return keys;
  },
};

// ─── Cloudinary driver ─────────────────────────────────────────────────────────

const cloudinaryDriver = {
  async upload(buffer, { key, mimetype }) {
    if (!cloudinaryInstance) throw new Error("Cloudinary is not configured");
    const publicId = String(key).replace(/\.[a-zA-Z0-9]+$/, ""); // cloudinary appends the format
    const result = await new Promise((resolve, reject) => {
      cloudinaryInstance.uploader
        .upload_stream({ public_id: publicId, resource_type: "image" }, (err, res) =>
          err ? reject(err) : resolve(res)
        )
        .end(buffer);
    });
    return { url: result.secure_url, publicId: result.public_id };
  },
  async remove(publicId) {
    if (!cloudinaryInstance) throw new Error("Cloudinary is not configured");
    const result = await cloudinaryInstance.uploader.destroy(String(publicId), {
      resource_type: "image",
    });
    return result.result === "ok";
  },
  listKeys() {
    // Cloudinary deployments should rely on their own asset lifecycle policies.
    return [];
  },
};

const storage = cloudinaryInstance ? cloudinaryDriver : localDriver;

module.exports = {
  storage,
  driver: cloudinaryInstance ? "cloudinary" : "local",
  UPLOADS_ROOT,
  buildPublicId,
  parseRestaurantId,
  isOwnStorageUrl,
  isExternalUrl,
  localDriver,
  cloudinaryDriver,
};
