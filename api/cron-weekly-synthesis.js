// Weekly behaviour synthesis cron.
//
// Schedule: Saturdays 07:00 UTC (Saturday 17:00 Brisbane) — captures the full
// work week's worth of behaviour events including Friday-evening activity.
//
// For each active client, pulls the past 7 days of behaviour:* events from
// kb_chunks and asks Claude Haiku for one consolidated factual paragraph
// summarising the week. The summary is embedded and written back to kb_chunks
// with source_type 'synthesis:weekly' so the bot can recall it via
// searchClientKb.
//
// Triggered by Vercel Cron — see vercel.json.

const { client: supa } = require("../lib/supabase.js");
const { synthesiseWeekForClient } = require("../lib/synthesis.js");

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization;
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
  if (expected && auth !== expected) {
    return res.status(401).send("Unauthorized");
  }

  let clients = [];
  try {
    const { data, error } = await supa()
      .from("clients")
      .select("id, slug, display_name");
    if (error) throw error;
    clients = data || [];
  } catch (err) {
    console.error("[cron-weekly-synthesis] clients query failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }

  if (clients.length === 0) {
    return res.status(200).json({ ok: true, note: "no clients found" });
  }

  const results = [];
  for (const c of clients) {
    try {
      const result = await synthesiseWeekForClient(c);
      results.push({ slug: c.slug, ...result });
      console.log(`[cron-weekly-synthesis] ${c.slug}: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[cron-weekly-synthesis] ${c.slug} failed:`, err);
      results.push({ slug: c.slug, error: err.message });
    }
  }

  return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), results });
};
