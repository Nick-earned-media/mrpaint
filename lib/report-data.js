// Pulls + structures the data for the weekly report.
//
//   getReportData({ clientId, scope, cadence, endDate })
//     → {
//         client, scope, cadence, period, kpis, movers, all_keywords,
//         competitors, ai_visibility, gsc, narrative, actions, raw
//       }
//
// `narrative` and `actions` are Sonnet-generated from the raw data —
// they're what makes the report feel strategic instead of a data dump.

const {
  client: supa,
  getClientBySlug,
} = require("./supabase.js");
const { runSemrushSnapshot } = require("./semrush.js");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SONNET_MODEL = "claude-sonnet-4-6";

// ─── public ──────────────────────────────────────────────────────────────

async function getReportData({
  clientSlug = "mrpaint",
  scope = "cairns",
  cadence = "weekly",
  endDate = new Date(),
} = {}) {
  const client = await getClientBySlug(clientSlug);
  if (!client) throw new Error(`client ${clientSlug} not found`);

  const end = endDate instanceof Date ? endDate : new Date(endDate);
  const start = new Date(end.getTime() - 7 * 86400 * 1000);
  const period = {
    cadence,
    end_date: end.toISOString().slice(0, 10),
    start_date: start.toISOString().slice(0, 10),
    label_short: humanDate(end),
    label_range: `${humanDate(start, false)} – ${humanDate(end)}`,
  };

  // 1. Semrush snapshot (live)
  let semrush;
  try {
    semrush = await runSemrushSnapshot({ engine: "google" });
  } catch (err) {
    semrush = { error: String(err.message || err) };
  }

  // 2. tracked_keywords from Supabase (history for deltas)
  const trackedKeywords = await loadTrackedKeywords(client.id);

  // 3. competitors from Supabase
  const knownCompetitors = await loadKnownCompetitors(client.id);

  // 4. GSC week-over-week
  let gsc;
  try {
    const gscMod = require("./gsc-oauth.js");
    const [wow, queries, pages] = await Promise.all([
      gscMod.getWeekOverWeek().catch((e) => ({ error: String(e.message || e) })),
      gscMod.getTopQueries({ days: 7, limit: 10 }).catch(() => []),
      gscMod.getTopPages({ days: 7, limit: 5 }).catch(() => []),
    ]);
    gsc = { wow, queries, pages };
  } catch (err) {
    gsc = { error: String(err.message || err) };
  }

  // 5. Structure KPIs + movers from the combined data
  const kpis = buildKpis({ semrush, trackedKeywords });
  const movers = buildMovers({ trackedKeywords });
  const all_keywords = buildAllKeywords({ trackedKeywords });
  const competitors = buildCompetitors({ semrush, knownCompetitors, domain: client.semrush_domain || "mrpaint.com.au" });
  const ai_visibility = buildAiVisibility({ trackedKeywords });

  // 6. Sonnet-generated narrative + actions
  const ai_synth = await synthesizeNarrative({
    client, scope, period, kpis, movers, competitors, ai_visibility, gsc,
  });

  return {
    client,
    scope,
    cadence,
    period,
    kpis,
    movers,
    all_keywords,
    competitors,
    ai_visibility,
    gsc,
    narrative: ai_synth.narrative,
    actions: ai_synth.actions,
    raw: { semrush, trackedKeywords, knownCompetitors },
    generated_at: new Date().toISOString(),
  };
}

// ─── data loaders ─────────────────────────────────────────────────────────

async function loadTrackedKeywords(clientId) {
  const { data, error } = await supa()
    .from("tracked_keywords")
    .select("id, keyword, suburb, current_position, previous_position, search_volume, cpc, last_synced_at")
    .eq("client_id", clientId);
  if (error) throw error;
  return data || [];
}

async function loadKnownCompetitors(clientId) {
  const { data, error } = await supa()
    .from("competitors")
    .select("name, domain, logo_path")
    .eq("client_id", clientId)
    .eq("active", true);
  if (error) throw error;
  return data || [];
}

// ─── KPI computation ──────────────────────────────────────────────────────

