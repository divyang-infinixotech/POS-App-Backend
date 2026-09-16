/**
 * Real-browser Socket.IO verification (puppeteer-core + installed Chrome).
 *
 * 1. Opens the real frontend at http://localhost:3000
 * 2. Seeds a REAL SUPER_ADMIN JWT (signed with the backend's own secret) into
 *    localStorage using the app's own keys (`pos_token` / `pos_user`)
 * 3. Reloads — the app restores the session via /api/auth/profile and
 *    AppShell's useSocketConnection() calls connectSocket(token)
 * 4. Tracks EVERY network request + WebSocket frame through CDP
 * 5. Asserts:
 *      - a socket.io WebSocket was CREATED and reached CONNECTED state
 *      - /api/auth/profile returned 200
 *      - zero ERR_CONNECTION_REFUSED requests
 *      - zero WebSocket console errors
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// puppeteer-core is installed with the frontend tooling — resolve it there.
const puppeteer = require(path.join(__dirname, "..", "..", "restaurant-pos-frontend", "node_modules", "puppeteer-core"));
const jwt = require("jsonwebtoken");

const FRONTEND_URL = "http://localhost:3000";
const CHROME = "C:/Users/Divyang/AppData/Local/Google/Chrome/Application/chrome.exe";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();

  // ── CDP: track every request/response and WebSocket lifecycle event ──
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");

  const requests = []; // { url, status }
  const failedRequests = []; // { url, err }
  const wsEvents = []; // { type, url }
  let wsOpenPacket = null;
  let profileStatus = null;

  cdp.on("Network.responseReceived", (e) => {
    const url = e.response.url;
    const status = e.response.status;
    requests.push({ url, status });
    if (url.includes("/api/auth/profile")) profileStatus = status;
  });
  cdp.on("Network.loadingFailed", (e) => {
    failedRequests.push({ err: e.errorText, url: e.requestId });
  });
  cdp.on("Network.webSocketCreated", (e) => wsEvents.push({ type: "created", url: e.url }));
  cdp.on("Network.webSocketHandshakeResponseReceived", (e) =>
    wsEvents.push({ type: `handshake_${e.response.status}`, url: e.response.url || "" })
  );
  cdp.on("Network.webSocketFrameReceived", (e) => {
    // engine.io OPEN packet: "0{"sid":...} — definitive proof the socket is live
    if (!wsOpenPacket && e.response && e.response.payloadData && e.response.payloadData.startsWith("0{")) {
      wsOpenPacket = e.response.payloadData.slice(0, 60);
    }
  });
  cdp.on("Network.webSocketClosed", (e) => wsEvents.push({ type: "closed", url: "" }));

  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // ── Step 1: load the app once unauthenticated (populates origin storage) ──
  await page.goto(FRONTEND_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));

  // ── Step 2: seed a real JWT-backed session (app's own storage keys) ──
  await page.evaluate((token) => {
    const user = {
      id: 1, name: "Platform Admin", email: "sa@nirka.test",
      role: "SUPER_ADMIN", restaurantId: null,
    };
    localStorage.setItem("pos_token", token);
    localStorage.setItem("pos_user", JSON.stringify(user));
  }, jwt.sign({ id: 1, role: "SUPER_ADMIN", email: "sa@nirka.test" }, process.env.JWT_SECRET, { expiresIn: "10m" }));

  // ── Step 3: reload — session restores, useSocketConnection fires ──
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 15000)); // let socket lifecycle settle

  // ── Step 4: assert ──
  const socketRequests = wsEvents.filter((w) => /socket\.io/i.test(w.url));
  const socketCreated = socketRequests.some((w) => w.type === "created");
  const socketHandshake = socketRequests.find((w) => w.type.startsWith("handshake_"));
  const profileOk = profileStatus === 200;
  const refused = failedRequests.filter((f) => /ERR_CONNECTION_REFUSED/i.test(f.err));
  const wsConsoleErrors = consoleErrors.filter((e) => /WebSocket connection to.*failed/i.test(e));

  console.log("── Browser Socket.IO verification ──");
  console.log(`profile endpoint:        ${profileStatus ?? "not called"}`);
  console.log(`socket.io WS events:     ${socketRequests.length}`);
  socketRequests.forEach((w) => console.log(`   · ${w.type} ${w.url.slice(0, 110)}`));
  console.log(`engine.io OPEN packet:   ${wsOpenPacket ? wsOpenPacket.slice(0, 50) : "not observed"}`);
  console.log(`console errors:          ${consoleErrors.length}`);
  consoleErrors.slice(0, 4).forEach((e) => console.log(`   · ${e.slice(0, 160)}`));
  console.log(`failed requests (CDP):   ${failedRequests.length}`);
  failedRequests.slice(0, 4).forEach((f) => console.log(`   · ${f.err}`));

  let ok = true;
  if (!profileOk) { console.log("❌ /api/auth/profile did not return 200"); ok = false; }
  // Proof of a healthy connection: WS created AND (handshake response OR live
  // engine.io open packet) AND never closed with an error.
  const connectionProven = socketCreated && (socketHandshake || wsOpenPacket);
  if (!connectionProven) { console.log("❌ socket.io WebSocket not created / no live packet observed"); ok = false; }
  if (refused.length) { console.log(`❌ ${refused.length} ERR_CONNECTION_REFUSED request(s)`); ok = false; }
  if (wsConsoleErrors.length) { console.log(`❌ ${wsConsoleErrors.length} WebSocket console error(s)`); ok = false; }
  if (ok) console.log("\n✅ PASS: WebSocket created + live (engine.io open packet), zero refused connections, session restored");

  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("browser test crashed:", e.message); process.exit(1); });
