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

// n8n webhook
const N8N_WEBHOOK_URL =
  "https://pinjarin8n.app.n8n.cloud/webhook/whatsapp-rag";

// Bot names
const BOT_NAMES = [
  "yesbank bot",
  "yes bank bot",
  "ai response",
];

// Fallback numbers
const BOT_NUMBER_FALLBACKS = [
  "65559051915364",
];

// Commands
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
   PAIRING CODE FUNCTION
========================= */
async function requestPairingCode(number) {
  if (!sock) throw new Error("Socket not ready");

  const code = await sock.requestPairingCode(number);
  return code;
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

  /* =========================
     CONNECTION STATUS
  ========================= */
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
        console.log("🚪 Logged out. Delete auth folder to relogin.");
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED");
      latestQR = null;
    }
  });

  /* =========================
     INCOMING MESSAGES
  ========================= */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message) return;
    if (msg.key.fromMe) return; // ignore own messages

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

    /* =========================
       BOT TRIGGER LOGIC
    ========================= */
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

    if (isGroup && !isBotTriggered) {
      console.log("⏭️ Group ignored (bot not triggered)");
      return;
    }

    /* =========================
       CLEAN MESSAGE
    ========================= */
    let cleanText = text;

    cleanText = cleanText.replace(/@\w+/g, ""); // safer mention removal

    BOT_COMMANDS.forEach(cmd => {
      const regex = new RegExp("^" + cmd, "i");
      cleanText = cleanText.replace(regex, "");
    });

    cleanText = cleanText.trim();
    if (!cleanText) return;

    console.log("🤖 Accepted query:", cleanText);

    /* =========================
       QUEUE + PLEASE WAIT
    ========================= */
    if (chatBusy.has(remoteJid)) {
      await sock.sendMessage(remoteJid, {
        text: "⏳ Please wait, processing previous request...",
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

        if (replyText) {
          await sock.sendMessage(remoteJid, { text: replyText });
        } else {
          await sock.sendMessage(remoteJid, {
            text: "🤖 No response generated.",
          });
        }
      } catch (err) {
        console.error("❌ n8n Error:", err.message);
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Something went wrong. Try again.",
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

// Pairing Code Route
app.post("/pair", async (req, res) => {
  try {
    if (!sock) {
      return res.status(503).json({ error: "Socket not ready" });
    }

    const { number } = req.body;

    if (!number) {
      return res.status(400).json({ error: "number required" });
    }

    const cleanNumber = number.replace(/\D/g, "");

    const code = await requestPairingCode(cleanNumber);

    res.json({
      status: "Pairing code generated",
      pairingCode: code,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send personal message
app.post("/send", async (req, res) => {
  try {
    if (!sock) {
      return res.status(503).json({ error: "WhatsApp not connected" });
    }

    const { number, message } = req.body;

    if (!number || !message) {
      return res.status(400).json({ error: "number & message required" });
    }

    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";

    await sock.sendMessage(jid, { text: message });

    res.json({ status: "Message sent successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send group message
app.post("/send-group", async (req, res) => {
  try {
    if (!sock) {
      return res.status(503).json({ error: "WhatsApp not connected" });
    }

    const { groupId, message } = req.body;

    if (!groupId || !message) {
      return res.status(400).json({ error: "groupId & message required" });
    }

    await sock.sendMessage(groupId, { text: message });

    res.json({ status: "Group message sent successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List groups
app.get("/groups", async (req, res) => {
  try {
    if (!sock) {
      return res.status(503).json({ error: "WhatsApp not connected" });
    }

    const groups = await sock.groupFetchAllParticipating();

    const result = Object.entries(groups).map(([id, data]) => ({
      id,
      name: data.subject,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
