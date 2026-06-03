// Sonnet tool layer for the conversational bot.
//
// Each tool has:
//   - definition: Anthropic tool-use schema (handed to Sonnet)
//   - run: async fn that takes (input, ctx) and returns a string for the model
//
// ctx is { clientId, phoneNumber } so tools can scope to the current client.

const {
  client: supa,
  searchClientKb,
  searchPlatformKb,
} = require("./supabase.js");

// ─── tool: get_semrush_snapshot ───────────────────────────────────────────

const GET_SEMRUSH_TOOL = {
  name: "get_semrush_snapshot",
  description:
    "Pull the latest Semrush Position Tracking snapshot — THIS IS THE SOLE SOURCE for ranking, visibility, share-of-voice, and competitor data for the client. Use it whenever the user asks anything about: their current rankings, ranking movement, visibility, share of voice, competitor performance in their local area, AI Overview appearances, or how they're tracking in Cairns. Returns: visibility %, share of voice, position distribution (top 3/10/20/100 keyword counts), per-keyword positions (or '-' if not yet ranking) with AI Overview flag, and competitor SoV. Always call this before answering any ranking/visibility question — never speculate or say 'data not available' without calling it first.",
  input_schema: { type: "object", properties: {}, required: [] },
};

async function runGetSemrush(_input, _ctx) {
  const { runSemrushSnapshot } = require("./semrush.js");
  try {
    const snap = await runSemrushSnapshot();
    if (snap.skipped) return `Semrush unavailable: ${snap.skipped}`;

    const lines = [];
    const ci = snap.campaignInfo || {};
    const locName = ci.location?.name || "—";
    lines.push(`Semrush Position Tracking — ${snap.domain || "mrpaint.com.au"} (${locName}, ${ci.engine || "google"}, ${ci.device || "?"})`);

    // ── Overview block
    const o = snap.trackingOverview;
    if (o && !o.error && typeof o.visibility === "number") {
      const visDiff = typeof o.differenceVisibility === "number"
        ? ` (${o.differenceVisibility >= 0 ? "+" : ""}${o.differenceVisibility.toFixed(2)}%)`
        : "";
      const sovStr = typeof o.shareOfVoice === "number" ? o.shareOfVoice.toFixed(2) + "%" : "—";
      lines.push(`Visibility: ${o.visibility.toFixed(2)}%${visDiff}  |  SoV: ${sovStr}  |  Tracked keywords: ${o.total ?? "—"}`);
      lines.push(`Position distribution — Top 3: ${o.top3 ?? 0} | Top 10: ${o.top10 ?? 0} | Top 20: ${o.top20 ?? 0} | Top 100: ${o.top100 ?? 0} | Not ranking: ${(o.total ?? 0) - (o.all ?? 0)}`);
    } else if (o?.error) {
      lines.push(`Overview unavailable: ${o.error}`);
    }

    // ── Per-keyword positions
    const kw = snap.trackedKeywords;
    if (kw && !kw.error && kw.data) {
      lines.push("");
      lines.push("Per-keyword positions (latest snapshot):");
      const rows = Object.values(kw.data);
      for (const row of rows) {
        const dateKeys = row.Dt ? Object.keys(row.Dt).sort() : [];
        const latest = dateKeys[dateKeys.length - 1];
        const pos = latest ? row.Dt[latest]?.[snap.domain] : null;
        const posStr = pos && pos !== "-" ? `#${pos}` : "not ranking";
        const vol = row.Nq ? `vol ${row.Nq}/mo` : "vol —";
        const diff30 = row.Diff30?.[snap.domain];
        const trendStr = diff30 && diff30 !== 0 ? ` (${diff30 < 0 ? "+" : ""}${-diff30} over 30d)` : "";
        const sfToday = latest ? row.Sf?.[latest] || [] : [];
        const aioStr = sfToday.includes("aio") ? " · AI Overview present" : "";
        lines.push(`  "${row.Ph}" — ${posStr}${trendStr} · ${vol}${aioStr}`);
      }
    } else if (kw?.error) {
      lines.push(`Per-keyword data unavailable: ${kw.error}`);
    }

    // ── Competitors (top by SoV) — restricted to the client's whitelist
    //    (Supabase `competitors` table), or aggregator-filtered when empty.
    const comp = snap.trackedCompetitors;
    if (comp && !comp.error && comp.data) {
      const { filterCompetitors } = require("./competitor-filter.js");
      const clientId = _ctx?.clientId;
      let knownCompetitors = [];
      if (clientId) {
        const { data } = await supa()
          .from("competitors")
          .select("name, domain")
          .eq("client_id", clientId)
          .eq("active", true);
        knownCompetitors = data || [];
      }
      const rawRows = Object.values(comp.data).map((c) => {
        const dateKeys = c.Dt ? Object.keys(c.Dt).filter((k) => k !== "Diff").sort() : [];
        const latest = dateKeys[dateKeys.length - 1];
        const m = latest ? c.Dt[latest] : {};
        return {
          domain: c.Ur,
          sov: m?.Sov || 0,
          avgPos: m?.Av || 999,
          kwCount: m?.Mc || 0,
        };
      });
      const enriched = filterCompetitors(rawRows, knownCompetitors).sort((a, b) => b.sov - a.sov);
      lines.push("");
      if (enriched.length === 0) {
        lines.push(knownCompetitors.length === 0
          ? "Top competitors by SoV: none (no client-specified competitors logged yet — add via Supabase `competitors` table)."
          : "Top competitors by SoV: none of the client's tracked competitors had ranking data in this snapshot.");
      } else {
        const scope = knownCompetitors.length > 0 ? "client-specified competitors only" : "aggregators filtered";
        lines.push(`Top competitors by SoV (${scope}, sorted by share of voice):`);
        for (const c of enriched.slice(0, 10)) {
          const sov = (c.sov * 100).toFixed(2) + "%";
          const av = c.avgPos < 999 ? "#" + c.avgPos.toFixed(1) : "—";
          const known = knownCompetitors.find((kc) => kc.domain && c.domain && kc.domain.toLowerCase().replace(/^www\./, "") === c.domain.toLowerCase().replace(/^www\./, ""));
          const label = known?.name ? `${known.name} (${c.domain})` : c.domain;
          lines.push(`  ${label} — SoV ${sov} · avg pos ${av} · ${c.kwCount}/${kw?.total || "?"} kw ranking`);
        }
      }
    } else if (comp?.error) {
      lines.push(`Competitor data unavailable: ${comp.error}`);
    }

    lines.push("");
    lines.push(`Snapshot fetched: ${snap.fetchedAt}`);
    return lines.join("\n");
  } catch (err) {
    return `Semrush error: ${err.message || err}`;
  }
}

