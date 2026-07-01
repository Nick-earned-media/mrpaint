// Quote-form handler — receives POSTs from all four site forms
// (home, contact, commercial, industrial).
//
// Spam protection (three layers):
//   1. Honeypot: hidden "website" field — bots fill it, humans don't
//   2. Time check: form submitted in < 3 seconds = bot
//   3. Rate limit: max 3 submissions per IP per hour (Supabase)
//
// Delivery: WhatsApp to Adrian + email to adrian@mrpaint.com.au + Slack copy for Nick
//
// Env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   LEADS_WHATSAPP_TO   — override WhatsApp target (falls back to ALLOWED_PHONES[0])
//   RESEND_API_KEY      — for email delivery (resend.com)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — for rate limiting

const { createClient } = require("@supabase/supabase-js");
const { postToSlack } = require("../lib/slack.js");

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM || "whatsapp:+14155238886";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const ADRIAN_WA =
  process.env.LEADS_WHATSAPP_TO ||
  (process.env.ALLOWED_PHONES || "").split(",").map((s) => s.trim()).filter(Boolean)[0] ||
  "whatsapp:+61478659766";

const LEAD_EMAIL = "adrian@mrpaint.com.au";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const form = await readForm(req).catch(() => ({}));

  // ── Layer 1: Honeypot ──────────────────────────────────────────────────
  if (form.website) {
    return redirect(res);
  }

  // ── Layer 2: Time check (< 3 seconds = bot) ────────────────────────────
  const ts = parseInt(form._t || "0", 10);
  if (ts && (Date.now() - ts) < 3000) {
    console.warn("contact: time-check rejection", { age: Date.now() - ts });
    return redirect(res);
  }

  // ── Layer 3: Rate limit (3 per IP per hour) ────────────────────────────
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket?.remoteAddress
    || "unknown";

  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    console.warn("contact: rate-limit rejection", { ip });
    return redirect(res);
  }

  // ── Validate ───────────────────────────────────────────────────────────
  const name = clean(form.name || form.business, 80);
  const phone = clean(form.phone, 40);
  if (!name && !phone) {
    res.statusCode = 303;
    res.setHeader("Location", "/contact-us/");
    return res.end();
  }

  // ── Build message ──────────────────────────────────────────────────────
  const lines = [
    "🟡 New quote request from the website",
    name    ? `Name: ${name}`                                             : null,
    phone   ? `Phone: ${phone}`                                           : null,
    form.email  ? `Email: ${clean(form.email, 100)}`                     : null,
    form.suburb || form.pcode
              ? `Suburb: ${clean(form.suburb, 60)} ${clean(form.pcode, 10)}`.trim() : null,
    form.job || form.site_type
              ? `Job: ${clean(form.job || form.site_type, 80)}`           : null,
    form.when ? `Timeframe: ${clean(form.when, 60)}`                     : null,
    form.msg  ? `Message: ${clean(form.msg, 600)}`                       : null,
    `Page: ${clean(req.headers.referer || "unknown", 120)}`,
  ].filter(Boolean);
  const text = lines.join("\n");

  // ── Deliver (all channels in parallel, best-effort) ────────────────────
  const [wa, email, slack] = await Promise.all([
    sendWhatsApp(ADRIAN_WA, text).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    sendEmail(name, text, form.email).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    postToSlack({ text: `📥 MrPaint website lead\n${text}` }).catch((e) => ({ ok: false, error: String(e?.message || e) })),
  ]);

  if (!wa?.ok && !email?.ok && !slack?.ok) {
    console.error("LEAD DELIVERY FAILED on all channels:", JSON.stringify({ wa, email, slack, text }));
  }

  return redirect(res);
};

// ─── Rate limiting ────────────────────────────────────────────────────────────

async function checkRateLimit(ip) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return true; // fail open if not configured
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await db
      .from("form_rate_limit")
      .select("*", { count: "exact", head: true })
      .eq("ip", ip)
      .gte("created_at", cutoff);
    if ((count || 0) >= 3) return false;
    await db.from("form_rate_limit").insert({ ip });
    return true;
  } catch (err) {
    console.error("rate-limit check failed:", err.message);
    return true; // fail open
  }
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(name, text, replyTo) {
  if (!RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  const subject = `New quote request — ${name || "Website visitor"}`;
  const body = {
    from: "MrPaint Website <noreply@mrpaint.com.au>",
    to: [LEAD_EMAIL],
    subject,
    text,
  };
  if (replyTo) body.reply_to = replyTo;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    console.error("Resend failed:", err);
    return { ok: false, error: err?.message };
  }
  return { ok: true };
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

async function sendWhatsApp(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { ok: false, error: "twilio not configured" };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const params = new URLSearchParams({
    From: TWILIO_FROM,
    To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
    Body: body,
  });
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("Twilio lead send failed:", r.status, t.slice(0, 200));
    return { ok: false, status: r.status };
  }
  return { ok: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function redirect(res) {
  res.statusCode = 303;
  res.setHeader("Location", "/thank-you/");
  return res.end();
}

function clean(v, max) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const ct = req.headers["content-type"] || "";
        if (ct.includes("application/json")) return resolve(JSON.parse(raw || "{}"));
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}
