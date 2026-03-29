const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  delay,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, "pair_sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activeSessions = new Map();

function cleanDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function encodeSession(dir) {
  try {
    const creds = fs.readFileSync(path.join(dir, "creds.json"), "utf-8");
    return "DJ~" + Buffer.from(creds).toString("base64");
  } catch {
    return null;
  }
}

// ── POST /pair ─────────────────────────────────────────────────────────────
app.post("/pair", async (req, res) => {
  let { number } = req.body;
  if (!number) return res.status(400).json({ error: "Phone number required" });

  // Sanitize number
  number = number.replace(/[^0-9]/g, "");
  if (number.length < 7) return res.status(400).json({ error: "Invalid number format" });

  const token = "jtpair_" + Date.now();
  const sessionDir = path.join(SESSIONS_DIR, token);
  cleanDir(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  let sock;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
    } catch {
      version = [2, 3000, 1015901307];
    }

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      printQRInTerminal: false,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 10000,
    });

    sock.ev.on("creds.update", saveCreds);

    // ── Request pair code right after socket is ready ──────────────────────
    let pairCode = null;
    let pairError = null;

    // Baileys emits 'connection.update' with qr when ready for auth
    // We intercept it and request a pairing code instead
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // When QR would appear → request pair code instead
      if (qr) {
        try {
          const code = await sock.requestPairingCode(number);
          pairCode = code?.replace(/(.{4})/g, "$1-").slice(0, -1) || code;
        } catch (err) {
          pairError = err.message;
        }
      }

      if (connection === "open") {
        await delay(2000);
        const encoded = encodeSession(sessionDir);
        const entry = activeSessions.get(token);
        if (entry && encoded) {
          entry.connected = true;
          entry.sessionID = encoded;
        }
        try { sock.ws.close(); } catch {}
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          activeSessions.delete(token);
          cleanDir(sessionDir);
        }
      }
    });

    // Store session entry
    activeSessions.set(token, {
      sock,
      sessionDir,
      number,
      connected: false,
      sessionID: null,
    });

    // ── Wait up to 20 seconds for pair code ──────────────────────────────
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await delay(500);
      if (pairCode) break;
      if (pairError) break;
    }

    if (!pairCode) {
      // Cleanup
      try { sock.ws.close(); } catch {}
      activeSessions.delete(token);
      cleanDir(sessionDir);
      return res.status(500).json({
        error: pairError || "Pair code nahi aaya. Dobara try karein.",
      });
    }

    // Auto cleanup after 5 minutes if not connected
    setTimeout(() => {
      const entry = activeSessions.get(token);
      if (entry && !entry.connected) {
        try { entry.sock.ws.close(); } catch {}
        activeSessions.delete(token);
        cleanDir(sessionDir);
      }
    }, 5 * 60 * 1000);

    return res.json({ pairCode, sessionId: token });

  } catch (err) {
    try { if (sock) sock.ws.close(); } catch {}
    activeSessions.delete(token);
    cleanDir(sessionDir);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
});

// ── GET /status/:sessionId ─────────────────────────────────────────────────
app.get("/status/:sessionId", (req, res) => {
  const entry = activeSessions.get(req.params.sessionId);
  if (!entry) return res.json({ status: "expired" });

  if (entry.connected && entry.sessionID) {
    const sid = entry.sessionID;
    activeSessions.delete(req.params.sessionId);
    cleanDir(entry.sessionDir);
    return res.json({ status: "connected", sessionID: sid });
  }

  res.json({ status: "waiting" });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "JamberTech Pair", version: "1.0.0" });
});

app.listen(PORT, () => {
  console.log(`[JamberTech Pair] Server running on port ${PORT}`);
});
