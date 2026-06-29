// Slack Events API webhook — bidirectional bot integration.
//
// Env vars:
//   SLACK_BOT_TOKEN      — xoxb-... (Bot User OAuth Token)
//   SLACK_SIGNING_SECRET — from Basic Information → App Credentials
//
// Slack sends events as JSON POST. We verify the request signature, then
// dispatch message events into the same handleMessage pipeline as Twilio,
// using AsyncLocalStorage to inject Slack-specific send/download functions.

const crypto = require("node:crypto");
const { waitUntil } = require("@vercel/functions");
const { runWithContext } = require("./whatsapp.js");

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  // Collect raw body for signature verification
  const rawBody = await getRawBody(req);

  if (!verifySlackSignature(req.headers, rawBody)) {
    return res.status(401).end("Unauthorized");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).end("Bad JSON");
  }

  // Slack sends a URL verification challenge when you first configure the endpoint
  if (payload.type === "url_verification") {
    return res.status(200).json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") {
    return res.status(200).end("ok");
  }

  const event = payload.event;

  // Ignore bot messages (including our own) to prevent loops
  if (!event || event.bot_id || event.subtype) {
    return res.status(200).end("ok");
  }

  // Only handle direct messages and channel messages / mentions
  const supportedTypes = ["message", "app_mention"];
  if (!supportedTypes.includes(event.type)) {
    return res.status(200).end("ok");
  }

  const text = (event.text || "").trim();
  const channelId = event.channel;
  const userId = event.user;

  if (!text || !channelId || !userId) {
    return res.status(200).end("ok");
  }

  // Respond 200 immediately — Slack requires a response within 3 seconds
  res.status(200).end("ok");

  // Build the channel context: Slack-specific send and downloadMedia
  const ctx = {
    sendMessage: async (_toIgnored, messageText) => {
      await slackPostMessage(channelId, messageText);
    },
    downloadMedia: async (url) => {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      if (!r.ok) throw new Error(`Slack media download ${r.status} ${url}`);
      const arr = await r.arrayBuffer();
      return Buffer.from(arr);
    },
  };

  const fromId = `slack:${userId}`;

  // waitUntil keeps the function alive after res.end() so the bot can reply
  waitUntil(
    runWithContext(fromId, text, null, ctx).catch(async (err) => {
      console.error("slack handler error:", err);
      await slackPostMessage(channelId, "Sorry, something went wrong. Please try again.");
    })
  );
};

// ─── Slack Web API helpers ────────────────────────────────────────────────────

async function slackPostMessage(channel, text) {
  // Slack message length limit is 40,000 chars; truncate if needed
  const safeText = text.length > 3800 ? text.slice(0, 3797) + "…" : text;

  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text: safeText }),
  });

  const data = await r.json();
  if (!data.ok) {
    console.error("Slack postMessage failed:", data.error);
  }
}

// ─── Signature verification ───────────────────────────────────────────────────

function verifySlackSignature(headers, rawBody) {
  if (!SLACK_SIGNING_SECRET) {
    console.warn("SLACK_SIGNING_SECRET not set — skipping verification");
    return true;
  }

  const slackSig = headers["x-slack-signature"] || "";
  const timestamp = headers["x-slack-request-timestamp"] || "";

  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const sigBase = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const hmac = crypto
    .createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(sigBase)
    .digest("hex");
  const expected = `v0=${hmac}`;

  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(slackSig, "utf8")
  );
}

// ─── Raw body reader ──────────────────────────────────────────────────────────

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