function buildKpis({ semrush, trackedKeywords }) {
  const ov = semrush?.trackingOverview || {};
  const ranked = trackedKeywords.filter((k) => k.current_position != null);
  const avg = ranked.length
    ? ranked.reduce((s, k) => s + k.current_position, 0) / ranked.length
    : null;
  const prevRanked = trackedKeywords.filter((k) => k.previous_position != null);
  const prevAvg = prevRanked.length
    ? prevRanked.reduce((s, k) => s + k.previous_position, 0) / prevRanked.length
    : null;

  const newEntries = trackedKeywords.filter(
    (k) => k.previous_position == null && k.current_position != null
  ).length;

  return {
    keywords_ranked: {
      value: ranked.length,
      total_tracked: trackedKeywords.length,
      delta: newEntries > 0 ? `▲ ${newEntries} new` : null,
      delta_direction: newEntries > 0 ? "up" : "flat",
    },
    avg_position: {
      value: avg != null ? `#${avg.toFixed(1)}` : "—",
      delta: avg != null && prevAvg != null
        ? `${avg < prevAvg ? "▲" : avg > prevAvg ? "▼" : "—"} ${Math.abs(avg - prevAvg).toFixed(1)}`
        : null,
      delta_direction: avg != null && prevAvg != null
        ? (avg < prevAvg ? "up" : avg > prevAvg ? "down" : "flat")
        : "flat",
    },
    share_of_voice: {
      value: ov.shareOfVoice != null ? `${ov.shareOfVoice.toFixed(2)}%` : "—",
      delta: ov.differenceShareOfVoice != null
        ? `${ov.differenceShareOfVoice >= 0 ? "▲" : "▼"} ${Math.abs(ov.differenceShareOfVoice).toFixed(2)}%`
        : null,
      delta_direction: ov.differenceShareOfVoice != null
        ? (ov.differenceShareOfVoice > 0 ? "up" : ov.differenceShareOfVoice < 0 ? "down" : "flat")
        : "flat",
    },
    visibility: {
      value: ov.visibility != null ? `${ov.visibility.toFixed(2)}%` : "—",
      delta: ov.differenceVisibility != null
        ? `${ov.differenceVisibility >= 0 ? "▲" : "▼"} ${Math.abs(ov.differenceVisibility).toFixed(2)}%`
        : null,
      delta_direction: ov.differenceVisibility != null
        ? (ov.differenceVisibility > 0 ? "up" : ov.differenceVisibility < 0 ? "down" : "flat")
        : "flat",
    },
  };
}

// ─── movers ──────────────────────────────────────────────────────────────

function buildMovers({ trackedKeywords }) {
  const enriched = trackedKeywords.map((k) => {
    const cur = k.current_position;
    const prev = k.previous_position;
    let delta = null, status = "flat";
    if (cur != null && prev == null) {
      status = "new"; delta = "★";
    } else if (cur == null && prev != null) {
      status = "lost"; delta = "—";
    } else if (cur != null && prev != null) {
      const d = prev - cur;
      if (d > 0) { status = "up"; delta = `▲${d}`; }
      else if (d < 0) { status = "down"; delta = `▼${-d}`; }
      else { status = "flat"; delta = "—"; }
    }
    return {
      keyword: k.keyword,
      position: cur != null ? `#${cur}` : "—",
      position_raw: cur,
      previous_raw: prev,
      delta,
      status,
      volume: k.search_volume,
      cpc: k.cpc,
      _movement_abs: cur != null && prev != null ? Math.abs(prev - cur) : 0,
      _new: cur != null && prev == null,
    };
  });
  // Sort: new entries first, then by absolute movement descending
  enriched.sort((a, b) => {
    if (a._new !== b._new) return a._new ? -1 : 1;
    return b._movement_abs - a._movement_abs;
  });
  return enriched.slice(0, 6).map(({ _movement_abs, _new, ...rest }) => rest);
}

// ─── all keywords ────────────────────────────────────────────────────────

function buildAllKeywords({ trackedKeywords }) {
  return trackedKeywords
    .map((k) => {
      const cur = k.current_position;
      const prev = k.previous_position;
      let delta = "—", direction = "flat";
      if (cur != null && prev == null) { delta = "new"; direction = "up"; }
      else if (cur != null && prev != null) {
        const d = prev - cur;
        if (d > 0) { delta = `▲${d}`; direction = "up"; }
        else if (d < 0) { delta = `▼${-d}`; direction = "down"; }
      }
      return {
        keyword: k.keyword,
        position: cur != null ? `#${cur}` : "no rank",
        position_raw: cur,
        volume: k.search_volume ?? 0,
        delta,
        direction,
      };
    })
    .sort((a, b) => {
      if (a.position_raw == null && b.position_raw == null) return 0;
      if (a.position_raw == null) return 1;
      if (b.position_raw == null) return -1;
      return a.position_raw - b.position_raw;
    });
}

// ─── competitors ─────────────────────────────────────────────────────────

