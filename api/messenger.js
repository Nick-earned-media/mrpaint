// Facebook Messenger webhook — bidirectional bot integration.
//
// Env vars:
//   MESSENGER_PAGE_ACCESS_TOKEN — from Facebook App → Messenger → Page token
//   MESSENGER_VERIFY_TOKEN      — any string you choose; entered in FB webhook setup
//   MESSENGER_APP_SECRET        — from Facebook App → Basic Settings → App Secret
//
// Setup:
//   1. developers.facebook.com → Create App → Business
//   2. Add Messenger product → connect MrPaint Page → generate Page Access Token
//   3. Webhooks → add URL: https://mrpaint.vercel.app/api/messenger
//   4. Subscribe to: messages, messaging_postbacks

const crypto = require("node:crypto");
const { waitUntil } = require("@vercel/functions");
const { runWithContext } = require("./whatsapp.js");

const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN || "";
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";
const APP_SECRET = process.env.MESSENGER_APP_SECRET || "";

module.exports = async function handler(req, res) {
  // ── Webhook verification (GET) ───────────────────────────────────────────
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  // ── Signature verification ───────────────────────────────────────────────
  const rawBody = await getRawBody(req);

  if (!verifySignature(req.headers, rawBody)) {
    return res.status(401).end("Unauthorized");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).end("Bad JSON");
  }

  // Ack immediately — Facebook requires a 200 within 20s
  res.status(200).end("EVENT_RECEIVED");

  if (payload.object !== "page") return;

  for (const entry of payload.entry || []) {
    for (const event of entry.messaging || []) {
      waitUntil(handleMessengerEvent(event).catch((err) => {
        console.error("messenger event error:", err);
      }));
    }
  }
};

// ─── Event handler ────────────────────────────────────────────────────────

async function handleMessengerEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId) return;

  // Ignore echo messages (bot's own sends reflected back)
  if (event.message?.is_echo) return;

  const msg = event.message;
  if (!msg) return;

  const text = (msg.text || "").trim();
  const attachments = msg.attachments || [];

  // Find the first image or audio attachment
  let media = null;
  for (const att of attachments) {
    const url = att.payload?.url;
    if (!url) continue;
    if (att.type === "image") {
      media = { url, contentType: "image/jpeg" };
      break;
    }
    if (att.type === "audio") {
      media = { url, contentType: "audio/mpeg" };
      break;
    }
    if (att.type === "video") {
      media = { url, contentType: "video/mp4" };
      break;
    }
  }

  if (!text && !media) return;

  const fromId = `messenger:${senderId}`;

  const ctx = {
    sendMessage: async (_toIgnored, messageText) => {
      await messengerSend(senderId, messageText);
    },
    downloadMedia: async (url) => {
      // Messenger media URLs are time-limited but publicly accessible
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` },
      });
      if (!r.ok) throw new Error(`Messenger media download ${r.status} ${url}`);
      const arr = await r.arrayBuffer();
      return Buffer.from(arr);
    },
  };

  await runWithContext(fromId, text, media, ctx);
}

// ─── Messenger Send API ───────────────────────────────────────────────────

async function messengerSend(recipientId, text) {
  // Messenger text message limit is 2000 chars
  const safeText = text.length > 2000 ? text.slice(0, 1997) + "…" : text;

  const r = await fetch(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: safeText },
      }),
    }
  );
  const data = await r.json();
  if (data.error) console.error("Messenger send failed:", data.error);
}

// ─── Signature verification ───────────────────────────────────────────────

function verifySignature(headers, rawBody) {
  if (!APP_SECRET) {
    console.warn("MESSENGER_APP_SECRET not set — skipping signature check");
    return true;
  }
  const sig = (headers["x-hub-signature-256"] || "").replace("sha256=", "");
  const expected = crypto
    .createHmac("sha256", APP_SECRET)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

// ─── Raw body reader ──────────────────────────────────────────────────────

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
