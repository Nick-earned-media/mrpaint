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

// ─── tool: request_competitor_addition ───────────────────────────────────

const REQUEST_COMPETITOR_TOOL = {
  name: "request_competitor_addition",
  description:
    "Queue a competitor-add request for Nick to action manually. Use IMMEDIATELY when the user names a specific competitor they want tracked — e.g. 'add Cairns Painting Contractors as a competitor', 'track cairnspainter.com.au', 'watch [name]'. " +
    "IMPORTANT: This does NOT add the competitor to the live tracking immediately. Semrush Position Tracking requires manual setup in their UI which only Nick can do, so this tool just queues the request and fires a Slack notification. The competitor will be live within 24 hours. " +
    "Call once per competitor. The user-facing message you return after should set the 24-hour expectation. " +
    "ALWAYS prefer a website URL over a name. If the user only gave a name, ask them for the URL before calling this tool. If they gave a URL but no name, pass the domain as the name. " +
    "DO NOT call get_semrush_snapshot first to 'verify' a competitor — the tool itself validates aggregators and obvious junk. Just call this directly.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Display name of the competitor (e.g. 'Cairns Painting Contractors'). If not given by user, pass the domain." },
      domain: { type: "string", description: "Competitor's domain (e.g. 'cairnspaintingcontractors.com.au') — strip http:// and www. Required." },
    },
    required: ["domain"],
  },
};

async function runRequestCompetitor({ name, domain }, ctx) {
  const { isBrandAggregator, normalizeDomain } = require("./competitor-filter.js");
  const { notifyCompetitorRequest } = require("./slack.js");
  if (!domain) return "I need a website URL to queue this — what's the competitor's domain?";
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return `'${domain}' doesn't look like a valid domain — can you double-check the URL?`;
  if (isBrandAggregator(cleanDomain)) {
    return `${cleanDomain} is a marketplace/aggregator, not a competitor. Try a specific local painting business instead.`;
  }
  const displayName = name || cleanDomain;
  await notifyCompetitorRequest({
    clientName: ctx.clientRow?.display_name || "client",
    action: "add",
    name: displayName,
    domain: cleanDomain,
    requestedBy: ctx.phoneNumber || "unknown",
  });
  return `Queued ${displayName} (${cleanDomain}) for tracking — Nick's been pinged and it'll be live within 24 hours.`;
}

// ─── tool: remove_competitor ─────────────────────────────────────────────

const REMOVE_COMPETITOR_TOOL = {
  name: "remove_competitor",
  description:
    "Queue a competitor-removal request for Nick to action manually. Use when the user asks to stop tracking, remove, or drop a competitor — e.g. 'stop tracking Cairns Painter', 'remove [name]'. Accepts either the name or the domain. Like the add tool, this does NOT immediately remove — it queues for Nick and fires a Slack notification. 24-hour SLA.",
  input_schema: {
    type: "object",
    properties: {
      name_or_domain: { type: "string", description: "Either the competitor's name or their domain" },
    },
    required: ["name_or_domain"],
  },
};

async function runRemoveCompetitor({ name_or_domain }, ctx) {
  const { notifyCompetitorRequest } = require("./slack.js");
  if (!name_or_domain) return "Which competitor do you want to drop?";
  await notifyCompetitorRequest({
    clientName: ctx.clientRow?.display_name || "client",
    action: "remove",
    name: name_or_domain,
    domain: name_or_domain,
    requestedBy: ctx.phoneNumber || "unknown",
  });
  return `Queued '${name_or_domain}' for removal — Nick's been pinged and it'll be off your tracking within 24 hours.`;
}

// ─── tool: submit_report_feedback ────────────────────────────────────────

const SUBMIT_FEEDBACK_TOOL = {
  name: "submit_report_feedback",
  description:
    "Submit the client's feedback about the weekly report after a short interview. Use ONLY after you've had a back-and-forth conversation about what they like, don't like, or want to see differently in the report — don't call this on the first message. Each field is optional; populate the ones that came up. Fires a Slack notification to Nick so he can act on the feedback.",
  input_schema: {
    type: "object",
    properties: {
      wants_more_of: { type: "string", description: "What the user wants MORE of in the report (e.g. 'specific keywords to target', 'visual charts of trends')" },
      wants_less_of: { type: "string", description: "What the user wants LESS of (e.g. 'less Semrush jargon', 'shorter narrative')" },
      other_changes: { type: "string", description: "Any other change request (format, frequency, channels, etc.)" },
      raw_transcript: { type: "string", description: "Short paraphrase of the user's own words for context" },
    },
    required: [],
  },
};

