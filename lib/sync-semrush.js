// Sync Semrush Position Tracking → Supabase tracked_keywords + keyword_history.
//
// Run on a cron (daily at 06:00 Brisbane) so we accumulate a position
// history. Ranking-drop alerts read this table — not the Semrush API
// directly — so they have a stable baseline to compare against.
//
// Usage:
//   const { syncTrackedKeywords } = require('./sync-semrush.js');
//   const r = await syncTrackedKeywords(clientId);

const {
  client: supa,
  getClientBySlug,
} = require("./supabase.js");

const {
  listTrackingCampaigns,
  positionTrackingKeywords,
} = require("./semrush.js");

// Pull all engines or just google. For now we sync only Google — the
// AI engine campaigns (search-gpt, gemini) can be added later as
// separate signals.
async function syncTrackedKeywords(clientId, { engine = "google" } = {}) {
  // Look up the client to get the Semrush project ID and domain
  const { data: clientRow, error: cErr } = await supa()
    .from("clients").select("*").eq("id", clientId).single();
  if (cErr || !clientRow) throw new Error(`client ${clientId} not found`);

  const projectId = clientRow.semrush_project_id;
  const domain = clientRow.semrush_domain || "mrpaint.com.au";
  if (!projectId) throw new Error(`client ${clientRow.slug} has no semrush_project_id set`);

  // Resolve which campaign within the project matches the requested engine
  const campaigns = await listTrackingCampaigns(projectId);
  const campaign = campaigns.find((c) => c.engine === engine) || campaigns[0];
  if (!campaign) throw new Error(`no tracking campaigns found for Semrush project ${projectId}`);
  const campaignId = campaign.id;

  // Fetch up to 200 keywords (Semrush hard limit is 5000 per call)
  const ptResp = await positionTrackingKeywords(campaignId, { url: domain, limit: 200 });
  const rows = ptResp.data ? Object.values(ptResp.data) : [];
  if (!rows.length) {
    return { synced: 0, history_rows: 0, campaign_id: campaignId, note: "no tracked keywords returned" };
  }

  // Build the upsert payload for tracked_keywords
  // Position is in Dt.{date}.{domain} — "-" means not ranking, store NULL
  const today = new Date().toISOString().slice(0, 10);
  const todayCompact = today.replace(/-/g, ""); // 2026-06-02 → 20260602

  let synced = 0;
  let historyRows = 0;

  for (const row of rows) {
    const keyword = row.Ph;
    if (!keyword) continue;

    const dateKeys = row.Dt ? Object.keys(row.Dt).sort() : [];
    const latestKey = dateKeys[dateKeys.length - 1];
    const latestPosRaw = latestKey ? row.Dt[latestKey]?.[domain] : null;
    const currentPosition = latestPosRaw && latestPosRaw !== "-" ? parseInt(latestPosRaw, 10) : null;

    const searchVolume = row.Nq ? parseInt(row.Nq, 10) || null : null;
    const cpc = row.Cp ? parseFloat(row.Cp) || null : null;

    // Get the existing row so we can preserve previous_position
    const { data: existing } = await supa()
      .from("tracked_keywords")
      .select("id, current_position")
      .eq("client_id", clientId)
      .eq("keyword", keyword)
      .maybeSingle();

    const previousPosition = existing?.current_position ?? null;

    // Upsert tracked_keywords
    const upsert = {
      client_id: clientId,
      keyword,
      current_position: currentPosition,
      previous_position: previousPosition,
      search_volume: searchVolume,
      cpc,
      last_synced_at: new Date().toISOString(),
      semrush_project_id: projectId,
    };

    const { data: tk, error: upErr } = await supa()
      .from("tracked_keywords")
      .upsert(upsert, { onConflict: "client_id,keyword" })
      .select("id")
      .single();
    if (upErr) {
      console.error(`upsert failed for "${keyword}":`, upErr.message);
      continue;
    }
    synced++;

    // Append today's row to keyword_history (idempotent — UNIQUE on (tracked_keyword_id, snapshot_date))
    const history = {
      tracked_keyword_id: tk.id,
      snapshot_date: today,
      position: currentPosition,
      search_volume: searchVolume,
      semrush_data: {
        Dt: row.Dt,
        Diff7: row.Diff7,
        Diff30: row.Diff30,
        Sf_today: row.Sf?.[latestKey] || [],
        Be: row.Be,
        Vi: row.Vi?.[latestKey],
        Sov: row.Sov?.[latestKey],
      },
    };
    const { error: hErr } = await supa()
      .from("keyword_history")
      .upsert(history, { onConflict: "tracked_keyword_id,snapshot_date" });
    if (!hErr) historyRows++;
  }

  return {
    synced,
    history_rows: historyRows,
    campaign_id: campaignId,
    domain,
    engine,
    snapshot_date: today,
  };
}

module.exports = { syncTrackedKeywords };