function buildCompetitors({ semrush, knownCompetitors, domain }) {
  // Pull from Semrush trackedCompetitors (which has live SoV per competitor)
  // and merge with the names from Supabase competitors table.
  const semrushData = semrush?.trackedCompetitors?.data;
  if (!semrushData) {
    // Fallback: just return the known competitors with no SoV
    return knownCompetitors.map((c) => ({
      name: c.name,
      domain: c.domain,
      sov: null,
      bar_pct: 0,
      is_you: false,
    }));
  }

  const rows = Object.values(semrushData).map((c) => {
    const dateKeys = c.Dt ? Object.keys(c.Dt).filter((k) => k !== "Diff").sort() : [];
    const latest = dateKeys[dateKeys.length - 1];
    const m = latest ? c.Dt[latest] : {};
    return {
      domain: c.Ur,
      sov: m?.Sov || 0,
    };
  });

  // Find the "you" row (or compute from semrush.trackingOverview)
  const youRow = {
    name: "MrPaint",
    domain,
    sov: (semrush?.trackingOverview?.shareOfVoice || 0) / 100,
    is_you: true,
  };

  // Match known competitor display names where possible; else use domain
  const named = rows.map((r) => {
    const known = knownCompetitors.find((kc) => kc.domain && r.domain && kc.domain.toLowerCase() === r.domain.toLowerCase());
    return {
      name: known?.name || r.domain,
      domain: r.domain,
      sov: r.sov,
      is_you: false,
    };
  });

  // Combine and sort by SoV desc, keep top 5 + always include "you"
  const combined = [...named, youRow].sort((a, b) => b.sov - a.sov);
  const top = combined.slice(0, 6);
  if (!top.find((c) => c.is_you)) top.push(youRow);

  // Normalise bar widths against the top SoV (so the top one is always 100%)
  const maxSov = Math.max(...top.map((c) => c.sov || 0)) || 1;
  return top.map((c) => ({
    ...c,
    sov_pct: c.sov != null ? (c.sov * 100).toFixed(2) + "%" : "—",
    bar_pct: c.sov != null ? Math.round((c.sov / maxSov) * 100) : 0,
  }));
}

// ─── AI visibility (placeholder until ChatGPT/Gemini campaigns wired) ────

function buildAiVisibility({ trackedKeywords }) {
  // Count keywords where AI Overview (aio) was present in latest snapshot.
  // For now this comes from the raw Semrush response in the snapshot;
  // we'll wire this through tracked_keywords.semrush_data later. Returning
  // a stub so the renderer has something to show — until the ChatGPT and
  // Gemini campaigns are pulled into the report, we surface what we know.
  return {
    note: "AI engine campaigns (ChatGPT, Gemini) configured in Semrush — separate report integration pending.",
    aio_present_count: 0,
    total_tracked: trackedKeywords.length,
  };
}

// ─── Sonnet narrative + actions ──────────────────────────────────────────

const STRATEGIST_REPORT_PROMPT = `You are Nick Brogden writing the weekly performance report for {{client.display_name}}. Same voice as the WhatsApp bot — short, contractions, direct, no marketing-speak, NEVER use "mate", no trade-craft advice (you're the marketer, they're the painter).

Two outputs:

1. **narrative**: 2 short paragraphs for the "What happened" card. First paragraph: what moved this week (use specific keywords and numbers from the data). Second paragraph: where the competitive picture sits + any AI-visibility signal worth flagging.

2. **actions**: exactly 3 things to do this week. Each action has:
   - title: short imperative sentence (under 80 chars). Marketing-only — no painting/trade-craft advice.
   - why: 1-2 sentence justification anchored in a specific data point from the report.

ONLY base your output on the data block below. Don't invent numbers. If something isn't present (e.g. no movers), say so honestly.

Reply with VALID JSON ONLY (no prose, no code fences):
{
  "narrative": [
    "First paragraph…",
    "Second paragraph…"
  ],
  "actions": [
    { "title": "...", "why": "..." },
    { "title": "...", "why": "..." },
    { "title": "...", "why": "..." }
  ]
}`;

async function synthesizeNarrative(payload) {
  if (!ANTHROPIC_API_KEY) {
    return fallbackNarrative(payload);
  }
  const dataBlock = JSON.stringify({
    client: { display_name: payload.client.display_name },
    scope: payload.scope,
    period: payload.period,
    kpis: payload.kpis,
    top_movers: payload.movers.slice(0, 6),
    competitors_top: payload.competitors.slice(0, 5),
    ai_visibility: payload.ai_visibility,
    gsc_wow: payload.gsc?.wow,
    gsc_top_queries: (payload.gsc?.queries || []).slice(0, 5),
  }, null, 2);

  const system = STRATEGIST_REPORT_PROMPT.replace(
    "{{client.display_name}}",
    payload.client.display_name
  );

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: `Data for this week:\n\n${dataBlock}` }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    const text = data.content?.[0]?.text || "";
    const parsed = JSON.parse(text);
    return {
      narrative: Array.isArray(parsed.narrative) ? parsed.narrative : [String(parsed.narrative || "")],
      actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : [],
    };
  } catch (err) {
    console.error("synthesizeNarrative failed:", err.message || err);
    return fallbackNarrative(payload);
  }
}

function fallbackNarrative(payload) {
  return {
    narrative: [
      `Weekly snapshot for ${payload.client.display_name} (${payload.scope}). Strategist narrative unavailable — raw numbers below.`,
      `Tracking ${payload.movers.length} movers this week.`,
    ],
    actions: [],
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function humanDate(d, includeYear = true) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()} ${months[d.getMonth()]}${includeYear ? " " + d.getFullYear() : ""}`;
}

module.exports = { getReportData };
