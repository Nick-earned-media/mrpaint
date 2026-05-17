// Twilio WhatsApp webhook handler.
//
// Receives an incoming WhatsApp message, validates the Twilio signature,
// checks the sender against a phone whitelist, and replies via TwiML.
//
// Currently runs in ECHO MODE — it replies with the received text so we can
// verify the plumbing. Real operations (Claude intent classification, file
// edits via Octokit, preview URLs, YES/NO approval) wire in next.
//
// Required Vercel env vars:
//   TWILIO_AUTH_TOKEN  — from Twilio Console (Settings → API Keys)
//   ALLOWED_PHONES     — comma-separated E.164 list (e.g. "+61478659766")
//
// Twilio webhook URL: https://www.mrpaint.com.au/api/whatsapp (HTTP POST)

const crypto = require("node:crypto");

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const ALLOWED_PHONES = (process.env.ALLOWED_PHONES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP_SIGNATURE_CHECK = process.env.SKIP_SIGNATURE_CHECK === "1";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const params = req.body || {};
  const fromRaw = String(params.From || "");
  const messageBody = String(params.Body || "").trim();

  // 1. Twilio signature check (skip locally with SKIP_SIGNATURE_CHECK=1).
  if (!SKIP_SIGNATURE_CHECK) {
    const signature = req.headers["x-twilio-signature"];
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${proto}://${host}${req.url}`;
    if (!signature || !verifySignature(TWILIO_AUTH_TOKEN, signature, url, params)) {
      console.warn("twilio-webhook: invalid signature", { url, hasSig: !!signature });
      res.status(403).send("Forbidden");
      return;
    }
  }

  // 2. Whitelist: strip "whatsapp:" prefix, compare to ALLOWED_PHONES.
  const phone = fromRaw.replace(/^whatsapp:/, "");
  if (!ALLOWED_PHONES.includes(phone)) {
    console.warn("twilio-webhook: rejected phone", { phone });
    return reply(res, "Sorry — this number isn't authorised to edit the MrPaint site.");
  }

  // 3. Echo mode.
  const text = messageBody
    ? `🎨 Got your message:\n\n"${truncate(messageBody, 200)}"\n\n(Bot is in echo mode — real operations land next.)`
    : "Got an empty message. Send some text to test.";
  return reply(res, text);
}

// ─── helpers ───────────────────────────────────────────────────────────────

function verifySignature(authToken, signature, url, params) {
  // Twilio: sort POST params by key, append key+value to URL, HMAC-SHA1, base64.
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + String(params[k])).join("");
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function reply(res, message) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`;
  res.setHeader("Content-Type", "text/xml; charset=utf-8");
  res.status(200).send(xml);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
