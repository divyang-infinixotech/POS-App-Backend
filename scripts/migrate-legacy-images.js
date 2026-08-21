/**
 * Legacy External-Image Migration
 *
 * Scans every MenuItem and:
 *   1. Detects images that point at third-party hosts (googleusercontent,
 *      unsplash, drive.google.com, etc.) and marks them with
 *      `imageIsExternal = true` — a flag the UI uses to prompt the
 *      restaurant to upload a replacement image.
 *   2. Backfills `imagePublicId` for already-self-hosted images
 *      (e.g. /uploads/menu/7/abc.jpg → menu/7/abc.jpg) so they can be
 *      replaced/deleted through the new workflow.
 *
 * It NEVER downloads or copies third-party images. Existing records are
 * never deleted or broken.
 *
 * Usage: node scripts/migrate-legacy-images.js [--dry-run]
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { isOwnStorageUrl, isExternalUrl, parseRestaurantId } = require("../src/services/storage.service");

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

const isDataUri = (url) => typeof url === "string" && url.startsWith("data:");

const classify = (image) => {
  if (!image) return "none";
  if (isDataUri(image)) return "data-uri"; // base64 embedded in DB — legacy, treated as external
  if (isOwnStorageUrl(image)) return "self-hosted";
  if (isExternalUrl(image)) return "external";
  return "other";
};

const publicIdFromUrl = (image) => {
  if (typeof image !== "string" || !image.startsWith("/uploads/")) return null;
  return image.replace(/^\/uploads\//, "");
};

(async () => {
  const items = await prisma.menuItem.findMany({
    where: { image: { not: null } },
    select: { id: true, name: true, image: true, imagePublicId: true, imageIsExternal: true, restaurantId: true }
  });

  const report = { external: 0, dataUri: 0, selfHosted: 0, other: 0, backfilled: 0, unchanged: 0 };
  const externalNames = [];

  for (const item of items) {
    const kind = classify(item.image);
    report[kind === "data-uri" ? "dataUri" : kind]++;

    if (kind === "external" || kind === "data-uri") {
      externalNames.push(`  #${item.id} "${item.name}" → ${String(item.image).slice(0, 70)}`);
      if (!DRY_RUN && !item.imageIsExternal) {
        await prisma.menuItem.update({
          where: { id: item.id },
          data: { imageIsExternal: true }
        });
      }
      continue;
    }

    if (kind === "self-hosted") {
      const publicId = publicIdFromUrl(item.image);
      const ownerOk = parseRestaurantId(publicId) === item.restaurantId;
      if (!item.imagePublicId && publicId && ownerOk) {
        report.backfilled++;
        if (!DRY_RUN) {
          await prisma.menuItem.update({
            where: { id: item.id },
            data: { imagePublicId: publicId, imageIsExternal: false }
          });
        }
      } else {
        report.unchanged++;
      }
      continue;
    }

    report.unchanged++;
  }

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Legacy Menu Image Migration Report              ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Mode:            ${DRY_RUN ? "DRY-RUN (no writes)" : "APPLY"}`);
  console.log(`  Menu items with image: ${items.length}`);
  console.log(`  External URLs marked legacy: ${report.external}`);
  console.log(`  Base64/data-URIs marked legacy: ${report.dataUri}`);
  console.log(`  Self-hosted (unchanged): ${report.unchanged}`);
  console.log(`  Self-hosted publicId backfilled: ${report.backfilled}`);
  if (externalNames.length) {
    console.log("\n  External images (awaiting restaurant replacement):");
    console.log(externalNames.join("\n"));
  }
  console.log("\n  Next step: in Menu & Stock → Edit Item, the legacy badge is shown");
  console.log("  and staff can upload an owned replacement image.\n");

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("❌ Migration failed:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
