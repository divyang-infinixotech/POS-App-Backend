/**
 * Menu Item Image Upload — Integration Test Suite
 *
 * Covers the 14 required scenarios:
 *   1.  Upload valid JPG
 *   2.  Upload PNG
 *   3.  Upload WebP
 *   4.  Upload >5 MB → reject
 *   5.  Upload invalid file → reject
 *   6.  Replace existing image (old file deleted after new is saved)
 *   7.  Remove image (file deleted, fields nulled)
 *   8.  Create item without image
 *   9.  Display image in Menu & Stock (GET /api/menu)
 *  10.  Display image in POS Ordering (same catalog endpoint + static /uploads)
 *  11.  Logout / login → image remains
 *  12.  Restaurant A cannot modify/delete Restaurant B's image
 *  13.  No Google/third-party URL is used by the new upload workflow
 *  14.  No orphaned image remains after replacement/deletion
 *
 * Run:  node test-menu-image-upload.js
 * (starts its own isolated server on port 5199 and cleans up after itself)
 */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const sharp = require("sharp");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const ROOT = __dirname;
const PORT = 5199;
const BASE = `http://localhost:${PORT}/api`;
const UPLOADS_ROOT = path.join(ROOT, "uploads");

const prisma = new PrismaClient();
const results = { pass: 0, fail: 0 };
const failures = [];

