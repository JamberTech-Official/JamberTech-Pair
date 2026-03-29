// Polyfill crypto for older Node versions
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto").webcrypto;
}

const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, "pair_sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activeSessions = new Map();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cleanDir(dir) {
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
function encodeSession(dir) {
  try {
    return "DJ~" + Buffer.from(fs.readFileSync(path.join(dir, "creds.json"), "utf-8")).toString("base64");
  } catch { return null; }
}

async function createSocket(sessionDir) {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); }
  catch { version = [2, 3000, 1015901307]; }

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    printQRInTerminal: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
  sock.ev.on("creds.update", saveCreds);
  return sock;
}

// ── POST /qr — Start QR code session ──────────────────────────────────────
app.post("/qr", async (req, res) => {
  const token = "qr_" + Date.now();
  const sessionDir = path.join(SESSIONS_DIR, token);
  cleanDir(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const sock = await createSocket(sessionDir);
    const entry = { sock, sessionDir, connected: false, sessionID: null, qrDataUrl: null, qrExpired: false };
    activeSessions.set(token, entry);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      const e = activeSessions.get(token);
      if (!e) return;

      // New QR received — convert to image
      if (qr) {
        try {
          e.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          e.qrExpired = false;
        } catch {}
      }

      if (connection === "open") {
        await sleep(2000);
        const encoded = encodeSession(sessionDir);
        if (encoded) { e.connected = true; e.sessionID = encoded; }
        try { sock.end(); } catch {}
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.timedOut) { e.qrExpired = true; }
        if (code === DisconnectReason.loggedOut || code === 401) {
          activeSessions.delete(token); cleanDir(sessionDir);
        }
      }
    });

    // Wait up to 10s for first QR
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const e = activeSessions.get(token);
      if (e?.qrDataUrl) return res.json({ sessionId: token, qr: e.qrDataUrl });
    }

    // Cleanup if QR never came
    try { sock.end(); } catch {}
    activeSessions.delete(token); cleanDir(sessionDir);
    return res.status(500).json({ error: "QR generate nahi hua. Dobara try karein." });

  } catch (err) {
    activeSessions.delete(token); cleanDir(sessionDir);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
});

// ── GET /qr/:token — Poll for fresh QR or session ─────────────────────────
app.get("/qr/:token", (req, res) => {
  const e = activeSessions.get(req.params.token);
  if (!e) return res.json({ status: "expired" });
  if (e.connected && e.sessionID) {
    const sid = e.sessionID;
    activeSessions.delete(req.params.token); cleanDir(e.sessionDir);
    return res.json({ status: "connected", sessionID: sid });
  }
  if (e.qrExpired) return res.json({ status: "expired" });
  return res.json({ status: "waiting", qr: e.qrDataUrl });
});

// ── POST /pair — Pair code method ──────────────────────────────────────────
app.post("/pair", async (req, res) => {
  let { number } = req.body;
  if (!number) return res.status(400).json({ error: "Phone number required" });
  number = number.replace(/[^0-9]/g, "");
  if (number.length < 7) return res.status(400).json({ error: "Invalid number" });

  const token = "pair_" + Date.now();
  const sessionDir = path.join(SESSIONS_DIR, token);
  cleanDir(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const sock = await createSocket(sessionDir);
    const entry = { sock, sessionDir, connected: false, sessionID: null };
    activeSessions.set(token, entry);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      const e = activeSessions.get(token);
      if (!e) return;
      if (connection === "open") {
        await sleep(2000);
        const encoded = encodeSession(sessionDir);
        if (encoded) { e.connected = true; e.sessionID = encoded; }
        try { sock.end(); } catch {}
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === 401) {
          activeSessions.delete(token); cleanDir(sessionDir);
        }
      }
    });

    await sleep(3000);

    let pairCode;
    try {
      pairCode = await sock.requestPairingCode(number);
      pairCode = pairCode?.replace(/(.{4})/g, "$1-").slice(0, -1) || pairCode;
    } catch (err) {
      try { sock.end(); } catch {}
      activeSessions.delete(token); cleanDir(sessionDir);
      return res.status(500).json({ error: "Pair code error: " + err.message });
    }

    setTimeout(() => {
      const e = activeSessions.get(token);
      if (e && !e.connected) { try { e.sock.end(); } catch {}; activeSessions.delete(token); cleanDir(sessionDir); }
    }, 5 * 60 * 1000);

    return res.json({ pairCode, sessionId: token });
  } catch (err) {
    activeSessions.delete(token); cleanDir(sessionDir);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
});

// ── GET /status/:token ─────────────────────────────────────────────────────
app.get("/status/:token", (req, res) => {
  const e = activeSessions.get(req.params.token);
  if (!e) return res.json({ status: "expired" });
  if (e.connected && e.sessionID) {
    const sid = e.sessionID;
    activeSessions.delete(req.params.token); cleanDir(e.sessionDir);
    return res.json({ status: "connected", sessionID: sid });
  }
  res.json({ status: "waiting" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`[JamberTech Pair] Port ${PORT}`));
