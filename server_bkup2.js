import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import express from "express";
import QRCode from "qrcode";
import P from "pino";
import fetch from "node-fetch";
import cors from "cors";

/* =========================
   BASIC SETUP
========================= */
const app = express();
app.use(express.json());
app.use(cors());

let sock;
let latestQR = null;

/* =========================
   CONFIG
========================= */
const N8N_WEBHOOK_URL =
  "https://pinjarin8n.app.n8n.cloud/webhook/whatsapp-rag";

const BOT_NAMES = [
  "yesbank bot",
  "yes bank bot",
  "ai response",
];

const BOT_NUMBER_FALLBACKS = [
  "65559051915364",
];

const BOT_COMMANDS = ["/bot", "!bot"];

/* =========================
   QUEUE SYSTEM (FIFO)
========================= */
const chatQueues = new Map();
const chatBusy = new Set();

async function processInQueue(remoteJid, taskFn) {
  const lastPromise = chatQueues.get(remoteJid) || Promise.resolve();

  const nextPromise = lastPromise
    .catch(() => {})
    .then(taskFn)
    .finally(() => {
      if (chatQueues.get(remoteJid) === nextPromise) {
        chatQueues.delete(remoteJid);
        chatBusy.delete(remoteJid);
      }
    });

  chatQueues.set(remoteJid, nextPromise);
  return nextPromise;
}

/* =========================
   START WHATSAPP
========================= */
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Windows", "Chrome", "10"],
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = await QRCode.toDataURL(qr);
      console.log("📲 Scan QR → http://localhost:3000/qr");
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Disconnected:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔁 Reconnecting in 2s...");
        setTimeout(() => startWhatsApp(), 2000);
      } else {
        console.log("🚪 Logged out. Delete auth folder.");
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED");
      latestQR = null;
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith("@g.us");

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      "";

    if (!text) return;

    const lowerText = text.toLowerCase();
    console.log("🔍 Incoming:", lowerText);

    const nameMentioned = BOT_NAMES.some(name =>
      lowerText.includes("@" + name)
    );

    const numberMentioned = BOT_NUMBER_FALLBACKS.some(num =>
      lowerText.includes("@" + num)
    );

    const commandTriggered = BOT_COMMANDS.some(cmd =>
      lowerText.startsWith(cmd)
    );

    const isBotTriggered =
      nameMentioned || numberMentioned || commandTriggered;

    if (isGroup && !isBotTriggered) return;

    let cleanText = text;
    cleanText = cleanText.replace(/@\w+/g, "");

    BOT_COMMANDS.forEach(cmd => {
      const regex = new RegExp("^" + cmd, "i");
      cleanText = cleanText.replace(regex, "");
    });

    cleanText = cleanText.trim();
    if (!cleanText) return;

    if (chatBusy.has(remoteJid)) {
      await sock.sendMessage(remoteJid, {
        text: "⏳ Please wait...",
      });
    }

    chatBusy.add(remoteJid);

    await processInQueue(remoteJid, async () => {
      try {
        try {
          await sock.sendPresenceUpdate("composing", remoteJid);
        } catch {}

        const response = await fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: cleanText,
            isGroup,
          }),
        });

        let data = {};
        try {
          data = await response.json();
        } catch {
          throw new Error("Invalid JSON from webhook");
        }

        const replyText = data.reply || data.output;

        await sock.sendMessage(remoteJid, {
          text: replyText || "🤖 No response generated.",
        });
      } catch (err) {
        console.error("❌ Error:", err.message);
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Something went wrong.",
        });
      }
    });
  });
}

startWhatsApp();

/* =========================
   EXPRESS ROUTES
========================= */

// QR Viewer
app.get("/qr", (req, res) => {
  if (!latestQR) {
    return res.send("✅ WhatsApp already connected");
  }
  res.send(`<img src="${latestQR}" />`);
});