// ─── tool: get_gsc_data ───────────────────────────────────────────────────

const GET_GSC_TOOL = {
  name: "get_gsc_data",
  description:
    "Pull live Google Search Console data for the client. GSC tells you what people actually SEARCHED to find the site, how many clicks/impressions each query and page earned, and the average ranking position Google recorded. Use this when the user asks about: 'what searches brought traffic', 'top queries', 'which page is getting traffic', 'what's growing/declining in Google traffic', 'clicks this week vs last week', 'what's my CTR for X', or for any GSC-style click/impression question. This data is COMPLEMENTARY to Semrush — Semrush shows where you rank, GSC shows what you're actually getting clicked for.",
  input_schema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        enum: ["overview", "top_queries", "top_pages", "wow"],
        description: "Which view to pull. overview = totals for the period. top_queries = search terms with clicks/impressions/position. top_pages = highest-clicked pages. wow = week-over-week comparison (last 7 days vs prior 7).",
      },
      days: {
        type: "integer",
        description: "Days back to pull (default 28). Ignored for view='wow'.",
      },
      limit: {
        type: "integer",
        description: "Row limit for top_queries / top_pages (default 25, max 100).",
      },
    },
    required: ["view"],
  },
};

async function runGetGsc({ view, days = 28, limit = 25 }, _ctx) {
  let gsc;
  try {
    gsc = require("./gsc-oauth.js");
  } catch (err) {
    return `GSC module not available: ${err.message || err}`;
  }
  const cappedLimit = Math.max(1, Math.min(100, limit));
  try {
    if (view === "overview") {
      const o = await gsc.getOverview({ days });
      return `GSC overview — ${o.startDate} → ${o.endDate} (${o.days}d)\n` +
        `  Clicks: ${o.clicks}\n  Impressions: ${o.impressions}\n  Avg CTR: ${o.ctr}%\n  Avg position: ${o.position}`;
    }
    if (view === "top_queries") {
      const rows = await gsc.getTopQueries({ days, limit: cappedLimit });
      if (!rows.length) return `GSC top queries (last ${days}d): no data.`;
      return `GSC top queries (last ${days}d, top ${rows.length}):\n` +
        rows.map((r, i) => `  ${i + 1}. "${r.query}" — ${r.clicks} clicks · ${r.impressions} impr · ${r.ctr}% CTR · avg pos ${r.position}`).join("\n");
    }
    if (view === "top_pages") {
      const rows = await gsc.getTopPages({ days, limit: cappedLimit });
      if (!rows.length) return `GSC top pages (last ${days}d): no data.`;
      return `GSC top pages (last ${days}d, top ${rows.length}):\n` +
        rows.map((r, i) => `  ${i + 1}. ${r.page} — ${r.clicks} clicks · ${r.impressions} impr · ${r.ctr}% CTR · avg pos ${r.position}`).join("\n");
    }
    if (view === "wow") {
      const w = await gsc.getWeekOverWeek();
      const dClicks = w.delta.clicks_pct != null ? `${w.delta.clicks_pct >= 0 ? "+" : ""}${w.delta.clicks_pct}%` : "n/a";
      const dImpr = w.delta.impressions_pct != null ? `${w.delta.impressions_pct >= 0 ? "+" : ""}${w.delta.impressions_pct}%` : "n/a";
      const dPos = w.delta.position_diff != null ? `${w.delta.position_diff >= 0 ? "+" : ""}${w.delta.position_diff}` : "n/a";
      return `GSC week-over-week\n` +
        `  This week (${w.this_week.startDate} → ${w.this_week.endDate}): ${w.this_week.clicks} clicks · ${w.this_week.impressions} impr · CTR ${w.this_week.ctr}% · avg pos ${w.this_week.position}\n` +
        `  Prev week (${w.prev_week.startDate} → ${w.prev_week.endDate}): ${w.prev_week.clicks} clicks · ${w.prev_week.impressions} impr · CTR ${w.prev_week.ctr}% · avg pos ${w.prev_week.position}\n` +
        `  Delta: clicks ${dClicks} · impressions ${dImpr} · position ${dPos}`;
    }
    return `Unknown view: ${view}`;
  } catch (err) {
    return `GSC error: ${err.message || err}`;
  }
}

