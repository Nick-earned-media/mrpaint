// Twilio WhatsApp webhook handler — MrPaint editorial bot.
//
// Flow:
//   1. Validate Twilio signature (HMAC-SHA1).
//   2. Check sender against ALLOWED_PHONES whitelist.
//   3. Pass the message to Claude Haiku for intent classification.
//   4. Reply via TwiML with the classifier's output (operation + params).
//
// Operation execution (writes, commits, preview URLs, YES/NO approval) lands
// after we've verified classifier quality with the user.
//
// Required Vercel env vars:
//   TWILIO_AUTH_TOKEN   — from Twilio Console
//   ANTHROPIC_API_KEY   — from console.anthropic.com (used by Haiku)
//   ALLOWED_PHONES      — comma-separated E.164 list (e.g. "+61416168991")

const crypto = require("node:crypto");

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
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

  if (!SKIP_SIGNATURE_CHECK) {
    const signature = req.headers["x-twilio-signature"];
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${proto}://${host}${req.url}`;
    if (!signature || !verifySignature(TWILIO_AUTH_TOKEN, signature, url, params)) {
      console.warn("twilio-webhook: invalid signature");
      res.status(403).send("Forbidden");
      return;
    }
  }

  const phone = fromRaw.replace(/^whatsapp:/, "");
  if (!ALLOWED_PHONES.includes(phone)) {
    console.warn("twilio-webhook: rejected phone", { phone });
    return reply(res, "Sorry — this number isn't authorised to edit the MrPaint site.");
  }

  if (!messageBody) {
    return reply(res, "Got an empty message. Send some text to test.");
  }

  if (!ANTHROPIC_API_KEY) {
    return reply(res, "⚠️ ANTHROPIC_API_KEY isn't set on the server — can't classify intent yet.");
  }

  try {
    const intent = await classifyIntent(messageBody);
    return reply(res, formatIntentReply(intent));
  } catch (err) {
    console.error("classifyIntent failed:", err);
    return reply(res, `⚠️ Classifier error: ${truncate(String(err.message || err), 300)}`);
  }
};

// ─── Claude intent classifier ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the backend webhook for a Cairns painting business (MrPaint). Adrian, the owner, messages you in plain English to edit his static website. Your job: classify each message into ONE operation and extract parameters. Reply with valid JSON ONLY — no prose, no code fences, no commentary.

Operations:
- update_business_info: change a sitewide business field. Output: {"operation":"update_business_info","field":"phone"|"email"|"address"|"hours","value":string}
- add_blog_post: write a new blog post from a topic or short brief. Output: {"operation":"add_blog_post","title":string,"body_markdown":string}. Generate a 200-400 word body in tradie-friendly Cairns voice.
- add_gallery_photo: cannot be done with text only — needs an image attachment which we'll handle later. Output: {"operation":"needs_image","message":string}
- update_text: change some specific text on the site (hero copy, an FAQ answer, etc.). Output: {"operation":"update_text","description":string}
- approve: user is confirming a pending change ("yes", "publish", "ship", "ok go", "publish it"). Output: {"operation":"approve"}
- discard: user is cancelling a pending change ("no", "cancel", "discard", "nope", "scrap it"). Output: {"operation":"discard"}
- unknown: doesn't match any operation. Output: {"operation":"unknown","reason":string}

Examples:
"change the phone to 0412 345 678" → {"operation":"update_business_info","field":"phone","value":"0412 345 678"}
"update our email to hello@mrpaint.com.au" → {"operation":"update_business_info","field":"email","value":"hello@mrpaint.com.au"}
"YES" → {"operation":"approve"}
"nope cancel that" → {"operation":"discard"}
"add a blog post about prepping a Queenslander before exterior repaint" → {"operation":"add_blog_post","title":"Prepping a Queenslander for an exterior repaint","body_markdown":"..."}
"swap the hero photo on the homepage" → {"operation":"needs_image","message":"send me the photo you'd like to use and I'll swap it in"}
"change the homepage hero to say 'Cairns painters since 2014'" → {"operation":"update_text","description":"change the homepage hero text to 'Cairns painters since 2014'"}
"what's the weather" → {"operation":"unknown","reason":"not a website edit request"}

Reply with the JSON object only.`;

async function classifyIntent(message) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: message }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw = data.content?.[0]?.text || "";
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(clean);
}

function formatIntentReply(intent) {
  const op = intent.operation || "unknown";
  switch (op) {
    case "update_business_info":
      return `🤖 Understood:\n\nUpdate **${intent.field}** to:\n"${intent.value}"\n\n(Operation execution lands next — for now I'm just confirming I parsed it right.)`;
    case "add_blog_post":
      return `🤖 Understood:\n\nNew blog post:\nTitle: "${intent.title}"\n\nBody preview:\n${truncate(intent.body_markdown || "", 300)}\n\n(Execution lands next.)`;
    case "add_gallery_photo":
    case "needs_image":
      return `🤖 ${intent.message || "Send the photo you'd like to use."}`;
    case "update_text":
      return `🤖 Understood — text change:\n"${intent.description}"\n\n(Execution lands next.)`;
    case "approve":
      return `🤖 Approve — but there's no pending change to publish yet. Once operation execution is wired, this'll merge the preview branch.`;
    case "discard":
      return `🤖 Discard — but there's no pending change to cancel yet.`;
    case "unknown":
      return `🤖 Not sure what to do with that. ${intent.reason || ""}\n\nTry: "change phone to 0412 345 678" or "add a blog post about ..."`;
    default:
      return `🤖 Got an unexpected intent:\n${JSON.stringify(intent, null, 2)}`;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function verifySignature(authToken, signature, url, params) {
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
