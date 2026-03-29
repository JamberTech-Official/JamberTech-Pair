# JamberTech Pair — WhatsApp Session ID Generator

Official WhatsApp Session Generator for [KHAN-MD Bot](https://github.com/JawadYT36/KHAN-MD).

Supports two pairing methods:
- **QR Code** — Scan from WhatsApp Linked Devices
- **Phone Number** — Get a pairing code, enter it in WhatsApp

## Features
- Dark WhatsApp-themed UI
- QR Code generation with auto-refresh
- Pair Code generation via phone number
- Session ID format: `DJ~<base64_creds>`
- Auto cleanup of expired sessions
- Built with [Baileys](https://github.com/WhiskeySockets/Baileys) (Multi-Device)

## Deploy

### Render
1. Fork this repo
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your fork
4. Build Command: `npm install`
5. Start Command: `node server.js`
6. Environment: Node 18+

### Railway / Heroku / VPS
```bash
git clone https://github.com/JamberTech-Official/JamberTech-Pair.git
cd JamberTech-Pair
npm install
node server.js
```

## Usage
1. Visit the deployed URL
2. Choose QR Code or Phone Number method
3. Follow the on-screen instructions
4. Copy the generated Session ID
5. Paste it in your KHAN-MD `settings.js` → `SESSION_ID` field
6. Deploy your KHAN-MD bot

## Tech Stack
- Node.js 18+
- Express.js
- @whiskeysockets/baileys
- qrcode (for QR generation)

## License
MIT

---
© 2026 JamberTech Official