// ─── tool: get_keyword_research ────────────────────────────────────────────

const GET_KW_TOOL = {
  name: "get_keyword_research",
  description:
    "Look up volume, CPC, difficulty, and related/long-tail variants for a single keyword phrase using Semrush. Use when the user wants to know how a specific phrase would perform, or to find adjacent keyword opportunities.",
  input_schema: {
    type: "object",
    properties: {
      phrase: {
        type: "string",
        description: "The keyword phrase to research (e.g. 'painter trinity beach' or 'queenslander exterior repaint cost')",
      },
    },
    required: ["phrase"],
  },
};

async function runKeywordResearch({ phrase }, _ctx) {
  if (!phrase) return "phrase is required";
  const { keywordOverview, keywordRelated } = require("./semrush.js");
  const database = process.env.SEMRUSH_DATABASE || "au";
  try {
    const [overview, related] = await Promise.all([
      keywordOverview(phrase, database),
      keywordRelated(phrase, { database, limit: 12 }),
    ]);
    const lines = [];
    lines.push(`Semrush · "${phrase}" · ${database.toUpperCase()}`);
    if (overview) {
      lines.push(`  Volume: ${overview.volume ?? "?"}   CPC: $${overview.cpc ?? "?"}   Difficulty: ${overview.difficulty ?? "?"}`);
    }
    if (Array.isArray(related) && related.length) {
      lines.push("");
      lines.push("Related keywords:");
      for (const k of related.slice(0, 12)) {
        lines.push(`  ${k.keyword} · vol ${k.volume ?? "?"}`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `Semrush keyword research failed: ${err.message || err}`;
  }
}

// ─── tool: search_client_kb ───────────────────────────────────────────────

const SEARCH_CLIENT_TOOL = {
  name: "search_client_kb",
  description:
    "Semantic search the client's own knowledge base (their voice notes, captured jobs, past content, photos, and historical events). Use when you need specific information about THIS client's business that may have been mentioned previously. Returns top matching chunks with similarity scores.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language query to search the client KB" },
      count: { type: "integer", description: "How many results to return (1-10, default 5)" },
    },
    required: ["query"],
  },
};

async function runSearchClientKb({ query, count = 5 }, ctx) {
  if (!query) return "query is required";
  const rows = await searchClientKb(ctx.clientId, query, { count: Math.max(1, Math.min(10, count)) });
  if (!rows.length) return `No matches in client KB for "${query}".`;
  return rows.map((r, i) =>
    `[${i + 1}] [${r.source_type}${r.source_date ? " · " + r.source_date.slice(0, 10) : ""}] sim=${r.similarity.toFixed(3)}\n${r.chunk_text.slice(0, 400)}${r.chunk_text.length > 400 ? "…" : ""}`
  ).join("\n\n");
}

