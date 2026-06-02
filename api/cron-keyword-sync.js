// Daily cron: sync Semrush Position Tracking for every active client.
// Schedule: 06:00 Brisbane = 20:00 UTC the previous day.
//
// Runs syncTrackedKeywords for each client that has a semrush_project_id set.
// Writes a row per keyword per day into keyword_history. This is the
// foundation for the ranking-drop alert engine.

const { client: supa } = require("../lib/supabase.js");
const { syncTrackedKeywords } = require("../lib/sync-semrush.js");

module.exports = async function handler(req, res) {
  // Vercel cron requests are authorized via CRON_SECRET header
  const isCron = req.headers["x-vercel-cron"] || req.headers.authorization?.includes(process.env.CRON_SECRET || "_unset_");
  if (!isCron && process.env.NODE_ENV === "production") {
    res.status(403).send("Forbidden");
    return;
  }

  try {
    const { data: clients, error } = await supa()
      .from("clients")
      .select("id, slug, display_name, semrush_project_id")
      .not("semrush_project_id", "is", null);
    if (error) throw error;

    const results = [];
    for (const c of clients || []) {
      try {
        const r = await syncTrackedKeywords(c.id);
        results.push({ client: c.slug, ...r });
      } catch (err) {
        results.push({ client: c.slug, error: String(err.message || err) });
      }
    }
    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("cron-keyword-sync error:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
