// Cron: nudge or abandon stale pending_captures.
//
// Runs every 5 minutes (configured in vercel.json). Three buckets:
//   - 15 min idle, no 15m reminder yet → ping #1
//   - 60 min idle, no 60m reminder yet → ping #2
//   - 120 min idle → quietly abandon (and clean up any draft branch)
//
// Per-WhatsApp-phone targeting via the same Twilio send path the bot uses.

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

module.exports = async function handler(req, res) {
  // Vercel cron sets `x-vercel-cron`; reject other callers in production.
  if (!req.headers["x-vercel-cron"] && process.env.NODE_ENV === "production") {
    return res.status(401).json({ error: "cron only" });
  }

  const captures = require("../lib/captures.js");
  const out = { pinged_15m: 0, pinged_60m: 0, abandoned: 0, errors: [] };

  // ── 15-min nudge ─────────────────────────────────────────────────────
  const due15 = await captures.listForReminder({ idleMinutes: 15, kind: "15m" });
  for (const c of due15) {
    const msg = c.status === "awaiting_description"
      ? "👋 Still want me to post those photos boss? Send me the description (text or voice note) when you're ready."
      : c.status === "awaiting_same_or_new"
      ? "👋 Should I add the latest photos to the *same* job as the last preview, or start a *new* post? Reply SAME or NEW."
      : "👋 You've got a draft preview waiting — reply YES to publish or NO to discard.";
    try {
      await sendTwilio(`whatsapp:${c.phone}`, msg);
      await captures.markReminded(c.id, "15m");
      out.pinged_15m++;
    } catch (err) {
      out.errors.push({ phase: "15m", id: c.id, error: String(err.message || err) });
    }
  }

  // ── 60-min nudge ─────────────────────────────────────────────────────
  const due60 = await captures.listForReminder({ idleMinutes: 60, kind: "60m" });
  for (const c of due60) {
    const msg = c.status === "awaiting_description"
      ? "🕐 Heads up — your photos have been sitting for an hour. Want me to finish that post (send the description) or forget it? Reply FORGET to discard."
      : c.status === "awaiting_same_or_new"
      ? "🕐 Still need a SAME or NEW on those extra photos. Reply FORGET if you want to bin them."
      : "🕐 Your draft preview's been sitting for an hour. Reply YES to publish, NO to discard, or FORGET to clear it.";
    try {
      await sendTwilio(`whatsapp:${c.phone}`, msg);
      await captures.markReminded(c.id, "60m");
      out.pinged_60m++;
    } catch (err) {
      out.errors.push({ phase: "60m", id: c.id, error: String(err.message || err) });
    }
  }

  // ── 120-min abandon ──────────────────────────────────────────────────
  const due120 = await captures.listForReminder({ idleMinutes: 120, kind: "abandon" });
  for (const c of due120) {
    try {
      if (c.draft_branch) {
        await ghDeleteBranch(c.draft_branch).catch((err) => {
          console.warn(`[cron] couldn't delete ${c.draft_branch}:`, err.message);
        });
      }
      await captures.markStatus(c.id, "abandoned");
      out.abandoned++;
    } catch (err) {
      out.errors.push({ phase: "abandon", id: c.id, error: String(err.message || err) });
    }
  }

  return res.status(200).json({ ok: true, ...out });
};

async function sendTwilio(toWa, text) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ From: TWILIO_FROM, To: toWa, Body: text });
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Twilio ${r.status}: ${t.slice(0, 200)}`);
  }
}

async function ghDeleteBranch(branch) {
  const enc = encodeURIComponent(branch).replace(/%2F/g, "/");
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/${enc}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "mrpaint-bot",
    },
  });
  if (!r.ok && r.status !== 422) {
    const t = await r.text();
    throw new Error(`GitHub delete ${r.status}: ${t.slice(0, 200)}`);
  }
}