// ─── tool: search_platform_kb ─────────────────────────────────────────────

const SEARCH_PLATFORM_TOOL = {
  name: "search_platform_kb",
  description:
    "Semantic search the platform-wide marketing/SEO/local-SEO/GBP/reviews knowledge base. Use when the user asks about a best practice, a tactic, or how to do something that isn't client-specific (e.g. 'how should I structure a Google Business Profile post', 'what's the right way to chase reviews').",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language query to search the platform KB" },
      count: { type: "integer", description: "How many results to return (1-10, default 5)" },
    },
    required: ["query"],
  },
};

async function runSearchPlatformKb({ query, count = 5 }, _ctx) {
  if (!query) return "query is required";
  const rows = await searchPlatformKb(query, { count: Math.max(1, Math.min(10, count)) });
  if (!rows.length) return `No matches in platform KB for "${query}".`;
  return rows.map((r, i) =>
    `[${i + 1}] [${r.source}] sim=${r.similarity.toFixed(3)}\n${r.chunk_text.slice(0, 400)}${r.chunk_text.length > 400 ? "…" : ""}`
  ).join("\n\n");
}

// ─── tool: get_recent_jobs ───────────────────────────────────────────────

const GET_JOBS_TOOL = {
  name: "get_recent_jobs",
  description:
    "Get the client's recently captured jobs from the database. Each job has a suburb, job type, brands used, photos, and any notes captured at the time. Use when the user asks 'what jobs did I do last week', 'have we worked in <suburb>', or wants to reference a specific past job.",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Max jobs to return (1-30, default 10)" },
      suburb: { type: "string", description: "Optional suburb filter (e.g. 'Edge Hill')" },
    },
    required: [],
  },
};

async function runGetRecentJobs({ limit = 10, suburb = null }, ctx) {
  let q = supa()
    .from("jobs")
    .select("id, captured_at, suburb, summary, status, structured_facts, media_public")
    .eq("client_id", ctx.clientId)
    .order("captured_at", { ascending: false })
    .limit(Math.max(1, Math.min(30, limit)));
  if (suburb) q = q.ilike("suburb", suburb);
  const { data, error } = await q;
  if (error) return `Jobs query failed: ${error.message}`;
  if (!data || !data.length) return suburb ? `No jobs captured in ${suburb} yet.` : "No jobs captured yet.";
  return data.map((j) => {
    const date = j.captured_at?.slice(0, 10) || "?";
    const photos = Array.isArray(j.media_public) ? j.media_public.length : 0;
    const facts = j.structured_facts && Object.keys(j.structured_facts).length
      ? " · " + Object.entries(j.structured_facts).slice(0, 3).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ")
      : "";
    return `${date} · ${j.suburb || "?"} · ${j.status || "?"} · ${photos} photos${facts}${j.summary ? "\n  " + j.summary.slice(0, 200) : ""}`;
  }).join("\n");
}

// ─── tool: capture_job ────────────────────────────────────────────────────

const CAPTURE_JOB_TOOL = {
  name: "capture_job",
  description:
    "Save a new job to the client's job log. Use when the user describes a job they just completed or is describing in their message — e.g. 'just finished a Queenslander strip and repaint in Bungalow with Dulux 1Step PSU and a Festool'. Capture whatever fields they mentioned; leave the rest null.",
  input_schema: {
    type: "object",
    properties: {
      suburb: { type: "string", description: "Cairns suburb the job is in" },
      summary: { type: "string", description: "One-line summary of the job (e.g. 'Full weatherboard strip and repaint, high-set Queenslander, Dulux 1Step PSU')" },
      job_type: { type: "string", description: "Short category for structured_facts (e.g. 'exterior_repaint', 'pressure_wash', 'commercial_fitout', 'roof')" },
      brands_used: {
        type: "array",
        items: { type: "string" },
        description: "Paint/tool brands mentioned (e.g. ['Sikkens', 'Dulux', 'Festool'])",
      },
      architectural_style: { type: "string", description: "Optional style (e.g. 'high-set Queenslander', 'fibro cottage')" },
      raw_transcript: { type: "string", description: "Adrian's original words if you have them — voice-note transcript or full text of what he sent" },
    },
    required: ["suburb", "summary"],
  },
};

