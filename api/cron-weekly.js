// Vercel cron — runs every Monday 9am Brisbane time (23:00 UTC Sunday).
// Pushes a GSC week-over-week digest to the configured WhatsApp number.
//
// Schedule is defined in vercel.json under "crons".
//
// Env vars required for the digest to actually fire:
//   GSC_SERVICE_ACCOUNT_JSON — Google service account JSON (see lib/gsc.js).
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   CRON_DIGEST_TO_PHONE — WhatsApp number to push to (E.164, no whatsapp: prefix).
//   CRON_SECRET — Vercel auto-sets this for cron auth; we verify the header.

const { fetchGscTrends } = require("../lib/gsc.js");

const SITE_URL = process.env.GSC_SITE_URL || "https://mrpaint.com.au/";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "whatsapp:+14155238886";
const CRON_DIGEST_TO_PHONE = process.env.CRON_DIGEST_TO_PHONE || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

module.exports = async function handler(req, res) {
  // Vercel cron passes Authorization: Bearer <CRON_SECRET>. Reject anything else.
  const auth = req.headers["authorization"] || "";
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  if (!CRON_DIGEST_TO_PHONE) {
    return res.status(200).json({ ok: true, skipped: "CRON_DIGEST_TO_PHONE not set" });
  }

  try {
    const trends = await fetchGscTrends({ siteUrl: SITE_URL });
    if (trends.skipped) {
      return res.status(200).json({ ok: true, skipped: trends.skipped });
    }
    if (trends.error) {
      await sendWhatsApp(CRON_DIGEST_TO_PHONE, `📈 Weekly GSC digest failed: ${trends.error}`);
      return res.status(500).json({ ok: false, error: trends.error });
    }

    const msg = formatDigest(trends);
    await sendWhatsApp(CRON_DIGEST_TO_PHONE, msg);
    return res.status(200).json({ ok: true, summary: trends.summary, drops: trends.drops.length });
  } catch (err) {
    console.error("cron-weekly error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};

function formatDigest(g) {
  const m = [`📈 *Weekly GSC digest — mrpaint.com.au*`, ``];
  m.push(`Clicks: ${g.summary.clicksThis} (${signedPct(g.summary.clicksDelta)})`);
  m.push(`Impressions: ${g.summary.impressionsThis} (${signedPct(g.summary.impressionsDelta)})`);
  m.push(``);
  if (g.drops?.length > 0) {
    m.push(`🚨 *${g.drops.length} pages dropped ≥20%*:`);
    for (const d of g.drops.slice(0, 5)) {
      m.push(`• ${d.page} — clicks ${signedPct(d.clicksDelta)}, impr ${signedPct(d.impressionsDelta)}`);
    }
  } else {
    m.push(`✅ No pages with ≥20% drop this week.`);
  }
  m.push(``);
  m.push(`*Top pages (last 7d)*:`);
  for (const t of (g.top || []).slice(0, 5)) {
    m.push(`• ${t.page} — ${t.clicks} clicks, ${t.impressions} impr`);
  }
  return m.join("\n");
}

function signedPct(n) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${Math.round(n)}%`;
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
