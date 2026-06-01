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

// ─── tool: get_rankings ───────────────────────────────────────────────────

const GET_RANKINGS_TOOL = {
  name: "get_rankings",
  description:
    "Pull current Ahrefs Rank Tracker positions for the client's tracked keywords, plus 7-day and 30-day deltas. Use when the user asks about ranking movement, position changes, or which keywords are tracked. Returns a summarised string.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

async function runGetRankings(_input, _ctx) {
  const { fetchRankings } = require("./rankings.js");
  const r = await fetchRankings();
  if (r.skipped) return `Rankings unavailable: ${r.skipped}`;
  if (r.error) return `Rankings error: ${r.error}`;

  const lines = [];
  lines.push(`Ahrefs Rank Tracker — ${r.projectName || "mrpaint.com.au"}`);
  lines.push(`Tracked keywords: ${r.totalKeywords ?? "?"}`);
  if (r.summary) lines.push(`Top movers (last 7d): ${r.summary}`);
  if (Array.isArray(r.topKeywords) && r.topKeywords.length) {
    lines.push("");
    lines.push("Top tracked keywords:");
    for (const k of r.topKeywords.slice(0, 12)) {
      const delta7 = k.delta7 != null ? ` (${k.delta7 > 0 ? "+" : ""}${k.delta7} vs 7d)` : "";
      lines.push(`  ${k.keyword} → #${k.position ?? "?"}${delta7}`);
    }
  }
  if (Array.isArray(r.gainers) && r.gainers.length) {
    lines.push("");
    lines.push("Biggest gainers (7d):");
    for (const k of r.gainers.slice(0, 5)) lines.push(`  +${k.delta7} ${k.keyword} → #${k.position}`);
  }
  if (Array.isArray(r.losers) && r.losers.length) {
    lines.push("");
    lines.push("Biggest losers (7d):");
    for (const k of r.losers.slice(0, 5)) lines.push(`  ${k.delta7} ${k.keyword} → #${k.position}`);
  }
  return lines.join("\n");
}

// ─── tool: get_semrush_snapshot ───────────────────────────────────────────

const GET_SEMRUSH_TOOL = {
  name: "get_semrush_snapshot",
  description:
    "Pull a Semrush Position Tracking snapshot: domain overview metrics (visibility, traffic estimate) plus competitor share-of-voice. Use when the user asks about overall search visibility, organic estimates, or how they compare to local competitors in Semrush. Returns a summarised string.",
  input_schema: { type: "object", properties: {}, required: [] },
};

async function runGetSemrush(_input, _ctx) {
  const { runSemrushSnapshot } = require("./semrush.js");
  try {
    const snap = await runSemrushSnapshot();
    if (snap.skipped) return `Semrush unavailable: ${snap.skipped}`;
    const lines = [];
    lines.push(`Semrush Position Tracking — ${snap.domain || "mrpaint.com.au"}`);
    if (snap.overview) {
      const o = snap.overview;
      lines.push(`Visibility: ${o.visibility ?? "?"}%   Est. traffic: ${o.traffic ?? "?"}`);
      if (o.keywords != null) lines.push(`Keywords tracked: ${o.keywords}`);
    }
    if (Array.isArray(snap.topKeywords) && snap.topKeywords.length) {
      lines.push("");
      lines.push("Top keywords:");
      for (const k of snap.topKeywords.slice(0, 10)) {
        lines.push(`  ${k.keyword} → #${k.position ?? "?"} · vol ${k.volume ?? "?"}`);
      }
    }
    if (Array.isArray(snap.competitors) && snap.competitors.length) {
      lines.push("");
      lines.push("Competitors (visibility share):");
      for (const c of snap.competitors.slice(0, 5)) {
        lines.push(`  ${c.domain} — vis ${c.visibility ?? "?"}%`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `Semrush error: ${err.message || err}`;
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
    "Return the competitors logged for this client. Use when the user asks 'who are my competitors', or before talking about specific competitor performance.",
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
  { def: GET_RANKINGS_TOOL,        run: runGetRankings },
  { def: GET_SEMRUSH_TOOL,         run: runGetSemrush },
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
