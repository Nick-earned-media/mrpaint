// Post one or more GBP drafts to Slack (the human-in-the-loop GBP workflow:
// bot drafts → Slack ping → Nick copy/pastes into Google Business Profile).
//
// Used when an ingest happened outside the normal WhatsApp flow (e.g. via
// the admin endpoint) so the GBP Slack ping didn't fire automatically.
//
// Auth: same INGEST_TOKEN bearer as /api/admin/ingest-job.
//
// Body (JSON):
//   {
//     "drafts": [
//       { title, suburb, gbp_text, photo_alt, media_type, media_url, page_url }
//     ]
//   }

const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const expected = process.env.INGEST_TOKEN;
  if (!expected) return res.status(503).json({ error: "INGEST_TOKEN not set" });
  const auth = req.headers["authorization"] || "";
  const presented = auth.replace(/^Bearer\s+/i, "").trim();
  if (!presented || presented.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return res.status(400).json({ error: `json parse failed: ${err.message || err}` });
  }
  const drafts = Array.isArray(body.drafts) ? body.drafts : [];
  if (!drafts.length) return res.status(400).json({ error: "drafts array required" });

  const { notifyGbpPost } = require("../../lib/slack.js");
  const results = [];
  for (const d of drafts) {
    try {
      const r = await notifyGbpPost({
        clientName: d.client_name || "MrPaint",
        suburb: d.suburb || "",
        jobTitle: d.title || "",
        gbpText: d.gbp_text || "",
        previewUrl: d.page_url || null,
        imageUrl: d.media_type === "image" ? d.media_url : null,
        videoUrl: d.media_type === "video" ? d.media_url : null,
        photoAlt: d.photo_alt || "",
        mediaType: d.media_type || "image",
      });
      results.push({ title: d.title, ok: !!(r && (r.ok || r.skipped === undefined)), detail: r });
    } catch (err) {
      results.push({ title: d.title, ok: false, error: String(err.message || err) });
    }
  }

  return res.status(200).json({ ok: true, sent: results.length, results });
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}
