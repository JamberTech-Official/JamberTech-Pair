// Fix: crypto global for older Node.js versions
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto").webcrypto;
}

const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  number = number.replace(/[^0-9]/g, "");
  if (number.length < 7) return res.status(400).json({ error: "Invalid number" });

  const token = "jtpair_" + Date.now();
  const sessionDir = path.join(SESSIONS_DIR, token);
  cleanDir(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
    } catch {
      version = [2, 3000, 1015901307];
    }

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    // Track session
    activeSessions.set(token, {
      sock,
      sessionDir,
      number,
      connected: false,
      sessionID: null,
    });

    // Connection listener
    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      const entry = activeSessions.get(token);
      if (!entry) return;

      if (connection === "open") {
        await sleep(2000);
        const encoded = encodeSession(sessionDir);
        if (encoded) {
          entry.connected = true;
          entry.sessionID = encoded;
        }
        try { sock.ws.close(); } catch {}
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === 401) {
          activeSessions.delete(token);
          cleanDir(sessionDir);
        }
      }
    });

    // ── Official Baileys way: call requestPairingCode right after socket ──
    // Only if not already registered (fresh session)
    if (!state.creds.registered) {
      await sleep(1500);
      let pairCode;
      try {
        pairCode = await sock.requestPairingCode(number);
        pairCode = pairCode?.match(/.{1,4}/g)?.join("-") || pairCode;
      } catch (err) {
        try { sock.ws.close(); } catch {}
        activeSessions.delete(token);
        cleanDir(sessionDir);
        return res.status(500).json({ error: "Pair code error: " + err.message });
      }

      // Auto cleanup after 5 min
      setTimeout(() => {
        const entry = activeSessions.get(token);
        if (entry && !entry.connected) {
          try { entry.sock.ws.close(); } catch {}
          activeSessions.delete(token);
          cleanDir(sessionDir);
        }
      }, 5 * 60 * 1000);

      return res.json({ pairCode, sessionId: token });
    } else {
      // Already registered — just return status
      try { sock.ws.close(); } catch {}
      activeSessions.delete(token);
      cleanDir(sessionDir);
      return res.status(400).json({ error: "Session already exists. Clear and retry." });
    }

  } catch (err) {
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

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "JamberTech Pair" });
});

app.listen(PORT, () => {
  console.log(`[JamberTech Pair] Running on port ${PORT}`);
});
