import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

import express from "express";
import QRCode from "qrcode";
import P from "pino";
import fetch from "node-fetch";
import cors from "cors";
import { createWorker } from "tesseract.js";

/* =========================
   BASIC SETUP
========================= */
const app = express();
app.use(express.json());
app.use(cors());

let sock;
let latestQR = null;
let ocrWorker;
let pairingCode = null;
let isConnecting = false;

/* =========================
   CONFIG
========================= */
const N8N_WEBHOOK_URL = "https://pinjarin8n.app.n8n.cloud/webhook/whatsapp-rag";

const BOT_NAMES = ["yesbank bot", "yes bank bot", "ai response"];
const BOT_NUMBER_FALLBACKS = ["65559051915364"];
const BOT_COMMANDS = ["/bot", "!bot"];

/* =========================
   MEMORY STORES
========================= */
const chatQueues = new Map();
const chatBusy = new Set();
const conversationState = new Map();

/* =========================
   LANGUAGE DETECTION
========================= */
function detectLanguage(text) {
  const hindiRegex = /[\u0900-\u097F]/;
  return hindiRegex.test(text) ? "hi" : "en";
}

/* =========================
   FIFO QUEUE
========================= */
async function processInQueue(remoteJid, taskFn) {
  const lastPromise = chatQueues.get(remoteJid) || Promise.resolve();

  const nextPromise = lastPromise
    .catch(() => {})
    .then(taskFn)
    .finally(() => {
      if (chatQueues.get(remoteJid) === nextPromise) {
        chatQueues.delete(remoteJid);
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

  try {
    if (!ocrWorker) {
      console.log("🔤 Initializing OCR Worker...");
      ocrWorker = await createWorker("eng+hin");
      await ocrWorker.setParameters({ tessedit_pageseg_mode: 6 });
    }
  } catch (err) {
    console.log("❌ OCR Worker Init Failed:", err.message);
  }

  sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Windows", "Chrome", "10"],
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
      pairingCode = null;
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
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    const lowerText = text.toLowerCase().trim();

    const isYes = /^(yes|ha|haan|ok|okay|sure|hmm)$/i.test(lowerText);
    const isNo = /^(no|nahi|na|cancel)$/i.test(lowerText);

    /* =========================
       CONFIRMATION HANDLING
    ========================= */
    if (conversationState.has(remoteJid)) {
      const state = conversationState.get(remoteJid);

      if (isYes) {
        conversationState.delete(remoteJid);
        console.log("✅ User confirmed");

        await processInQueue(remoteJid, async () => {
          chatBusy.add(remoteJid);

          try {
            await sock.sendPresenceUpdate("composing", remoteJid);

            const response = await fetch(N8N_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: state.originalQuestion,
                type: "text",
                language: detectLanguage(state.originalQuestion),
                isGroup,
                confirmed: true,
              }),
            });

            if (!response.ok)
              throw new Error(`Webhook HTTP ${response.status}`);

            const raw = await response.text();
            const data = raw ? JSON.parse(raw) : {};

            await sock.sendMessage(remoteJid, {
              text: data.reply || data.output || "🤖 No response.",
            });
          } catch {
            await sock.sendMessage(remoteJid, {
              text: "⚠️ Confirmation failed.",
            });
          } finally {
            chatBusy.delete(remoteJid);
          }
        });

        return;
      }

      if (isNo) {
        conversationState.delete(remoteJid);

        await sock.sendMessage(remoteJid, {
          text: "👍 Okay, cancelled.",
        });

        return;
      }

      /* ✅ AUTO CLEAR IF NEW QUERY */
      if (!isYes && !isNo && text.trim().length > 3) {
        console.log("🧹 New query detected → Clearing old confirmation");
        conversationState.delete(remoteJid);
      }
    }

    /* =========================
       IMAGE HANDLING
    ========================= */
    if (msg.message.imageMessage) {
      if (chatBusy.has(remoteJid)) {
        await sock.sendMessage(remoteJid, {
          text: "⏳ Processing previous request...",
        });
        return;
      }

      await processInQueue(remoteJid, async () => {
        chatBusy.add(remoteJid);

        try {
          await sock.sendPresenceUpdate("composing", remoteJid);

          const buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: P({ level: "silent" }) },
          );

          const {
            data: { text },
          } = await ocrWorker.recognize(buffer);

          const extractedText = text.trim();

          if (!extractedText) {
            await sock.sendMessage(remoteJid, {
              text: "⚠️ No readable text found in image.",
            });
            return;
          }

          const response = await fetch(N8N_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: extractedText,
              type: "image",
              language: detectLanguage(extractedText),
              isGroup,
            }),
          });

          if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);

          const raw = await response.text();
          const data = raw ? JSON.parse(raw) : {};

          await sock.sendMessage(remoteJid, {
            text: data.reply || data.output || "🤖 No response.",
          });
        } catch {
          await sock.sendMessage(remoteJid, {
            text: "⚠️ Image OCR failed.",
          });
        } finally {
          chatBusy.delete(remoteJid);
        }
      });

      return;
    }

    if (!text) return;

    /* =========================
       TEXT HANDLING
    ========================= */
    const lowerFullText = text.toLowerCase();

    const nameMentioned = BOT_NAMES.some((name) =>
      lowerFullText.includes("@" + name),
    );

    const numberMentioned = BOT_NUMBER_FALLBACKS.some((num) =>
      lowerFullText.includes("@" + num),
    );

    const commandTriggered = BOT_COMMANDS.some((cmd) =>
      lowerFullText.startsWith(cmd),
    );

    const isBotTriggered = nameMentioned || numberMentioned || commandTriggered;

    if (isGroup && !isBotTriggered) return;

    let cleanText = text.replace(/@\S+/g, "");
    BOT_COMMANDS.forEach((cmd) => {
      cleanText = cleanText.replace(new RegExp("^" + cmd, "i"), "");
    });

    cleanText = cleanText.trim();
    if (!cleanText) return;

    if (chatBusy.has(remoteJid)) {
      await sock.sendMessage(remoteJid, {
        text: "⏳ Processing previous request...",
      });
      return;
    }

    await processInQueue(remoteJid, async () => {
      chatBusy.add(remoteJid);

      try {
        await sock.sendPresenceUpdate("composing", remoteJid);

        const response = await fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: cleanText,
            type: "text",
            language: detectLanguage(cleanText),
            isGroup,
          }),
        });

        if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);

        const raw = await response.text();
        const data = raw ? JSON.parse(raw) : {};

        const botReply =
          data.reply || data.output || "🤖 No response generated.";

        if (
          botReply.toLowerCase().includes("would you like") ||
          botReply.toLowerCase().includes("do you want") ||
          botReply.toLowerCase().includes("should i") ||
          botReply.toLowerCase().includes("can i")
        ) {
          conversationState.set(remoteJid, {
            originalQuestion: cleanText,
          });

          console.log("🧠 Confirmation state saved");
        }

        await sock.sendMessage(remoteJid, { text: botReply });
      } catch {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Something went wrong.",
        });
      } finally {
        chatBusy.delete(remoteJid);
      }
    });
  });
}

