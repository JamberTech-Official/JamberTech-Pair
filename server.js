// JamberTech Pair v3.0 — WhatsApp Session Generator
// Based on @whiskeysockets/baileys v7
// Supports: QR Code + Pair Code methods

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
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, "pair_sessions");
if (!fs.existsSync(SESSIONS_DIR))
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activeSessions = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function encodeSession(dir) {
  try {
    const credsPath = path.join(dir, "creds.json");
    if (!fs.existsSync(credsPath)) return null;
    const raw = fs.readFileSync(credsPath, "utf-8");
    return "DJ~" + Buffer.from(raw).toString("base64");
  } catch (_) {
    return null;
  }
}

async function getVersion() {
  try {
    return (await fetchLatestBaileysVersion()).version;
  } catch (_) {
    return [2, 3000, 1015901307];
  }
}

// ── POST /pair — Pair Code Method ──
app.post("/pair", async (req, res) => {
  let { number } = req.body;
  if (!number)
    return res.status(400).json({ error: "Phone number required" });

  number = number.replace(/[^0-9]/g, "");
  if (number.length < 10)
    return res.status(400).json({
      error: "Invalid number — use international format (e.g. 923001234567)",
    });

  const token = "pair_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const sessionDir = path.join(SESSIONS_DIR, token);
  cleanDir(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  const logger = pino({ level: "silent" });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const version = await getVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ["Mac OS", "Chrome", "14.4.1"],
      printQRInTerminal: false,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 10000,
      connectTimeoutMs: 60000,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    const entry = { sock, sessionDir, connected: false, sessionID: null };
    activeSessions.set(token, entry);
    sock.ev.on("creds.update", saveCreds);

    let pairCodeRequested = false;
    let pairCodeValue = null;
    let pairCodeError = null;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const e = activeSessions.get(token);
      if (!e) return;

      if (
        !pairCodeRequested &&
        !sock.authState.creds.registered &&
        !!qr
      ) {
        pairCodeRequested = true;
        try {
          await sleep(3000);
          let code = await sock.requestPairingCode(number);
          if (code) {
            code = code.replace(/(.{4})/g, "$1-").slice(0, -1);
          }
          pairCodeValue = code;
        } catch (err) {
          pairCodeError = err.message;
        }
      }

      if (connection === "open") {
        await sleep(2000);
        const encoded = encodeSession(sessionDir);
        if (encoded) {
          e.connected = true;
          e.sessionID = encoded;
        }
        try {
          sock.end();
        } catch (_) {}
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === 401) {
          activeSessions.delete(token);
          cleanDir(sessionDir);
        }
      }
    });

    // Wait up to 30s for pair code (3s delay + connection time)
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (pairCodeValue || pairCodeError) break;
    }

    if (!pairCodeValue) {
      try {
        sock.end();
      } catch (_) {}
      activeSessions.delete(token);
      cleanDir(sessionDir);
      return res.status(500).json({
        error: pairCodeError || "Pair code nahi aaya. Dobara try karein.",
      });
    }

    // Auto cleanup after 5 min
    setTimeout(() => {
      const e = activeSessions.get(token);
      if (e && !e.connected) {
        try {
          e.sock.end();
        } catch (_) {}
        activeSessions.delete(token);
        cleanDir(sessionDir);
      }
    }, 5 * 60 * 1000);

    return res.json({ pairCode: pairCodeValue, sessionId: token });
  } catch (err) {
    activeSessions.delete(token);
    cleanDir(sessionDir);
    return res
      .status(500)
      .json({ error: "Server error: " + err.message });
  }
});

// ── POST /qr — QR Code Method ──
app.post("/qr", async (_req, res) => {
  const token = "qr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const sessionDir = path.join(SESSIONS_DIR, token);
  cleanDir(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  const logger = pino({ level: "silent" });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const version = await getVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ["Mac OS", "Chrome", "14.4.1"],
      printQRInTerminal: false,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 10000,
      connectTimeoutMs: 60000,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    const entry = {
      sock,
      sessionDir,
      connected: false,
      sessionID: null,
      qrDataUrl: null,
      qrExpired: false,
    };
    activeSessions.set(token, entry);
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const e = activeSessions.get(token);
      if (!e) return;

      if (qr) {
        try {
          e.qrDataUrl = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
          });
          e.qrExpired = false;
        } catch (_) {}
      }

      if (connection === "open") {
        await sleep(2000);
        const encoded = encodeSession(sessionDir);
        if (encoded) {
          e.connected = true;
          e.sessionID = encoded;
        }
        try {
          sock.end();
        } catch (_) {}
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.timedOut) {
          const s = activeSessions.get(token);
          if (s) s.qrExpired = true;
          activeSessions.delete(token);
          cleanDir(sessionDir);
        }
        if (
          code === DisconnectReason.loggedOut ||
          code === 401 ||
          code === DisconnectReason.restartRequired
        ) {
          activeSessions.delete(token);
          cleanDir(sessionDir);
        }
      }
    });

    // Auto cleanup after 5 min for QR sessions
    setTimeout(() => {
      const e = activeSessions.get(token);
      if (e && !e.connected) {
        try {
          e.sock.end();
        } catch (_) {}
        activeSessions.delete(token);
        cleanDir(sessionDir);
      }
    }, 5 * 60 * 1000);

    // Wait up to 10s for first QR
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const e = activeSessions.get(token);
      if (e && e.qrDataUrl) {
        return res.json({ sessionId: token, qr: e.qrDataUrl });
      }
    }

    try {
      sock.end();
    } catch (_) {}
    activeSessions.delete(token);
    cleanDir(sessionDir);
    return res
      .status(500)
      .json({ error: "QR generate nahi hua. Dobara try karein." });
  } catch (err) {
    activeSessions.delete(token);
    cleanDir(sessionDir);
    return res
      .status(500)
      .json({ error: "Server error: " + err.message });
  }
});

// ── GET /qr/:token — Poll QR status ──
app.get("/qr/:token", (req, res) => {
  const e = activeSessions.get(req.params.token);
  if (!e) return res.json({ status: "expired" });

  if (e.connected && e.sessionID) {
    const sid = e.sessionID;
    activeSessions.delete(req.params.token);
    cleanDir(e.sessionDir);
    return res.json({ status: "connected", sessionID: sid });
  }

  if (e.qrExpired) {
    activeSessions.delete(req.params.token);
    cleanDir(e.sessionDir);
    return res.json({ status: "expired" });
  }
  return res.json({ status: "waiting", qr: e.qrDataUrl });
});

// ── GET /status/:token — Poll pair code status ──
app.get("/status/:token", (req, res) => {
  const e = activeSessions.get(req.params.token);
  if (!e) return res.json({ status: "expired" });

  if (e.connected && e.sessionID) {
    const sid = e.sessionID;
    activeSessions.delete(req.params.token);
    cleanDir(e.sessionDir);
    return res.json({ status: "connected", sessionID: sid });
  }

  return res.json({ status: "waiting" });
});

// ── Health ──
app.get("/health", (_req, res) =>
  res.json({ ok: true, v: "3.0.0" })
);

app.listen(PORT, () =>
  console.log(`[JamberTech Pair] Running on port ${PORT}`)
);
