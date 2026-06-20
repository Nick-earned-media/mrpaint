// Weekly GSC ingestion cron.
//
// Schedule: Fridays 04:00 UTC (Friday 14:00 Brisbane), runs just before the
// weekly report cron at 06:45 UTC so the report can read fresh data from
// kb_chunks if it wants.
//
// For each active client with a configured gsc_property, pulls a 7-day
// snapshot of GSC search performance + significantly-moving queries/pages
// and writes embedded summary chunks into kb_chunks for the strategist bot
// to recall.
//
// Triggered by Vercel Cron — see vercel.json.

const { client: supa } = require("../lib/supabase.js");
const { ingestGscForClient } = require("../lib/gsc-kb.js");

module.exports = async function handler(req, res) {
  // Vercel cron sends GET with the project's CRON_SECRET as a Bearer token.
  // In dev/manual trigger we accept any caller.
  const auth = req.headers.authorization;
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
  if (expected && auth !== expected) {
    return res.status(401).send("Unauthorized");
  }

  let clients = [];
  try {
    const { data, error } = await supa()
      .from("clients")
      .select("id, slug, display_name, gsc_property");
    if (error) throw error;
    clients = (data || []).filter((c) => c.gsc_property);
  } catch (err) {
    console.error("[cron-gsc-ingest] clients query failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }

  if (clients.length === 0) {
    return res.status(200).json({ ok: true, note: "no clients with gsc_property configured" });
  }

  const results = [];
  for (const c of clients) {
    try {
      const result = await ingestGscForClient(c);
      results.push({ slug: c.slug, ...result });
      console.log(`[cron-gsc-ingest] ${c.slug}: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[cron-gsc-ingest] ${c.slug} failed:`, err);
      results.push({ slug: c.slug, error: err.message });
    }
  }

  return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), results });
};
