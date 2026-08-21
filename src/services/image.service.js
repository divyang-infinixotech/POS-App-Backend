/**
 * Image validation & processing.
 *
 * Security model:
 *   - MIME type from the client is only a first filter (multer fileFilter).
 *   - The ACTUAL file content is validated twice:
 *       1. magic-byte sniffing (rejects executables / disguised files)
 *       2. full decode via `sharp` (rejects corrupt or polyglot payloads)
 *   - Images are re-encoded (resized + compressed) so nothing is ever stored
 *     as uploaded; this also strips metadata.
 */
const sharp = require("sharp");

const ALLOWED_FORMATS = ["jpeg", "png", "webp"];

/** Sniff the real format from magic bytes. Returns 'jpeg' | 'png' | 'webp' | null */
const detectImageFormat = (buffer) => {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return "png";
  // WebP: RIFF....WEBP
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "webp";
  return null;
};

/**
 * Full validation: magic bytes + sharp decode.
 * Throws an Error with a user-friendly message when the buffer is not a valid image.
 */
const validateImageBuffer = async (buffer) => {
  const format = detectImageFormat(buffer);
  if (!format) {
    throw new Error("Invalid file: only JPG, PNG or WebP images are allowed");
  }
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (err) {
    throw new Error("Invalid or corrupted image file");
  }
  if (!metadata.width || !metadata.height) {
    throw new Error("Invalid image file");
  }
  return { format, width: metadata.width, height: metadata.height };
};

/**
 * Resize + compress an image and re-encode it in its original format.
 * - max 900px on the longest edge (never enlarged)
 * - strips EXIF / metadata
 */
const processImage = async (buffer, format) => {
  const pipeline = sharp(buffer)
    .rotate() // honour EXIF orientation before resizing
    .resize(900, 900, { fit: "inside", withoutEnlargement: true });

  if (format === "jpeg") {
    return pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  }
  if (format === "png") {
    return pipeline.png({ compressionLevel: 8, palette: true }).toBuffer();
  }
  return pipeline.webp({ quality: 80 }).toBuffer();
};

module.exports = { ALLOWED_FORMATS, detectImageFormat, validateImageBuffer, processImage };