async function runSubmitFeedback(input, ctx) {
  const { notifyReportFeedback } = require("./slack.js");
  const feedback = {
    wants_more_of: input.wants_more_of || null,
    wants_less_of: input.wants_less_of || null,
    other_changes: input.other_changes || null,
    raw_transcript: input.raw_transcript || null,
  };
  if (!feedback.wants_more_of && !feedback.wants_less_of && !feedback.other_changes && !feedback.raw_transcript) {
    return "Nothing to submit yet — keep the conversation going and call this once you have at least one concrete piece of feedback.";
  }
  await notifyReportFeedback({
    clientName: ctx.clientRow?.display_name || "client",
    feedback,
  });
  return "Feedback recorded and sent to Nick. He'll review and update your report.";
}

// ─── tool: check_ai_overview ─────────────────────────────────────────────

const AI_OVERVIEW_TOOL = {
  name: "check_ai_overview",
  description:
    "Check whether Google currently shows an AI Overview for a specific keyword in Cairns, and whether the client's domain is cited. Use when the user asks: 'am I in AI Overviews', 'does Google show an AI answer for X', 'who's being cited in AI Overviews for [keyword]', 'is my site referenced when people search X on Google'. This is LIVE data from Google's actual SERP right now (not Semrush's lagged tracking). Returns: present (true/false), text snippet, citation list (domains + URLs), and whether MrPaint is cited.",
  input_schema: {
    type: "object",
    properties: {
      keyword: { type: "string", description: "The exact search query (e.g. 'painter Edge Hill Cairns', 'how much to paint a house in Cairns')" },
    },
    required: ["keyword"],
  },
};

async function runCheckAIOverview({ keyword }, ctx) {
  if (!keyword) return "Need a keyword to check.";
  const { getAIOverview } = require("./dataforseo.js");
  const domain = ctx.clientRow?.semrush_domain || ctx.clientRow?.site_url?.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || "mrpaint.com.au";
  const r = await getAIOverview(keyword, domain, ctx);
  if (!r.ok) return `AI Overview check failed: ${r.error}`;
  if (!r.present) return `No AI Overview shown for "${keyword}" right now. Google didn't generate one for this query.`;
  const lines = [
    `AI Overview FOUND for "${keyword}":`,
    `Mentioned: ${r.client_mentioned ? "YES — " + domain + " is cited" : "NO — " + domain + " is not cited"}`,
    `Text snippet: ${r.text || "(no text returned)"}`,
    `Citations (${r.citations.length}):`,
    ...r.citations.map((c, i) => `  ${i + 1}. ${c.domain || "?"} — ${c.title || "?"}`),
  ];
  return lines.join("\n");
}

// ─── tool: check_llm_mentions ────────────────────────────────────────────

const LLM_MENTIONS_TOOL = {
  name: "check_llm_mentions",
  description:
    "Check whether the client's domain is being cited by AI assistants (ChatGPT, Gemini, Perplexity, Claude) when users ask about a specific topic or query. Use when the user asks: 'am I mentioned in ChatGPT', 'do AI tools recommend us', 'who's getting cited in AI search', 'am I in Perplexity for [topic]'. This is true AI-visibility data — NOT Google AI Overviews (use check_ai_overview for those). Returns: list of LLM engines + the questions they were asked + whether the client was cited + the other domains cited.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Topic or question to test against LLMs (e.g. 'best painter in Cairns', 'how to choose an exterior paint colour Australia')" },
    },
    required: ["query"],
  },
};

async function runCheckLLMMentions({ query }, ctx) {
  if (!query) return "Need a topic/query to check.";
  const { getLLMMentions } = require("./dataforseo.js");
  const domain = ctx.clientRow?.semrush_domain || ctx.clientRow?.site_url?.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || "mrpaint.com.au";
  const r = await getLLMMentions(domain, query, ctx);
  if (!r.ok) return `LLM mentions check failed: ${r.error}`;
  if (r.mentions.length === 0) {
    return `No LLM mention data returned for "${query}" against ${domain}. Could mean: not enough query volume across AI engines, or the topic isn't being asked of LLMs yet.`;
  }
  const youCited = r.mentions.filter((m) => m.domain_cited).length;
  const lines = [
    `LLM mentions for "${query}" (${domain}):`,
    `Cited: ${youCited}/${r.mentions.length} responses${r.ai_search_volume ? ` · AI search volume: ${r.ai_search_volume}/mo` : ""}`,
    "",
    ...r.mentions.map((m, i) => {
      const tag = m.domain_cited ? "✓ CITED" : "✗ not cited";
      const others = m.all_cited.length ? ` · others: ${m.all_cited.join(", ")}` : "";
      return `${i + 1}. [${m.engine}] ${tag}${others}\n   Q: ${m.question}\n   A: ${m.answer_snippet || "(no snippet)"}`;
    }),
  ];
  return lines.join("\n");
}

// ─── tool: get_live_serp ─────────────────────────────────────────────────