startWhatsApp();

/* =========================
   ROUTES
========================= */

app.get("/status", (req, res) => {
  res.json({
    connected: !!sock?.user,
    user: sock?.user?.id || null,
  });
});

app.get("/qr", (req, res) => {
  if (sock?.user) return res.send("✅ Already connected");
  if (!latestQR) return res.send("⏳ QR not generated yet...");
  res.send(`<img src="${latestQR}" width="250"/>`);
});

app.post("/pair", async (req, res) => {
  try {
    const { number } = req.body;

    if (!number) return res.status(400).json({ error: "Number required" });

    if (sock?.user) return res.json({ message: "Already connected" });

    pairingCode = await sock.requestPairingCode(number);

    res.json({ success: true, pairingCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   PAIR UI
========================= */
app.get("/pair-ui", (req, res) => {
  res.send(`
    <h2>📲 WhatsApp Connection</h2>

    <h3>Scan QR</h3>
    <iframe src="/qr" width="260" height="260"></iframe>

    <h3>OR Pair via Mobile Number</h3>
    <input id="number" placeholder="919876543210"/>
    <button id="pairBtn" onclick="pair()">Get Pairing Code</button>

    <h3 id="status"></h3>

    <pre id="result"></pre>

    <script>
      async function checkStatus() {
        const res = await fetch('/status');
        const data = await res.json();

        const btn = document.getElementById('pairBtn');
        const status = document.getElementById('status');

        if (data.connected) {
          btn.disabled = true;
          btn.innerText = "✅ Connected";
          status.innerText = "Connected as: " + data.user;
        } else {
          btn.disabled = false;
          btn.innerText = "Get Pairing Code";
          status.innerText = "❌ Not Connected";
        }
      }

      async function pair() {
        const number = document.getElementById("number").value;

        const res = await fetch("/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ number })
        });

        const data = await res.json();
        document.getElementById("result").innerText =
          JSON.stringify(data, null, 2);
      }

      checkStatus();
      setInterval(checkStatus, 2000); // auto refresh
    </script>
  `);
});

/* =========================
   CLEAN SHUTDOWN
========================= */
process.on("SIGINT", async () => {
  console.log("🛑 Shutting down...");
  if (ocrWorker) await ocrWorker.terminate();
  process.exit(0);
});

/* =========================
   START SERVER
========================= */
app.listen(3000, () => {
  console.log("🚀 Open → http://localhost:3000/pair-ui");
});
