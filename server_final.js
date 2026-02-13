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

const BOT_NAMES = ["yesbank bot", "yes bank bot", "ai response"];
const BOT_NUMBER_FALLBACKS = ["65559051915364"];
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
        console.log("🔁 Reconnecting...");
        setTimeout(() => startWhatsApp(), 2000);
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED:", sock.user?.id);
      latestQR = null;
    }
  });

  /* =========================
     INCOMING MESSAGES
  ========================= */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith("@g.us");

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    if (!text) return;

    const lowerText = text.toLowerCase();

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

    let cleanText = text.replace(/@\w+/g, "");

    BOT_COMMANDS.forEach(cmd => {
      cleanText = cleanText.replace(new RegExp("^" + cmd, "i"), "");
    });

    cleanText = cleanText.trim();
    if (!cleanText) return;

    if (chatBusy.has(remoteJid)) {
      await sock.sendMessage(remoteJid, { text: "⏳ Please wait..." });
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
          body: JSON.stringify({ message: cleanText, isGroup }),
        });

        const data = await response.json();
        const replyText = data.reply || data.output;

        await sock.sendMessage(remoteJid, {
          text: replyText || "🤖 No response generated.",
        });
      } catch (err) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Something went wrong.",
        });
      }
    });
  });
}

startWhatsApp();

/* =========================
   ROUTES
========================= */

// STATUS API
app.get("/status", (req, res) => {
  res.json({
    connected: !!sock?.user,
    user: sock?.user?.id || null,
  });
});

// LOGOUT
app.post("/logout", async (req, res) => {
  try {
    if (!sock) return res.json({ error: "Socket not ready" });

    await sock.logout();

    sock = null;
    latestQR = null;

    console.log("🚪 Logged out");

    res.json({ status: "Logged out" });

    setTimeout(() => startWhatsApp(), 1000);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// QR VIEWER
app.get("/qr", (req, res) => {
  if (sock?.user) return res.send("✅ Already connected");

  if (!latestQR) return res.send("⏳ QR not generated yet...");

  res.send(`<img src="${latestQR}" />`);
});

// PAIRING CODE
app.get("/pair-code", async (req, res) => {
  try {
    if (!sock) return res.json({ error: "Socket not ready" });

    if (sock.user) {
      return res.json({
        error: "Already connected",
        alreadyConnected: true,
      });
    }

    const number = req.query.number;
    if (!number) return res.json({ error: "Number missing" });

    const cleanNumber = number.replace(/\D/g, "");
    const code = await sock.requestPairingCode(cleanNumber);

    res.json({ pairingCode: code });
  } catch (err) {
    res.json({ error: err.message });
  }
});

/* =========================
   PAIR UI
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
          width: 350px;
          text-align: center;
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
          padding: 10px;
          border: none;
          border-radius: 6px;
          width: 100%;
          font-weight: bold;
          cursor: pointer;
        }
        .pair-btn { background: #22c55e; }
        .logout-btn { background: #ef4444; color: white; }
        .status { margin-top: 10px; font-weight: bold; }
        .success { color: #22c55e; }
        .error { color: #ef4444; }
        .code { margin-top: 15px; font-size: 20px; }
      </style>
    </head>

    <body>
      <div class="card">
        <h2>📱 WhatsApp Pairing</h2>

        <div id="status" class="status">Checking status...</div>

        <input id="number" placeholder="9185XXXXXXX"/>

        <button id="pairBtn" class="pair-btn" onclick="getCode()">
          🔑 Generate Pairing Code
        </button>

        <button class="logout-btn" onclick="logout()">
          🚪 Logout
        </button>

        <div id="code" class="code"></div>
      </div>

      <script>
        async function refreshStatus() {
          const res = await fetch("/status");
          const data = await res.json();

          const statusDiv = document.getElementById("status");
          const pairBtn = document.getElementById("pairBtn");

          if (data.connected) {
            statusDiv.innerHTML = "✅ Connected as <br><small>" + data.user + "</small>";
            statusDiv.className = "status success";
            pairBtn.disabled = true;
            pairBtn.style.opacity = 0.5;
          } else {
            statusDiv.innerHTML = "❌ Not Connected";
            statusDiv.className = "status error";
            pairBtn.disabled = false;
            pairBtn.style.opacity = 1;
          }
        }

        async function getCode() {
          const number = document.getElementById("number").value;
          const codeDiv = document.getElementById("code");

          codeDiv.innerHTML = "⏳ Generating...";
          codeDiv.className = "code";

          const res = await fetch("/pair-code?number=" + number);
          const data = await res.json();

          if (data.alreadyConnected) {
            codeDiv.innerHTML = "❌ Already connected";
            codeDiv.className = "code error";
            return;
          }

          if (data.pairingCode) {
            codeDiv.innerHTML = "🔑 " + data.pairingCode;
            codeDiv.className = "code success";
          } else {
            codeDiv.innerHTML = "❌ " + (data.error || "Failed");
            codeDiv.className = "code error";
          }
        }

        async function logout() {
          if (!confirm("Logout WhatsApp?")) return;

          await fetch("/logout", { method: "POST" });
          document.getElementById("code").innerHTML = "🔁 Restarting session...";
        }

        refreshStatus();
        setInterval(refreshStatus, 3000);
      </script>
    </body>
  </html>
  `);
});

/* =========================
   START SERVER
========================= */
app.listen(3000, () => {
  console.log("🚀 Server running → http://localhost:3000/pair-ui");
});
