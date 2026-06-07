// Dynamic report URL: /reports/{scope}/{date}
// Routes:
//   /reports/cairns/2026-06-06     → Cairns city-wide weekly report
//   /reports/edge-hill/2026-06-06  → Edge Hill suburb weekly report (future)
//
// Pulls fresh Semrush + GSC data and renders the report HTML on each
// request. Cache-Control set so the CDN holds the response for an hour —
// reports change weekly so this gives Adrian a snappy load when sharing.

const { getReportData } = require("../../../lib/report-data.js");
const { renderReport } = require("../../../lib/report-html.js");

module.exports = async function handler(req, res) {
  try {
    const { scope, date } = req.query || {};
    if (!scope || !date) {
      res.status(400).send("Usage: /reports/{scope}/{YYYY-MM-DD}");
      return;
    }

    // Validate date — accept YYYY-MM-DD with optional .html suffix
    const clean = String(date).replace(/\.html?$/i, "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      res.status(400).send(`Invalid date format: ${date}. Expected YYYY-MM-DD.`);
      return;
    }
    const endDate = new Date(clean + "T00:00:00Z");
    if (Number.isNaN(endDate.getTime())) {
      res.status(400).send(`Invalid date: ${clean}`);
      return;
    }

    // Validate scope — for now only 'cairns'
    const safeScope = String(scope).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(safeScope)) {
      res.status(400).send(`Invalid scope: ${scope}`);
      return;
    }

    const data = await getReportData({
      clientSlug: "mrpaint",
      scope: safeScope,
      cadence: "weekly",
      endDate,
    });

    // Debug view: ?debug=1 returns the raw structured data instead of HTML.
    if (req.query?.debug === "1" || req.query?.debug === "true") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(JSON.stringify({
        kpis: data.kpis,
        competitors: data.competitors,
        ai_visibility: data.ai_visibility,
        semrush_mode: data.raw?.semrush?.mode,
        semrush_campaignId: data.raw?.semrush?.campaignId,
        semrush_error: data.raw?.semrush?.error || data.raw?.semrush?.skipped,
        semrush_keys: data.raw?.semrush ? Object.keys(data.raw.semrush) : null,
        ai_engines_raw_count: Array.isArray(data.raw?.semrush?.aiEngines) ? data.raw.semrush.aiEngines.length : null,
        trackedCompetitors_present: !!data.raw?.semrush?.trackedCompetitors,
        narrative: data.narrative,
      }, null, 2));
      return;
    }

    const html = renderReport(data);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    // Cache for 1 hour in the CDN; SWR for 1 day so stale responses keep
    // shipping while a new one regenerates in the background.
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).send(html);
  } catch (err) {
    console.error("report render error:", err);
    res.status(500).setHeader("Content-Type", "text/plain; charset=utf-8")
      .send(`Report failed: ${(err && err.message) || err}`);
  }
};
