/**
 * End-to-end verification of the menu item image upload flow.
 *
 * Tests against the RUNNING backend (http://localhost:5001/api):
 *   A. Reproduces the old bug: JSON payload (what axios did with the default
 *      Content-Type: application/json) → backend rejects "No file uploaded".
 *   B. Correct multipart upload (what the fixed frontend sends) → 201 + reference.
 *   C. Bind the uploaded image to a menu item (PUT) → persists (GET).
 *   D. Replace image (upload 2nd, PUT) → old file removed from storage.
 *   E. Remove image (PUT image=null) → file removed, DB null.
 *   F. Cleanup: delete the test menu item.
 *
 * Run: node scripts/test-image-flow.js
 * NOTE: Development-only verification script. Requires the backend to be running
 * on localhost:5001 and uses the seed credentials admin@restaurant.com / password123.
 */
const sharp = require("sharp");

const BASE = "http://localhost:5001/api";
const EMAIL = "admin@restaurant.com";
const PASSWORD = "password123";

let token = "";

async function api(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: res.status, json, text: raw ? text : undefined };
}

const step = (n, label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} [${n}] ${label}${extra ? " — " + extra : ""}`);
  if (!ok) process.exitCode = 1;
};

async function main() {
  console.log("=== Menu image upload flow — live backend test ===\n");

  // ── Login ────────────────────────────────────────────────────────────
  const login = await api("/auth/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  token = login.json?.token;
  step("0", `Login as ${EMAIL}`, !!token, login.json?.message || `HTTP ${login.status}`);

  // ── Generate a real test JPEG via sharp ───────────────────────────────
  const jpegBuffer = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 220, g: 40, b: 40 } },
  }).jpeg().toBuffer();
  const pngBuffer = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 40, g: 120, b: 220 } },
  }).png().toBuffer();

  // ── A. Reproduce the bug (JSON body, no multipart) ───────────────────
  {
    const res = await api("/menu/image", {
      method: "POST",
      body: { image: {} }, // this is what axios 1.x sent after JSON-stringifying FormData
    });
    step(
      "A",
      "Bug repro: JSON body → rejected (no file)",
      res.status === 400 && /no file uploaded/i.test(res.json?.message || ""),
      `HTTP ${res.status} — "${res.json?.message}"`
    );
  }

  // ── B. Correct multipart upload (FormData) ────────────────────────────
  let firstUrl, firstPublicId;
  {
    const fd = new FormData();
    fd.append("image", new Blob([jpegBuffer], { type: "image/jpeg" }), "test-red.jpg");
    const res = await api("/menu/image", { method: "POST", body: fd });
    firstUrl = res.json?.data?.imageUrl;
    firstPublicId = res.json?.data?.imagePublicId;
    step(
      "B",
      "Multipart upload (field 'image') → 201 + reference",
      res.status === 201 && !!firstUrl && !!firstPublicId,
      `HTTP ${res.status} — url=${firstUrl} publicId=${firstPublicId}`
    );
  }

  // ── Create a throwaway menu item to bind the image to ────────────────
  let menuId;
  {
    const catRes = await api("/categories");
    const catId = catRes.json?.categories?.[0]?.id;
    const res = await api("/menu", {
      method: "POST",
      body: {
        name: `__IMAGE_FLOW_TEST__${Date.now()}`,
        price: 99,
        categoryId: catId,
        image: firstUrl,
        imagePublicId: firstPublicId,
        isAvailable: true,
      },
    });
    menuId = res.json?.item?.id ?? res.json?.data?.id;
    step("C1", `Create test menu item`, !!menuId, `id=${menuId} (HTTP ${res.status})`);
  }

  // ── C. Persistence after save + fetch ────────────────────────────────
  {
    const res = await api(`/menu/${menuId}`);
    const item = res.json?.item ?? res.json?.data;
    const ok =
      !!item &&
      item.image === firstUrl &&
      item.imagePublicId === firstPublicId &&
      !item.imageIsExternal;
    step("C2", "Image persists after save + GET", ok, `image=${item?.image}`);
    const img = await fetch(`http://localhost:5001${firstUrl}`);
    step("C3", "Image URL serves the stored file", img.status === 200, `GET ${firstUrl} → ${img.status}`);
  }

  // ── D. Replace: upload 2nd image, PUT, old file removed ───────────────
  {
    const fd = new FormData();
    fd.append("image", new Blob([pngBuffer], { type: "image/png" }), "test-blue.png");
    const res = await api("/menu/image", { method: "POST", body: fd });
    const newUrl = res.json?.data?.imageUrl;
    const newPublicId = res.json?.data?.imagePublicId;

    const upd = await api(`/menu/${menuId}`, {
      method: "PUT",
      body: { image: newUrl, imagePublicId: newPublicId },
    });
    const fs = require("fs");
    const oldAbs = require("path").join(__dirname, "..", "uploads", firstPublicId);
    const oldGone = !fs.existsSync(oldAbs);
    step(
      "D",
      "Replace: new image bound, old image removed from storage",
      upd.status === 200 && oldGone,
      `HTTP ${upd.status}, old file exists=${!oldGone}`
    );

    const get2 = await api(`/menu/${menuId}`);
    const item = get2.json?.item ?? get2.json?.data;
    step("D2", "Replaced image persists", item?.image === newUrl && item?.imagePublicId === newPublicId, `image=${item?.image}`);

    firstUrl = newUrl;
    firstPublicId = newPublicId;
  }

  // ── E. Remove: PUT image=null → file removed, DB null ─────────────────
  {
    const upd = await api(`/menu/${menuId}`, {
      method: "PUT",
      body: { image: "", imagePublicId: "" },
    });
    const fs = require("fs");
    const abs = require("path").join(__dirname, "..", "uploads", firstPublicId);
    const gone = !fs.existsSync(abs);
    const get = await api(`/menu/${menuId}`);
    const item = get.json?.item ?? get.json?.data;
    step(
      "E",
      "Remove: image+publicId → null, file deleted",
      upd.status === 200 && gone && item?.image == null && item?.imagePublicId == null,
      `HTTP ${upd.status}, file exists=${!gone}`
    );
  }

  // ── F. Cleanup: delete the test item ──────────────────────────────────
  {
    const res = await api(`/menu/${menuId}`, { method: "DELETE" });
    step("F", "Cleanup: delete test menu item", res.status === 200, `HTTP ${res.status}`);
  }

  console.log("\n=== Done ===");
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
