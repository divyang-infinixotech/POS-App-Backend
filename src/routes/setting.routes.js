const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const prisma = require("../config/prisma");

const router = express.Router();
const audit = require("../middleware/audit.middleware");

const protect = require("../middleware/auth.middleware");
const authorize = require("../middleware/role.middleware");
const validate = require("../middleware/validate.middleware");

const {
  createOrUpdateSetting,
  getSetting
} = require("../controllers/setting.controller");

const {
  settingSchema
} = require("../validators/setting.validator");

// ─── Logo file upload configuration ───
// The client-declared MIME type is only a first filter: the actual file
// content is sniffed from magic bytes (and fully decoded for raster formats)
// before anything is written to disk. The stored extension is derived from
// the detected format — never from the upload filename — so a disguised
// file (e.g. .html or .exe renamed to .png) cannot be stored or served.
const uploadsDir = path.join(__dirname, "..", "..", "uploads", "logos");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const sharp = require("sharp");

/** Detect the real logo format from magic bytes. Returns ext or null. */
function sniffLogoFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  // SVG has no fixed magic bytes — require an XML/SVG declaration up front
  const head = buffer.toString("utf8", 0, 512);
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** Reject SVG payloads that contain active content (scripts / event handlers). */
function validateSvgContent(buffer) {
  const text = buffer.toString("utf8");
  if (/<script|on(load|error|click|mouseover|focus|submit|change)\s*=|javascript:/i.test(text)) {
    throw new Error("SVG files with embedded scripts are not allowed");
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files (JPEG, PNG, GIF, WebP, SVG) are allowed"), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

/** Validate magic bytes + decode raster formats; throws with a safe message. */
async function validateLogoBuffer(buffer) {
  const ext = sniffLogoFormat(buffer);
  if (!ext) {
    throw new Error("Invalid image file: only JPEG, PNG, GIF, WebP or SVG are allowed");
  }
  if (ext === "svg") {
    validateSvgContent(buffer);
    return ext;
  }
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) throw new Error("Invalid image file");
  } catch (err) {
    if (err.message && err.message.includes("only JPEG, PNG, GIF, WebP or SVG")) throw err;
    throw new Error("Invalid or corrupted image file");
  }
  return ext;
}

/** Persist a validated logo buffer to the logos directory. */
async function saveLogoFile(buffer, restaurantId, ext) {
  const name = `logo-${restaurantId}-${Date.now()}.${ext}`;
  const abs = path.join(uploadsDir, name);
  // Defense in depth: ensure the resolved path stays inside uploads/logos
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(uploadsDir) + path.sep)) {
    throw new Error("Invalid logo path");
  }
  await fs.promises.writeFile(resolved, buffer);
  return name;
}

// ─── Routes ───

// POST: Create or update settings
router.post(
  "/",
  protect,
  authorize("ADMIN"),
  validate(settingSchema),
  createOrUpdateSetting
);

// GET: Get settings
router.get(
  "/",
  protect,
  getSetting
);

// POST: Upload logo (with multer error handling wrapper)
router.post(
  "/logo",
  protect,
  authorize("ADMIN"),
  (req, res, next) => {
    upload.single("logo")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ success: false, message: "File too large. Maximum size is 5MB." });
          }
          return res.status(400).json({ success: false, message: err.message });
        }
        return res.status(400).json({ success: false, message: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded" });
      }
      // Validate the ACTUAL file content (magic bytes + decode) before storing
      let ext;
      try {
        ext = await validateLogoBuffer(req.file.buffer);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      const fileName = await saveLogoFile(req.file.buffer, req.user.restaurantId, ext);
      const logoUrl = `/uploads/logos/${fileName}`;
      const existing = await prisma.restaurantSetting.findUnique({
        where: { restaurantId: req.user.restaurantId }
      });
      if (existing) {
        await prisma.restaurantSetting.update({
          where: { restaurantId: req.user.restaurantId },
          data: { logo: logoUrl }
        });
      } else {
        await prisma.restaurantSetting.create({
          data: {
            restaurantId: req.user.restaurantId,
            restaurantName: "Untitled",
            logo: logoUrl
          }
        });
      }
      res.json({ success: true, logo: logoUrl, message: "Logo uploaded successfully" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// DELETE: Delete logo
router.delete(
  "/logo",
  protect,
  authorize("ADMIN"),
  async (req, res) => {
    try {
      const existing = await prisma.restaurantSetting.findUnique({
        where: { restaurantId: req.user.restaurantId }
      });
      if (existing && existing.logo) {
        // Delete file from disk
        const fileName = path.basename(existing.logo);
        const filePath = path.join(uploadsDir, fileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        await prisma.restaurantSetting.update({
          where: { restaurantId: req.user.restaurantId },
          data: { logo: null }
        });
      }
      res.json({ success: true, message: "Logo deleted successfully" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;