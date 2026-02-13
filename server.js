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

/* =========================
   CONFIG
========================= */
const N8N_WEBHOOK_URL = "https://pinjarin8n.app.n8n.cloud/webhook/whatsapp-rag";

const BOT_NAMES = ["yesbank bot", "yes bank bot", "ai response"];
const BOT_NUMBER_FALLBACKS = ["65559051915364"];
const BOT_COMMANDS = ["/bot", "!bot"];

/* =========================
   LANGUAGE DETECTION
========================= */
function detectLanguage(text) {
  const hindiRegex = /[\u0900-\u097F]/; // Hindi Unicode range
  if (hindiRegex.test(text)) return "hi";
  return "en";
}

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

  console.log("🔤 Initializing OCR Worker (eng + hin)...");
  ocrWorker = await createWorker("eng+hin");

  await ocrWorker.setParameters({
    tessedit_pageseg_mode: 6,
  });

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

    /* =========================
       IMAGE MESSAGE HANDLING
    ========================= */
    if (msg.message.imageMessage) {
      if (chatBusy.has(remoteJid)) {
        await sock.sendMessage(remoteJid, { text: "⏳ Please wait..." });
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

          console.log("🖼 Image received → Running OCR (worker)...");

          const {
            data: { text },
          } = await ocrWorker.recognize(buffer);

          const extractedText = text.trim();
          const detectedLang = detectLanguage(extractedText);

          console.log("📄 OCR Text:", extractedText);
          console.log("🌐 Detected Language:", detectedLang);

          const response = await fetch(N8N_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message:
                extractedText ||
                msg.message.imageMessage.caption ||
                "No text found in image",
              type: "image",
              language: detectedLang,
              isGroup,
            }),
          });

          if (!response.ok) {
  throw new Error(`Webhook HTTP ${response.status}`);
}

          let data;

          try {
            const raw = await response.text();
            console.log("📡 n8n Raw Response:", raw);

            data = raw ? JSON.parse(raw) : {};
          } catch (err) {
            console.log("❌ Webhook JSON Parse Error:", err.message);
            data = {};
          }

          await sock.sendMessage(remoteJid, {
            text: data.reply || data.output || "🤖 No response generated.",
          });
        } catch (err) {
          console.log("❌ OCR Error:", err.message);

          await sock.sendMessage(remoteJid, {
            text: "⚠️ Image OCR failed.",
          });
        } finally {
          chatBusy.delete(remoteJid);
        }
      });

      return;
    }

    /* =========================
       TEXT MESSAGE HANDLING
    ========================= */
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    if (!text) return;

    const lowerText = text.toLowerCase();

    const nameMentioned = BOT_NAMES.some((name) =>
      lowerText.includes("@" + name),
    );

    const numberMentioned = BOT_NUMBER_FALLBACKS.some((num) =>
      lowerText.includes("@" + num),
    );

    const commandTriggered = BOT_COMMANDS.some((cmd) =>
      lowerText.startsWith(cmd),
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
      await sock.sendMessage(remoteJid, { text: "⏳ Please wait..." });
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

        const data = await response.json();

        await sock.sendMessage(remoteJid, {
          text: data.reply || data.output || "🤖 No response generated.",
        });
      } catch (err) {
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
  res.send(`<img src="${latestQR}" />`);
});

/* =========================
   CLEAN SHUTDOWN
========================= */
process.on("SIGINT", async () => {
  console.log("🛑 Closing OCR Worker...");
  if (ocrWorker) await ocrWorker.terminate();
  process.exit(0);
});

/* =========================
   START SERVER
========================= */
app.listen(3000, () => {
  console.log("🚀 Server running → http://localhost:3000/pair-ui");
});
