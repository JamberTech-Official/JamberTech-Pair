// Polyfill crypto for older Node versions
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

// Store active sessions: token → { sock, sessionDir, connected, sessionID }
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

// ── POST /pair ─────────────────────────────────────────────────────────────
app.post("/pair", async (req, res) => {
  let { number } = req.body;
  if (!number) return res.status(400).json({ error: "Phone number required" });

  // Clean number: only digits
  number = number.replace(/[^0-9]/g, "");
  if (number.length < 7) return res.status(400).json({ error: "Invalid number format" });

  const token = "jt_" + Date.now();
  const sessionDir = path.join(SESSIONS_DIR, token);
  cleanDir(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  let sock;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); }
    catch { version = [2, 3000, 1015901307]; }

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      // This browser config is proven to work for pairing
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      printQRInTerminal: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 10_000,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    const entry = {
      sock,
      sessionDir,
      number,
      connected: false,
      sessionID: null,
      pairCodeSent: false,
    };
    activeSessions.set(token, entry);

    sock.ev.on("creds.update", saveCreds);

    // ── Single unified connection handler ──────────────────────────────
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      const e = activeSessions.get(token);
      if (!e) return;

      if (connection === "open") {
        // User entered code — pairing complete — save session
        await sleep(2000);
        const encoded = encodeSession(sessionDir);
        if (encoded) {
          e.connected = true;
          e.sessionID = encoded;
        }
        try { sock.end(); } catch {}
      }

      if (connection === "close") {
        const status = lastDisconnect?.error?.output?.statusCode;
        // 401 or loggedOut means session is dead
        if (status === DisconnectReason.loggedOut || status === 401) {
          activeSessions.delete(token);
          cleanDir(sessionDir);
        }
      }
    });

    // ── Wait 3 seconds for Baileys to fully handshake with WhatsApp ────
    await sleep(3000);

    // ── Request pairing code ───────────────────────────────────────────
    let pairCode;
    try {
      pairCode = await sock.requestPairingCode(number);
      // Format as XXXX-XXXX
      pairCode = pairCode?.replace(/(.{4})/g, "$1-").slice(0, -1) || pairCode;
    } catch (err) {
      try { sock.end(); } catch {}
      activeSessions.delete(token);
      cleanDir(sessionDir);
      return res.status(500).json({ error: "Code generate nahi hua: " + err.message });
    }

    // ── Auto-cleanup after 5 mins if not paired ────────────────────────
    setTimeout(() => {
      const e = activeSessions.get(token);
      if (e && !e.connected) {
        try { e.sock.end(); } catch {}
        activeSessions.delete(token);
        cleanDir(sessionDir);
      }
    }, 5 * 60 * 1000);

    return res.json({ pairCode, sessionId: token });

  } catch (err) {
    try { if (sock) sock.end(); } catch {}
    activeSessions.delete(token);
    cleanDir(sessionDir);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
});

// ── GET /status/:token ─────────────────────────────────────────────────────
app.get("/status/:token", (req, res) => {
  const e = activeSessions.get(req.params.token);
  if (!e) return res.json({ status: "expired" });
  if (e.connected && e.sessionID) {
    const sid = e.sessionID;
    activeSessions.delete(req.params.token);
    cleanDir(e.sessionDir);
    return res.json({ status: "connected", sessionID: sid });
  }
  res.json({ status: "waiting" });
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "JamberTech Pair" }));

app.listen(PORT, () => console.log(`[JamberTech Pair] Port ${PORT}`));