async function runCaptureJob(input, ctx) {
  const structured_facts = {};
  if (input.job_type) structured_facts.job_type = input.job_type;
  if (input.brands_used?.length) structured_facts.brands_used = input.brands_used;
  if (input.architectural_style) structured_facts.architectural_style = input.architectural_style;
  const { data, error } = await supa()
    .from("jobs")
    .insert({
      client_id: ctx.clientId,
      captured_at: new Date().toISOString(),
      suburb: input.suburb,
      summary: input.summary,
      raw_transcript: input.raw_transcript || null,
      structured_facts,
      status: "capturing",
    })
    .select()
    .single();
  if (error) return `Job capture failed: ${error.message}`;
  return `Saved job: ${data.suburb} · ${data.summary?.slice(0, 80) || "?"} · id ${data.id.slice(0, 8)}`;
}

// ─── tool: schedule_reminder ─────────────────────────────────────────────

const SCHEDULE_REMINDER_TOOL = {
  name: "schedule_reminder",
  description:
    "Set a reminder for the client. Use when they say things like 'remind me on Thursday', 'follow up Sam tomorrow', 'nudge me about that in a week'. Convert relative times ('Thursday', 'next week') to absolute ISO8601 timestamps in Brisbane time (UTC+10, no DST).",
  input_schema: {
    type: "object",
    properties: {
      fire_at: {
        type: "string",
        description: "ISO 8601 timestamp with timezone offset (Brisbane = +10:00). E.g. '2026-06-05T08:00:00+10:00'",
      },
      message: { type: "string", description: "What to remind them about, in their voice (no 'mate', no marketing-speak)" },
    },
    required: ["fire_at", "message"],
  },
};

async function runScheduleReminder({ fire_at, message }, ctx) {
  if (!fire_at || !message) return "fire_at and message are required";
  const ts = new Date(fire_at);
  if (Number.isNaN(ts.getTime())) return `Invalid timestamp: ${fire_at}`;
  const { data, error } = await supa()
    .from("reminders")
    .insert({
      client_id: ctx.clientId,
      fire_at: ts.toISOString(),
      message,
      status: "pending",
      source: "conversation",
    })
    .select()
    .single();
  if (error) return `Reminder failed: ${error.message}`;
  return `Reminder set for ${ts.toISOString()} (id ${data.id.slice(0, 8)}): ${message}`;
}

// ─── tool: list_competitors ───────────────────────────────────────────────

const LIST_COMPETITORS_TOOL = {
  name: "list_competitors",
  description:
    "Return the competitor NAMES logged for this client (e.g. 'Cairns Painting Contractors'). This returns only the static list of named competitors — it does NOT contain ranking, visibility, or share-of-voice data. For 'who is beating me', 'where am I losing', or any performance-comparison question you MUST ALSO call get_semrush_snapshot which returns the actual SoV and per-keyword competitor positions from Semrush.",
  input_schema: { type: "object", properties: {}, required: [] },
};

async function runListCompetitors(_input, ctx) {
  const { data, error } = await supa()
    .from("competitors")
    .select("name, domain, notes")
    .eq("client_id", ctx.clientId);
  if (error) return `Competitors query failed: ${error.message}`;
  if (!data?.length) return "No competitors logged yet.";
  return data.map((c) => `- ${c.name} (${c.domain})${c.notes ? " — " + c.notes : ""}`).join("\n");
}

// ─── registry + dispatcher ───────────────────────────────────────────────

const TOOLS = [
  { def: GET_SEMRUSH_TOOL,         run: runGetSemrush },
  { def: GET_GSC_TOOL,             run: runGetGsc },
  { def: GET_KW_TOOL,              run: runKeywordResearch },
  { def: SEARCH_CLIENT_TOOL,       run: runSearchClientKb },
  { def: SEARCH_PLATFORM_TOOL,     run: runSearchPlatformKb },
  { def: GET_JOBS_TOOL,            run: runGetRecentJobs },
  { def: CAPTURE_JOB_TOOL,         run: runCaptureJob },
  { def: SCHEDULE_REMINDER_TOOL,   run: runScheduleReminder },
  { def: LIST_COMPETITORS_TOOL,    run: runListCompetitors },
];

const TOOL_DEFINITIONS = TOOLS.map((t) => t.def);
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.def.name, t]));

async function dispatch(name, input, ctx) {
  const tool = TOOL_BY_NAME[name];
  if (!tool) return `Unknown tool: ${name}`;
  try {
    const result = await tool.run(input || {}, ctx);
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err) {
    return `Tool ${name} threw: ${err.message || err}`;
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  dispatch,
};