const LIVE_SERP_TOOL = {
  name: "get_live_serp",
  description:
    "Pull the live page-1 Google SERP for a keyword in Cairns (top 10 organic + local pack). Use when the user asks 'who's actually ranking right now for X', 'who's beating me for [keyword]', 'show me the SERP for X', 'who's in the local pack for painter Edge Hill'. This is REAL-TIME data — the live page-1 of Google right now, not last week's Semrush snapshot. Returns: organic top 10 (position, domain, title, snippet) + local pack (top 3 with ratings + reviews if present) + a list of SERP features detected.",
  input_schema: {
    type: "object",
    properties: {
      keyword: { type: "string", description: "The exact search query (e.g. 'painter Edge Hill', 'cairns painting contractors')" },
    },
    required: ["keyword"],
  },
};

async function runGetLiveSerp({ keyword }, ctx) {
  if (!keyword) return "Need a keyword.";
  const { getLiveSerp } = require("./dataforseo.js");
  const r = await getLiveSerp(keyword, ctx);
  if (!r.ok) return `Live SERP fetch failed: ${r.error}`;

  // Surface whether the client's own domain is on page 1 — this is the
  // single most useful fact the bot can return for "do I rank" questions.
  const clientDomainRaw = ctx.clientRow?.semrush_domain
    || ctx.clientRow?.site_url?.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
    || "mrpaint.com.au";
  const clientDomain = clientDomainRaw.toLowerCase().replace(/^www\./, "");
  const matchOrganic = r.organic.find((o) => (o.domain || "").toLowerCase().replace(/^www\./, "") === clientDomain);
  const matchLocal   = r.local_pack.find((lp) => (lp.domain || "").toLowerCase().replace(/^www\./, "") === clientDomain);

  const lines = [`Live Google SERP for "${keyword}" — checked from ${r.location}, top 10 + local pack:`];
  lines.push("");
  if (matchOrganic) {
    lines.push(`✓ ${clientDomainRaw} IS on page 1 — organic position ${matchOrganic.position}.`);
  } else if (matchLocal) {
    lines.push(`✓ ${clientDomainRaw} IS in the local pack at position ${matchLocal.position} (no organic page-1 listing).`);
  } else {
    lines.push(`✗ ${clientDomainRaw} is NOT on page 1 for "${keyword}" in ${r.location}.`);
  }

  if (r.local_pack.length > 0) {
    lines.push("");
    lines.push("Local Pack (map results):");
    r.local_pack.forEach((lp, i) => {
      const rating = lp.rating ? ` ${lp.rating}★ (${lp.reviews || 0} reviews)` : "";
      lines.push(`  ${i + 1}. ${lp.title}${rating}${lp.address ? " · " + lp.address : ""}${lp.domain ? " · " + lp.domain : ""}`);
    });
  }
  if (r.organic.length > 0) {
    lines.push("");
    lines.push("Organic top 10:");
    r.organic.forEach((o) => {
      const marker = (o.domain || "").toLowerCase().replace(/^www\./, "") === clientDomain ? " ← YOU" : "";
      lines.push(`  ${o.position}. ${o.domain}${marker}`);
      lines.push(`     ${o.title}`);
      if (o.snippet) lines.push(`     ${o.snippet}`);
    });
  } else {
    lines.push("");
    lines.push("No organic results returned (unusual — may be a paid-heavy SERP).");
  }
  if (r.features.length > 0) {
    lines.push("");
    lines.push(`SERP features present: ${r.features.join(", ")}`);
  }
  return lines.join("\n");
}

const TOOLS = [
  { def: GET_SEMRUSH_TOOL,            run: runGetSemrush },
  { def: GET_GSC_TOOL,                run: runGetGsc },
  { def: GET_KW_TOOL,                 run: runKeywordResearch },
  { def: SEARCH_CLIENT_TOOL,          run: runSearchClientKb },
  { def: SEARCH_PLATFORM_TOOL,        run: runSearchPlatformKb },
  { def: GET_JOBS_TOOL,               run: runGetRecentJobs },
  { def: CAPTURE_JOB_TOOL,            run: runCaptureJob },
  { def: SCHEDULE_REMINDER_TOOL,      run: runScheduleReminder },
  { def: LIST_COMPETITORS_TOOL,       run: runListCompetitors },
  { def: REQUEST_COMPETITOR_TOOL,     run: runRequestCompetitor },
  { def: REMOVE_COMPETITOR_TOOL,      run: runRemoveCompetitor },
  { def: SUBMIT_FEEDBACK_TOOL,        run: runSubmitFeedback },
  { def: AI_OVERVIEW_TOOL,            run: runCheckAIOverview },
  { def: LLM_MENTIONS_TOOL,           run: runCheckLLMMentions },
  { def: LIVE_SERP_TOOL,              run: runGetLiveSerp },
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