/* =========================
   PAIRING UI (Browser)
========================= */
app.get("/pair-ui", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>WhatsApp Pairing</title>
        <style>
          body {
            font-family: Arial;
            background: #0f172a;
            color: white;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
          }
          .card {
            background: #1e293b;
            padding: 30px;
            border-radius: 12px;
            text-align: center;
            width: 350px;
          }
          input {
            width: 100%;
            padding: 10px;
            margin-top: 10px;
            border-radius: 6px;
            border: none;
          }
          button {
            margin-top: 15px;
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            background: #22c55e;
            font-weight: bold;
            cursor: pointer;
          }
          .code {
            margin-top: 20px;
            font-size: 22px;
            color: #38bdf8;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>📱 Pair WhatsApp</h2>
          <input id="number" placeholder="918551089688"/>
          <button onclick="getCode()">Generate Code</button>
          <div class="code" id="code"></div>
        </div>

        <script>
          async function getCode() {
            const number = document.getElementById("number").value;
            const codeDiv = document.getElementById("code");
            codeDiv.innerHTML = "⏳ Generating...";

            try {
              const res = await fetch("/pair-code?number=" + number);
              const data = await res.json();
              codeDiv.innerHTML = data.pairingCode
                ? "🔑 " + data.pairingCode
                : "❌ " + (data.error || "Failed");
            } catch {
              codeDiv.innerHTML = "❌ Server Error";
            }
          }
        </script>
      </body>
    </html>
  `);
});

/* =========================
   PAIRING CODE GENERATOR
========================= */
app.get("/pair-code", async (req, res) => {
  try {
    if (!sock) return res.json({ error: "Socket not ready" });

    const number = req.query.number;
    if (!number) return res.json({ error: "Number missing" });

    const cleanNumber = number.replace(/\D/g, "");
    const code = await sock.requestPairingCode(cleanNumber);

    res.json({ pairingCode: code });
  } catch (err) {
    res.json({ error: err.message });
  }
});


// MAIN DASHBOARD UI

app.get("/", (req, res) => {
  res.send(`
  <html>
    <head>
      <title>WhatsApp Bot Dashboard</title>
      <style>
        body {
          margin: 0;
          font-family: Arial;
          background: #0f172a;
          color: white;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
        }
        .card {
          background: #1e293b;
          padding: 25px;
          border-radius: 14px;
          width: 380px;
          text-align: center;
          box-shadow: 0 0 25px rgba(0,0,0,0.6);
        }
        h2 { margin-bottom: 5px; }
        .status {
          margin: 10px 0;
          font-weight: bold;
        }
        .connected { color: #22c55e; }
        .disconnected { color: #ef4444; }

        img {
          margin-top: 15px;
          width: 220px;
          border-radius: 10px;
          background: white;
          padding: 10px;
        }

        input {
          width: 100%;
          padding: 10px;
          margin-top: 10px;
          border-radius: 6px;
          border: none;
        }

        button {
          margin-top: 12px;
          padding: 10px 18px;
          border-radius: 6px;
          border: none;
          background: #38bdf8;
          cursor: pointer;
          font-weight: bold;
        }

        button:hover { background: #0ea5e9; }

        .toggle {
          margin-top: 15px;
          cursor: pointer;
          color: #38bdf8;
          font-size: 14px;
        }

        .code {
          margin-top: 15px;
          font-size: 22px;
          color: #22c55e;
          font-weight: bold;
        }
      </style>
    </head>

    <body>
      <div class="card">
        <h2>🤖 WhatsApp Bot</h2>
        <div id="status" class="status">Checking...</div>

        <div id="qr-section">
          <img id="qr" style="display:none"/>
        </div>

        <div id="pair-section" style="display:none">
          <input id="number" placeholder="Enter number (9185XXXXXX)" />
          <button onclick="generateCode()">Generate Pairing Code</button>
          <div id="pair-code" class="code"></div>
        </div>

        <div class="toggle" onclick="toggleMode()">
          🔁 Switch to <span id="mode-label">Pairing Code</span>
        </div>
      </div>

      <script>
        let pairingMode = false;

        function toggleMode() {
          pairingMode = !pairingMode;

          document.getElementById("qr-section").style.display =
            pairingMode ? "none" : "block";

          document.getElementById("pair-section").style.display =
            pairingMode ? "block" : "none";

          document.getElementById("mode-label").innerText =
            pairingMode ? "QR Code" : "Pairing Code";
        }

        async function refreshStatus() {
          try {
            const res = await fetch("/status");
            const data = await res.json();

            const statusEl = document.getElementById("status");
            const qrImg = document.getElementById("qr");

            if (data.connected) {
              statusEl.innerHTML =
                "✅ Connected as <br><small>" + data.user + "</small>";
              statusEl.className = "status connected";
              qrImg.style.display = "none";
            } else {
              statusEl.innerHTML = "❌ Not Connected";
              statusEl.className = "status disconnected";

              if (data.qr) {
                qrImg.src = data.qr;
                qrImg.style.display = "block";
              }
            }
          } catch {
            document.getElementById("status").innerHTML =
              "⚠️ Server offline";
          }
        }

        async function generateCode() {
          const number = document.getElementById("number").value;
          const codeEl = document.getElementById("pair-code");

          codeEl.innerHTML = "⏳ Generating...";

          try {
            const res = await fetch("/pair-code?number=" + number);
            const data = await res.json();

            codeEl.innerHTML = data.pairingCode
              ? "🔑 " + data.pairingCode
              : "❌ " + (data.error || "Failed");
          } catch {
            codeEl.innerHTML = "❌ Error";
          }
        }

        refreshStatus();
        setInterval(refreshStatus, 3000);
      </script>
    </body>
  </html>
  `);
});


// Send message
app.post("/send", async (req, res) => {
  try {
    if (!sock)
      return res.status(503).json({ error: "WhatsApp not connected" });

    const { number, message } = req.body;
    if (!number || !message)
      return res.status(400).json({ error: "number & message required" });

    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: message });

    res.json({ status: "Message sent" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// CONNECTION STATUS API

app.get("/status", (req, res) => {
  try {
    const isConnected = !!sock?.user;

    res.json({
      connected: isConnected,
      user: sock?.user?.id || null,
      qr: latestQR,
    });
  } catch (err) {
    res.json({
      connected: false,
      error: err.message,
    });
  }
});


/* =========================
   START SERVER
========================= */
app.listen(3000, () => {
  console.log("🚀 Server running → http://localhost:3000");
  console.log("🌐 Pairing UI → http://localhost:3000/pair-ui");
});
