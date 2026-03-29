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

function cleanDir(dir) {
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function encodeSession(dir) {
  try {
    const creds = fs.readFileSync(path.join(dir, "creds.json"), "utf-8");
    return "DJ~" + Buffer.from(creds).toString("base64");
  } catch { return null; }
}

// ── POST /pair ────────────────────────────────────────────────────────────────
app.post("/pair", async (req, res) => {
  let { number } = req.body;
  if (!number) return res.status(400).json({ error: "Phone number required" });

  number = number.replace(/[^0-9]/g, "");
  if (number.length < 7) return res.status(400).json({ error: "Invalid number" });

  const token = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const sessionDir = path.join(SESSIONS_DIR, token);
  cleanDir(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    activeSessions.set(token, {
      sock,
      sessionDir,
      number,
      connected: false,
      sessionID: null,
      pairCode: null,
    });

    // ── Wait for QR event — THEN request pair code ──────────────────────────
    let pairCodeSent = false;

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      const entry = activeSessions.get(token);
      if (!entry) return;

      // QR is emitted → request pair code instead
      if (qr && !pairCodeSent) {
        pairCodeSent = true;
        try {
          let code = await sock.requestPairingCode(number);
          code = code?.match(/.{1,4}/g)?.join("-") || code;
          entry.pairCode = code;
          activeSessions.set(token, entry);
        } catch (err) {
          entry.pairCode = "ERROR";
          activeSessions.set(token, entry);
        }
      }

      if (connection === "open") {
        await new Promise(r => setTimeout(r, 2000));
        const encoded = encodeSession(sessionDir);
        if (encoded) {
          entry.connected = true;
          entry.sessionID = encoded;
          activeSessions.set(token, entry);
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

    // Wait up to 15s for pair code to be generated
    let waited = 0;
    while (waited < 15000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
      const entry = activeSessions.get(token);
      if (entry?.pairCode && entry.pairCode !== "ERROR") {
        // Auto cleanup after 5 min
        setTimeout(() => {
          const e = activeSessions.get(token);
          if (e && !e.connected) {
            try { e.sock.ws.close(); } catch {}
            activeSessions.delete(token);
            cleanDir(sessionDir);
          }
        }, 5 * 60 * 1000);
        return res.json({ pairCode: entry.pairCode, sessionId: token });
      }
      if (entry?.pairCode === "ERROR") break;
    }

    // Timeout or error
    try { sock.ws.close(); } catch {}
    activeSessions.delete(token);
    cleanDir(sessionDir);
    return res.status(500).json({ error: "Pair code generate nahi hua. Dobara try karo!" });

  } catch (err) {
    cleanDir(sessionDir);
    activeSessions.delete(token);
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

app.listen(PORT, () => {
  console.log(`[JamberTech Pair] Running on port ${PORT}`);
});
