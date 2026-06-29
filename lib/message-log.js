// Conversation logging: writes every inbound/outbound message to Supabase
// and mirrors non-Slack channels to #os-mrpaint in real time.
//
// Env vars (shared with whatsapp.js / slack.js):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SLACK_BOT_TOKEN, SLACK_NOTIFY_CHANNEL

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_NOTIFY_CHANNEL = process.env.SLACK_NOTIFY_CHANNEL || "";

let _client = null;
function db() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

function channelFromId(fromId) {
  if (String(fromId).startsWith("slack:")) return "slack";
  if (String(fromId).startsWith("messenger:")) return "messenger";
  if (String(fromId).startsWith("whatsapp:")) return "whatsapp";
  return "sms";
}

function labelFromId(fromId) {
  return String(fromId).replace(/^(whatsapp:|slack:|messenger:)/, "");
}

async function logInbound(fromId, content, { hasMedia = false } = {}) {
  const channel = channelFromId(fromId);
  await Promise.allSettled([
    writeRow({ channel, fromId, direction: "inbound", content, hasMedia }),
    channel !== "slack"
      ? postToSlack(formatSlack(channel, fromId, "inbound", content, hasMedia))
      : Promise.resolve(),
  ]);
}

async function logOutbound(fromId, content, { error = null } = {}) {
  const channel = channelFromId(fromId);
  await Promise.allSettled([
    writeRow({ channel, fromId, direction: "outbound", content, error }),
    channel !== "slack"
      ? postToSlack(formatSlack(channel, fromId, "outbound", content, false))
      : Promise.resolve(),
  ]);
}

async function writeRow({ channel, fromId, direction, content, hasMedia = false, error = null }) {
  const supabase = db();
  if (!supabase) return;
  const { error: dbErr } = await supabase.from("message_log").insert({
    channel,
    from_id: fromId,
    direction,
    content: content ? String(content).slice(0, 4000) : null,
    has_media: hasMedia,
    error: error ? String(error).slice(0, 500) : null,
  });
  if (dbErr) console.error("message_log write failed:", dbErr.message);
}

function formatSlack(channel, fromId, direction, content, hasMedia) {
  const label = labelFromId(fromId);
  const emoji = { sms: "📱", whatsapp: "💬", messenger: "💙" }[channel] || "💬";
  const header = direction === "inbound"
    ? `${emoji} *${label}* (${channel.toUpperCase()})${hasMedia ? "  📎 _[media]_" : ""}`
    : `🤖 *Bot → ${label}*`;
  return `${header}\n${content || "_(empty)_"}`;
}

async function postToSlack(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_NOTIFY_CHANNEL) return;
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: SLACK_NOTIFY_CHANNEL, text }),
  });
  const data = await r.json();
  if (!data.ok) console.error("message-log mirrorToSlack failed:", data.error);
}

module.exports = { logInbound, logOutbound };
