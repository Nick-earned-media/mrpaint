// Vercel cron — runs every Friday 4:45pm Brisbane (06:45 UTC Friday).
// Generates the weekly Cairns report URL and DMs it to the allow-listed
// phone(s) with a short strategist-voice intro line.
//
// The report itself renders dynamically at /reports/cairns/<YYYY-MM-DD>
// so the cron just sends the URL — no large payload to compute or cache.
//
// Schedule: vercel.json crons → "45 6 * * 5" (Friday 06:45 UTC = 4:45pm AEST).
//
// Env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   CRON_DIGEST_TO_PHONE  — override target (E.164). Falls back to
//                           ALLOWED_PHONES if not set.
//   ALLOWED_PHONES        — comma-separated E.164 list
//   CRON_SECRET           — Vercel auto-sets for cron auth
//   ANTHROPIC_API_KEY     — optional, used to write the intro line in voice
//   PUBLIC_BASE_URL       — defaults to https://mrpaint.vercel.app

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "whatsapp:+14155238886";
const CRON_SECRET = process.env.CRON_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://mrpaint.vercel.app";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

module.exports = async function handler(req, res) {
  // Vercel cron passes Authorization: Bearer <CRON_SECRET>.
  const auth = req.headers["authorization"] || "";
  const isVercelCron = req.headers["x-vercel-cron"];
  if (!isVercelCron && CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  const recipients = resolveRecipients();
  if (!recipients.length) {
    return res.status(200).json({ ok: true, skipped: "no recipients configured" });
  }

  try {
    const result = await sendFridayDigest(recipients);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("cron-weekly error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};

function resolveRecipients() {
  const explicit = (process.env.CRON_DIGEST_TO_PHONE || "").trim();
  if (explicit) return [explicit];
  return (process.env.ALLOWED_PHONES || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

async function sendFridayDigest(recipients) {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${PUBLIC_BASE_URL}/reports/cairns/${today}`;

  const intro = await writeIntro(today);
  const message = `${intro}\n\n${url}\n\nReply with a question if you want me to dig into anything.`;

  const sent = [];
  for (const to of recipients) {
    try {
      await sendWhatsApp(to, message);
      sent.push(to);
    } catch (err) {
      console.error(`Failed to send to ${to}:`, err.message || err);
    }
  }
  return { date: today, url, sent_to: sent.length, recipients: sent };
}

async function writeIntro(dateStr) {
  // Fallback if Anthropic isn't available
  const fallback = `📊 Friday digest — Cairns week ending ${dateStr}.`;
  if (!ANTHROPIC_API_KEY) return fallback;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        system: "Write one casual WhatsApp opener (~12 words) in Nick Brogden's voice for a weekly painter SEO report. Never use 'mate'. Sound like Nick texting a client. Examples: 'Friday report's up.', 'Quick read for the week — Cairns is looking sharp.', 'Done — this week's numbers.' Reply with JUST the opener, no quotes, no prefix.",
        messages: [{ role: "user", content: `It's Friday ${dateStr}. The bot just generated this week's Cairns report.` }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const data = await r.json();
    const text = (data.content?.[0]?.text || "").trim().replace(/^["']|["']$/g, "");
    return text || fallback;
  } catch (err) {
    console.error("intro generation failed:", err.message || err);
    return fallback;
  }
}

async function sendWhatsApp(toPhone, text) {
  const to = toPhone.startsWith("whatsapp:") ? toPhone : `whatsapp:${toPhone}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: text });
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Twilio send failed: ${r.status} ${t.slice(0, 200)}`);
  }
}