function check(cond, label) {
  process.stdout.write(cond ? "  ✅ " : "  ❌ ");
  console.log(label);
  cond ? results.pass++ : results.fail++;
  if (!cond) failures.push(label);
}
function eq(actual, expected, label) {
  const pass = actual === expected;
  process.stdout.write(pass ? "  ✅ " : "  ❌ ");
  console.log(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  pass ? results.pass++ : results.fail++;
  if (!pass) failures.push(label);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const api = async (method, url, { token, body, formData } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const resp = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  let data = null;
  try { data = await resp.json(); } catch (_) { /* no body */ }
  return { status: resp.status, data };
};

const login = async (email, password) => {
  const r = await api("POST", "/auth/login", { body: { email, password } });
  if (!r.data?.token) throw new Error(`Login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.token;
};

const uploadImage = async (token, buffer, mime, filename) => {
  const fd = new FormData();
  fd.append("image", new Blob([buffer], { type: mime }), filename);
  return api("POST", "/menu/image", { token, formData: fd });
};

const fileExists = (publicId) => {
  if (!publicId) return false;
  const abs = path.resolve(UPLOADS_ROOT, String(publicId).replace(/\\/g, "/"));
  if (!abs.startsWith(UPLOADS_ROOT + path.sep)) return false;
  return fs.existsSync(abs);
};

// ─── Test images ──────────────────────────────────────────────────────────────
async function makeImages() {
  const jpg = await sharp({ create: { width: 120, height: 120, channels: 3, background: { r: 220, g: 60, b: 60 } } }).jpeg({ quality: 90 }).toBuffer();
  const png = await sharp({ create: { width: 120, height: 120, channels: 3, background: { r: 60, g: 200, b: 60 } } }).png().toBuffer();
  const webp = await sharp({ create: { width: 120, height: 120, channels: 3, background: { r: 60, g: 60, b: 220 } } }).webp().toBuffer();
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1024, 0x61);
  const invalid = Buffer.from("#!/bin/bash\necho 'not an image'\nMZ\x90\x00", "binary");
  return { jpg, png, webp, oversized, invalid };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log("\nStarting isolated backend on port " + PORT + " …");
  const server = spawn("node", ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, BACKEND_PORT: String(PORT) },
    stdio: "ignore",
  });

  // Wait for the server to be ready
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) { ready = true; break; }
    } catch (_) { /* retry */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!ready) {
    console.error("❌ Server did not start");
    process.exit(1);
  }
  console.log("✓ Server ready\n");

  const img = await makeImages();
  let token, restaurantId, categoryId, createdItemIds = [];

  try {
    // ── Auth as seeded restaurant A admin ──
    token = await login("admin@restaurant.com", "password123");
    console.log("✓ Logged in as admin@restaurant.com\n");

    const cats = await api("GET", "/categories", { token });
    categoryId = cats.data?.categories?.[0]?.id;
    check(!!categoryId, "Have a category to attach items to");
    console.log(`  Category A id = ${categoryId}\n`);

    // ═══ 1. Upload valid JPG ═══
    console.log("═══ 1. Upload valid JPG ═══");
    let r = await uploadImage(token, img.jpg, "image/jpeg", "dish.jpg");
    eq(r.status, 201, "JPG upload status");
    const jpgRef = r.data?.data;
    check(!!jpgRef?.imageUrl && !!jpgRef?.imagePublicId, "JPG returned imageUrl + imagePublicId");
    check(String(jpgRef?.imageUrl).startsWith("/uploads/menu/"), "JPG url is self-hosted /uploads/menu/…");
    check(/^menu\/\d+\/[\w-]+\.jpg$/.test(jpgRef?.imagePublicId || ""), "JPG publicId format menu/{restaurantId}/{uuid}.jpg");
    restaurantId = Number(jpgRef?.imagePublicId?.split("/")[1]);
    check(restaurantId > 0, "Derived restaurantId from publicId");
    console.log(`  Restaurant A id = ${restaurantId}`);
    eq(jpgRef?.imagePublicId.split("/")[1], String(restaurantId), "JPG publicId embeds correct restaurantId");
    check(fileExists(jpgRef?.imagePublicId), "JPG file actually stored on disk");

    // ═══ 2. Upload PNG ═══
    console.log("\n═══ 2. Upload PNG ═══");
    r = await uploadImage(token, img.png, "image/png", "dish.png");
    eq(r.status, 201, "PNG upload status");
    const pngRef = r.data?.data;
    check(/\.png$/.test(pngRef?.imagePublicId || ""), "PNG publicId ends with .png");

    // ═══ 3. Upload WebP ═══
    console.log("\n═══ 3. Upload WebP ═══");
    r = await uploadImage(token, img.webp, "image/webp", "dish.webp");
    eq(r.status, 201, "WebP upload status");
    const webpRef = r.data?.data;
    check(/\.webp$/.test(webpRef?.imagePublicId || ""), "WebP publicId ends with .webp");

    // ═══ 4. Upload >5 MB → reject ═══
    console.log("\n═══ 4. Upload >5 MB → reject ═══");
    r = await uploadImage(token, img.oversized, "image/png", "huge.png");
    eq(r.status, 400, "Oversized upload rejected (400)");
    check(/5MB|too large|size/i.test(r.data?.message || ""), "Oversized message mentions size limit");

    // ═══ 5. Upload invalid file → reject ═══
    console.log("\n═══ 5. Upload invalid file → reject ═══");
    r = await uploadImage(token, img.invalid, "image/png", "evil.png");
    eq(r.status, 400, "Invalid content rejected (400)");
    check(/image|invalid|JPG|PNG|WebP/i.test(r.data?.message || ""), "Invalid content message is user-friendly");

    // ═══ 8. Create item WITHOUT image ═══
    console.log("\n═══ 8. Create item without image ═══");
    r = await api("POST", "/menu", {
      token,
      body: {
        name: "No Image Item", sku: `IMG-TEST-NOIMG-${Date.now()}`, price: 100,
        categoryId, isVeg: true, image: "", imagePublicId: "",
      },
    });
    eq(r.status, 201, "Item created without image");
    const noImgItem = r.data?.data;
    createdItemIds.push(noImgItem?.id);
    check(noImgItem?.image == null || noImgItem?.image === "", "image is null/empty");

    // ═══ 13. No external URLs allowed ═══
    console.log("\n═══ 13. External URLs rejected by the new workflow ═══");
    r = await api("POST", "/menu", {
      token,
      body: {
        name: "Evil External Item", sku: `IMG-TEST-EVIL-${Date.now()}`, price: 100,
        categoryId, image: "https://images.google.com/photo-123.jpg", imagePublicId: "menu/1/x.jpg",
      },
    });
    eq(r.status, 400, "Create with external URL rejected (400)");
    r = await api("POST", "/menu", {
      token,
      body: {
        name: "Evil Base64 Item", sku: `IMG-TEST-B64-${Date.now()}`, price: 100,
        categoryId, image: "data:image/png;base64,iVBORw0KGgo=", imagePublicId: "",
      },
    });
    eq(r.status, 400, "Create with base64 data-URI rejected (400)");

    // ═══ 9 + 10. Create item with uploaded image → visible in catalog (Menu & Stock + POS Ordering) ═══
    console.log("\n═══ 9/10. Item with image visible via GET /api/menu (Menu & Stock + POS Ordering) ═══");
    const skuA = `IMG-TEST-A-${Date.now()}`;
    r = await api("POST", "/menu", {
      token,
      body: {
        name: "Image Burger", sku: skuA, price: 250, categoryId,
        image: jpgRef.imageUrl, imagePublicId: jpgRef.imagePublicId, isVeg: true,
      },
    });
    eq(r.status, 201, "Item created with uploaded image ref");
    const itemA = r.data?.data;
    createdItemIds.push(itemA?.id);
    eq(itemA?.image, jpgRef.imageUrl, "MenuItem.image stores our /uploads URL");
    eq(itemA?.imagePublicId, jpgRef.imagePublicId, "MenuItem.imagePublicId stored");
    eq(itemA?.imageIsExternal, false, "imageIsExternal = false for self-hosted");

    r = await api("GET", "/menu", { token });
    const found = (r.data?.items || []).find((i) => i.id === itemA.id);
    check(!!found && found.image === jpgRef.imageUrl, "GET /api/menu returns the stored image URL");
    check(!/^https?:\/\/(?!res\.cloudinary\.com)/.test(String(found?.image || "")), "No third-party URL in catalog response");

    // Static serving of the stored image (what <img> tags fetch)
    const staticResp = await fetch(`http://localhost:${PORT}${jpgRef.imageUrl}`);
    eq(staticResp.status, 200, "Stored image served statically (200)");

    // ═══ 11. Logout / login → image remains ═══
    console.log("\n═══ 11. Logout / login → image remains ═══");
    token = await login("admin@restaurant.com", "password123"); // fresh login (new token)
    r = await api("GET", "/menu", { token });
    const foundAfter = (r.data?.items || []).find((i) => i.id === itemA.id);
    eq(foundAfter?.image, jpgRef.imageUrl, "Image still present after re-login");

    // ═══ 6a. Delete an unbound upload (support endpoint) ═══
    console.log("\n═══ 6a. Delete unbound upload via DELETE /menu/image ═══");
    const tmpRef = (await uploadImage(token, img.png, "image/png", "tmp.png")).data?.data;
    check(fileExists(tmpRef?.imagePublicId), "Unbound upload exists before delete");
    r = await api("DELETE", "/menu/image", { token, body: { imagePublicId: tmpRef.imagePublicId } });
    eq(r.status, 200, "Unbound upload deleted (200)");
    check(!fileExists(tmpRef?.imagePublicId), "Unbound upload file removed");

    // ═══ 6. Replace existing image ═══
    console.log("\n═══ 6. Replace existing image ═══");
    check(fileExists(itemA.imagePublicId), "Old image exists before replace");
    r = await api("PUT", `/menu/${itemA.id}`, {
      token,
      body: { name: "Image Burger", sku: skuA, price: 250, categoryId,
              image: webpRef.imageUrl, imagePublicId: webpRef.imagePublicId },
    });
    eq(r.status, 200, "Replace image via PUT (200)");
    eq(r.data?.item?.image, webpRef.imageUrl, "Item now references the new image");
    check(fileExists(webpRef.imagePublicId), "New image exists after replace");
    check(!fileExists(itemA.imagePublicId), "OLD image file deleted after replace (no orphan)");

    // Replacing with an external URL must fail even on update
    r = await api("PUT", `/menu/${itemA.id}`, {
      token,
      body: { name: "Image Burger", sku: skuA, price: 250, categoryId,
              image: "https://gstatic.com/evil.jpg", imagePublicId: "menu/1/evil.jpg" },
    });
    eq(r.status, 400, "Replace with external URL rejected (400)");

    // Partial update WITHOUT image fields must NOT delete the stored image
    r = await api("PUT", `/menu/${itemA.id}`, { token, body: { price: 275 } });
    eq(r.status, 200, "Partial update (price only) succeeds");
    check(r.data?.item?.image === webpRef.imageUrl, "Image ref preserved on partial update");
    check(fileExists(webpRef.imagePublicId), "Image file preserved on partial update (no data loss)");

    // ═══ 7. Remove image ═══
    console.log("\n═══ 7. Remove image ═══");
    r = await api("PUT", `/menu/${itemA.id}`, {
      token,
      body: { name: "Image Burger", sku: skuA, price: 250, categoryId, image: "", imagePublicId: "" },
    });
    eq(r.status, 200, "Remove image via PUT image:'' (200)");
    check(r.data?.item?.image == null, "MenuItem.image is null after remove");
    check(r.data?.item?.imagePublicId == null, "MenuItem.imagePublicId is null after remove");
    check(!fileExists(webpRef.imagePublicId), "Removed image file deleted from disk (no orphan)");

    // ═══ 12. Multi-tenant: Restaurant B cannot touch Restaurant A's image ═══
    console.log("\n═══ 12. Restaurant B cannot modify/delete Restaurant A's image ═══");
    // A fresh image owned by A that stays unbound for the whole tenant test
    const tenantRef = (await uploadImage(token, img.png, "image/png", "tenant-a.png")).data?.data;
    check(fileExists(tenantRef?.imagePublicId), "A owns a live uploaded image for tenant test");
    // Create restaurant B + subscription + user directly (mirrors a seeded tenant)
    const bSuffix = Date.now();
    const resA = await prisma.restaurant.findFirst({ where: { users: { some: { email: "admin@restaurant.com" } } } });
    const subA = await prisma.subscription.findUnique({ where: { restaurantId: resA.id } });
    const resB = await prisma.restaurant.create({
      data: {
        name: `Tenant B ${bSuffix}`, ownerName: "B Owner", phone: `99${String(bSuffix).slice(-8)}`,
        subscriptionPlan: subA?.plan || "TRIAL", status: "ACTIVE",
      },
    });
    await prisma.subscription.create({
      data: {
        restaurantId: resB.id,
        plan: subA?.plan || "TRIAL",
        status: "ACTIVE",
        startDate: new Date(), expiryDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        billingCycle: "MONTHLY",
      },
    });
    const bHash = await bcrypt.hash("password123", 10);
    await prisma.user.create({
      data: { restaurantId: resB.id, name: "Admin B", email: `adminb${bSuffix}@test.com`, password: bHash, role: "ADMIN", isActive: true, phone: `98${String(bSuffix).slice(-8)}` },
    });
    const catB = await prisma.category.create({ data: { name: `Cat B ${bSuffix}`, restaurantId: resB.id } });
    const tokenB = await login(`adminb${bSuffix}@test.com`, "password123");

    // B tries to DELETE A's uploaded (unbound) image
    r = await api("DELETE", "/menu/image", { token: tokenB, body: { imagePublicId: tenantRef.imagePublicId } });
    eq(r.status, 403, "B deleting A's image → 403");
    check(fileExists(tenantRef.imagePublicId), "A's image still exists after B's attempt");

    // B tries to bind A's image publicId to one of B's items
    r = await api("POST", "/menu", {
      token: tokenB,
      body: { name: "B Item", sku: `B-${bSuffix}`, price: 50, categoryId: catB.id, image: tenantRef.imageUrl, imagePublicId: tenantRef.imagePublicId },
    });
    eq(r.status, 403, "B binding A's image to B's item → 403");

    // B tries to update A's item → 404 (not visible to B)
    r = await api("PUT", `/menu/${itemA.id}`, { token: tokenB, body: { name: "Hacked" } });
    eq(r.status, 404, "B updating A's item → 404");
    check(fileExists(tenantRef.imagePublicId), "A's image untouched after B's attempts");

    // Cleanup: A deletes its own unbound image (positive control)
    r = await api("DELETE", "/menu/image", { token, body: { imagePublicId: tenantRef.imagePublicId } });
    eq(r.status, 200, "A CAN delete its own image (200)");

    // ═══ 14. No orphan after ITEM deletion ═══
    console.log("\n═══ 14. No orphan after item deletion ═══");
    const skuD = `IMG-TEST-DEL-${Date.now()}`;
    r = await api("POST", "/menu", {
      token,
      body: { name: "Delete Me", sku: skuD, price: 60, categoryId, image: pngRef.imageUrl, imagePublicId: pngRef.imagePublicId },
    });
    const delItem = r.data?.data;
    createdItemIds.push(delItem?.id);
    check(fileExists(pngRef.imagePublicId), "Image exists before item deletion");
    r = await api("DELETE", `/menu/${delItem.id}`, { token });
    eq(r.status, 200, "Item deleted");
    check(!fileExists(pngRef.imagePublicId), "Item's image file deleted with the item (no orphan)");

    // ── Cleanup test tenant B ──
    await prisma.user.deleteMany({ where: { restaurantId: resB.id } });
    await prisma.subscription.deleteMany({ where: { restaurantId: resB.id } });
    await prisma.category.deleteMany({ where: { restaurantId: resB.id } });
    await prisma.menuItem.deleteMany({ where: { restaurantId: resB.id } });
    await prisma.restaurant.delete({ where: { id: resB.id } });

    // ── Cleanup items created by the test ──
    for (const id of createdItemIds) {
      try { await prisma.menuItem.delete({ where: { id } }); } catch (_) { /* already gone */ }
    }
  } catch (err) {
    console.error("\n❌ Test harness error:", err);
    results.fail++;
    failures.push("harness error: " + err.message);
  } finally {
    await prisma.$disconnect();
    server.kill();
  }

  // ─── Summary ───
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  RESULTS: ${results.pass} passed, ${results.fail} failed`);
  console.log(`${"=".repeat(60)}`);
  if (failures.length) {
    console.log("\nFailed checks:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(results.fail ? 1 : 0);
})();
