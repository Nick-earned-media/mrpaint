// Diagnose the Semrush integration — what campaigns exist for the project,
// what data each campaign returns, and whether competitors / AI overlays
// are coming through.
//
// GET /api/admin/diagnose-semrush  (bearer auth = INGEST_TOKEN)

const crypto = require("crypto");

module.exports = async function handler(req, res) {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return res.status(503).json({ error: "INGEST_TOKEN not set" });
  const auth = req.headers["authorization"] || "";
  const presented = auth.replace(/^Bearer\s+/i, "").trim();
  if (!presented || presented.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const out = {
    env: {
      SEMRUSH_API_KEY: !!process.env.SEMRUSH_API_KEY,
      SEMRUSH_PROJECT_ID: process.env.SEMRUSH_PROJECT_ID || null,
      SEMRUSH_DOMAIN: process.env.SEMRUSH_DOMAIN || "(default: mrpaint.com.au)",
      SEMRUSH_DATABASE: process.env.SEMRUSH_DATABASE || "(default: au)",
    },
  };

  const projectId = process.env.SEMRUSH_PROJECT_ID;
  if (!projectId) {
    out.error = "SEMRUSH_PROJECT_ID not set — falling back to Domain Analytics mode";
    return res.status(200).json(out);
  }

  const {
    listTrackingCampaigns,
    positionTrackingOverview,
    positionTrackingKeywords,
    positionTrackingCompetitors,
  } = require("../../lib/semrush.js");

  // 1. Campaigns
  let campaigns;
  try {
    campaigns = await listTrackingCampaigns(projectId);
    out.campaigns = campaigns.map((c) => ({
      id: c.id, engine: c.engine, device: c.device, name: c.name,
      keywords_count: c.keywords_count, last_update: c.last_update,
    }));
  } catch (err) {
    out.error = `listTrackingCampaigns: ${err.message || err}`;
    return res.status(200).json(out);
  }

  // 2. For each campaign — pull overview + competitors. That's where Nick's
  //    "competitors aren't logging / AI not set up" answer comes from.
  const domain = process.env.SEMRUSH_DOMAIN || "mrpaint.com.au";
  out.per_campaign = await Promise.all(campaigns.map(async (c) => {
    const result = {
      id: c.id, engine: c.engine, device: c.device, name: c.name,
      keywords_count: c.keywords_count, last_update: c.last_update,
    };
    try {
      result.overview = await positionTrackingOverview(c.id);
    } catch (err) {
      result.overview_error = String(err.message || err);
    }
    try {
      const comps = await positionTrackingCompetitors(c.id, { limit: 10 });
      result.competitors = comps;
      result.competitor_count = Array.isArray(comps?.data)
        ? Object.keys(comps.data).length
        : (Array.isArray(comps) ? comps.length : "(unknown shape)");
    } catch (err) {
      result.competitors_error = String(err.message || err);
    }
    try {
      const kws = await positionTrackingKeywords(c.id, { url: domain, limit: 5 });
      result.keywords_sample = kws;
    } catch (err) {
      result.keywords_error = String(err.message || err);
    }
    return result;
  }));

  return res.status(200).json(out);
};
