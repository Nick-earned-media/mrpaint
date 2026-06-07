// Quote-form handler — receives the native POSTs from the four site forms
// (home, contact, commercial, industrial), delivers the lead to Adrian's
// WhatsApp with a Slack copy for Nick, then 303-redirects to /thank-you/
// (which is the GA4 conversion point).
//
// Delivery is best-effort on both channels: a lead is only "lost" if BOTH
// fail, in which case we log loudly. The visitor always lands on /thank-you/.

const { postToSlack } = require("../lib/slack.js");

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM || "whatsapp:+14155238886";
// Same delivery target as the weekly digest: LEADS_WHATSAPP_TO override,
// else the first ALLOWED_PHONES entry (Adrian's actual WhatsApp number).
const ADRIAN_WA =
  process.env.LEADS_WHATSAPP_TO ||
  (process.env.ALLOWED_PHONES || "").split(",").map((s) => s.trim()).filter(Boolean)[0] ||
  "whatsapp:+61478659766";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const form = await readForm(req).catch(() => ({}));

  // Honeypot: real users never fill the hidden "website" field.
  if (form.website) {
    return redirect(res); // pretend success, drop silently
  }

  const name = clean(form.name || form.business, 80);
  const phone = clean(form.phone, 40);
  if (!name && !phone) {
    // Nothing usable — bounce back to the contact page.
    res.statusCode = 303;
    res.setHeader("Location", "/contact-us/");
    return res.end();
  }

  const lines = [
    "🟡 New quote request from the website",
    name ? `Name: ${name}` : null,
    phone ? `Phone: ${phone}` : null,
    form.email ? `Email: ${clean(form.email, 100)}` : null,
    form.suburb || form.pcode ? `Suburb: ${clean(form.suburb, 60)} ${clean(form.pcode, 10)}`.trim() : null,
    form.job || form.site_type ? `Job: ${clean(form.job || form.site_type, 80)}` : null,
    form.when ? `Timeframe: ${clean(form.when, 60)}` : null,
    form.msg ? `Message: ${clean(form.msg, 600)}` : null,
    `Page: ${clean(req.headers.referer || "unknown", 120)}`,
  ].filter(Boolean);
  const text = lines.join("\n");

  const [wa, slack] = await Promise.all([
    sendWhatsApp(ADRIAN_WA, text).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    postToSlack({ text: `📥 MrPaint website lead\n${text}` }).catch((e) => ({ ok: false, error: String(e?.message || e) })),
  ]);

  if (!wa?.ok && !slack?.ok) {
    console.error("LEAD DELIVERY FAILED on both channels:", JSON.stringify({ wa, slack, text }));
  }

  return redirect(res);
};

function redirect(res) {
  res.statusCode = 303;
  res.setHeader("Location", "/thank-you/");
  return res.end();
}

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
