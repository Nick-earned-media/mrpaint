// Semrush integration — Domain Analytics API + keyword research.
//
// Uses the public CSV-returning Analytics API at api.semrush.com. Designed
// for snapshots / weekly digests, not realtime dashboards. Each call
// consumes API units against the Semrush account's quota.
//
// Position Tracking and Site Audit live in the Projects API which needs a
// project ID — those are stubbed at the bottom for when the Semrush project
// is fully set up.
//
// Env vars:
//   SEMRUSH_API_KEY        — required. From Semrush profile → Subscription info.
//   SEMRUSH_DATABASE       — country/database code. Default "au".
//   SEMRUSH_DOMAIN         — domain to analyse. Default "mrpaint.com.au".
//   SEMRUSH_COMPETITORS    — comma-separated list of competitor domains.
//                            Falls back to COMPETITORS if not set.
//   SEMRUSH_PROJECT_ID     — optional; needed for Position Tracking + Site Audit.

const BASE = "https://api.semrush.com/";
const DEFAULT_DB = "au";
const DEFAULT_DOMAIN = "mrpaint.com.au";

// ─── Generic request + CSV parsing ────────────────────────────────────────

async function semrushRequest(params) {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) {
    const err = new Error("SEMRUSH_API_KEY not set");
    err.skipped = true;
    throw err;
  }
  const qs = new URLSearchParams({ key, ...params }).toString();
  const url = `${BASE}?${qs}`;
  const r = await fetch(url, { method: "GET" });
  const text = await r.text();
  if (!r.ok) throw new Error(`Semrush ${r.status}: ${text.slice(0, 200)}`);
  // Semrush returns "ERROR ..." text-body for app-level errors (200 status).
  if (text.startsWith("ERROR")) {
    if (/NOTHING FOUND|NOT FOUND/i.test(text)) return [];
    throw new Error(`Semrush API: ${text.slice(0, 200)}`);
  }
  return parseSemrushCsv(text);
}

// Semrush returns CSV with the FULL English column names in the header row
// (e.g. "Organic Keywords") even though we requested data by short code
// (e.g. "Or"). Normalise so our accessors can stay as short codes.
const HEADER_MAP = {
  "Database": "Db",
  "Domain": "Dn",
  "Rank": "Rk",
  "Organic Keywords": "Or",
  "Organic Traffic": "Ot",
  "Organic Cost": "Oc",
  "Adwords Keywords": "Ad",
  "Adwords Traffic": "At",
  "Adwords Cost": "Ac",
  "Keyword": "Ph",
  "Position": "Po",
  "Previous Position": "Pp",
  "Position Difference": "Pd",
  "Search Volume": "Nq",
  "CPC": "Cp",
  "URL": "Ur",
  "Traffic (%)": "Tr",
  "Traffic": "Tr",
  "Traffic Cost (%)": "Tc",
  "Competition": "Co",
  "Number of Results": "Nr",
  "Results": "Nr",
  "Trends": "Td",
  "Competitor Relevance": "Cr",
  "Competition Level": "Cr",
  "Common Keywords": "Np",
  // Position Tracking columns
  "Visibility": "Vu",
  "Visibility (%)": "Vu",
  "Average Position": "Av",
  "Estimated Traffic": "Tt",
  "Total Traffic": "Tt",
  "Coverage": "Cv",
  "Coverage (%)": "Cv",
  "Tracked Keywords": "Tn",
};

function parseSemrushCsv(text) {
  const lines = text.split("\n").filter((l) => l.length);
  if (lines.length < 2) return [];
  const headers = lines[0].split(";").map((h) => {
    const trimmed = h.trim();
    return HEADER_MAP[trimmed] || trimmed;  // map long → short, fall back to as-is
  });
  return lines.slice(1).map((line) => {
    const cells = line.split(";");
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || "").trim(); });
    return row;
  });
}

// ─── Endpoint wrappers ────────────────────────────────────────────────────

// Domain summary: traffic, keywords, paid keywords. CSV columns:
//   Database, Domain, Rank, Organic Keywords, Organic Traffic,
//   Organic Cost, Adwords Keywords, Adwords Traffic, Adwords Cost.
async function domainOverview(domain, database = DEFAULT_DB) {
  const rows = await semrushRequest({
    type: "domain_ranks",
    domain,
    database,
    export_columns: "Db,Dn,Rk,Or,Ot,Oc,Ad,At,Ac",
  });
  return rows[0] || null;
}

// Top organic keywords this domain ranks for. CSV columns:
//   Keyword, Position, Position Difference, Previous Position, Search Volume,
//   CPC, URL, Traffic %, Cost %, Competition, Results, Trends.
async function domainOrganicKeywords(domain, { database = DEFAULT_DB, limit = 20 } = {}) {
  return semrushRequest({
    type: "domain_organic",
    domain,
    database,
    display_limit: String(limit),
    export_columns: "Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr,Co,Nr",
  });
}

// Organic competitors — other domains ranking for the same keywords.
//   Domain, Competitive Level, Common Keywords, Organic Keywords,
//   Organic Traffic, Adwords Keywords.
async function domainOrganicCompetitors(domain, { database = DEFAULT_DB, limit = 10 } = {}) {
  return semrushRequest({
    type: "domain_organic_organic",
    domain,
    database,
    display_limit: String(limit),
    export_columns: "Dn,Cr,Np,Or,Ot,Ad",
  });
}

// New + lost keywords vs previous report period (~30 days back).
//   Keyword, Position, Position Difference, Previous Position, Search Volume,
//   CPC, URL, Traffic %, Cost %, Difference (chg type).
async function domainNewLost(domain, { database = DEFAULT_DB, limit = 20 } = {}) {
  return semrushRequest({
    type: "domain_organic",
    domain,
    database,
    display_limit: String(limit),
    display_filter: "%2B%7CPo%7CGt%7C0",   // Position > 0
    display_sort: "tr_desc",
    export_columns: "Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr",
  });
}

// Keyword research — overview + intent + volume for a single seed phrase.
//   Keyword, Search Volume, CPC, Competition, Results, Number of Results, Trends.
async function keywordOverview(phrase, database = DEFAULT_DB) {
  const rows = await semrushRequest({
    type: "phrase_this",
    phrase,
    database,
    export_columns: "Ph,Nq,Cp,Co,Nr,Td",
  });
  return rows[0] || null;
}

// Related phrases for the seed — for content discovery.
async function keywordRelated(phrase, { database = DEFAULT_DB, limit = 15 } = {}) {
  return semrushRequest({
    type: "phrase_related",
    phrase,
    database,
    display_limit: String(limit),
    export_columns: "Ph,Nq,Cp,Co",
  });
}

// ─── Position Tracking (Projects API) ─────────────────────────────────────

// Position Tracking returns daily ranks for keywords manually tracked in a
// Semrush Project. For local/small sites this is the ONLY useful data —
// the global Domain Analytics database often shows zero because local-pack
// rankings don't surface there.
//
// Project ID is the first number in the Semrush tracking URL:
//   semrush.com/tracking/overview/29844457_4876490.html  →  29844457

async function positionTrackingKeywords(projectId, { limit = 20 } = {}) {
  return semrushRequest({
    type: "tracking_position_organic",
    project_id: String(projectId),
    display_limit: String(limit),
    display_sort: "po_asc",
    export_columns: "Ph,Po,Pp,Pd,Nq,Cp,Ur,Vu",
  });
}

async function positionTrackingCompetitors(projectId, { limit = 10 } = {}) {
  return semrushRequest({
    type: "tracking_competitors_organic",
    project_id: String(projectId),
    display_limit: String(limit),
    export_columns: "Dn,Vu,Av,Cv",
  });
}

async function positionTrackingOverview(projectId) {
  const rows = await semrushRequest({
    type: "tracking_summary_organic",
    project_id: String(projectId),
    export_columns: "Db,Vu,Av,Tt,Cv,Tn",
  });
  return rows[0] || null;
}

// ─── High-level snapshot for WhatsApp / cron ──────────────────────────────

async function runSemrushSnapshot({
  domain = process.env.SEMRUSH_DOMAIN || DEFAULT_DOMAIN,
  database = process.env.SEMRUSH_DATABASE || DEFAULT_DB,
  projectId = process.env.SEMRUSH_PROJECT_ID || "",
  competitorsList,
} = {}) {
  if (!process.env.SEMRUSH_API_KEY) {
    return { skipped: "SEMRUSH_API_KEY not set" };
  }
  const competitors = (competitorsList ||
    process.env.SEMRUSH_COMPETITORS ||
    process.env.COMPETITORS ||
    "")
      .split(",").map((s) => s.trim()).filter(Boolean);

  // Prefer Position Tracking when a Project ID is set — the only meaningful
  // data source for hyper-local businesses (Cairns painters etc.) since
  // Semrush's global organic index doesn't capture local-pack rankings.
  if (projectId) {
    const [trackedKeywords, trackedCompetitors, trackingOverview] = await Promise.all([
      positionTrackingKeywords(projectId, { limit: 15 }).catch((e) => ({ error: String(e.message || e) })),
      positionTrackingCompetitors(projectId, { limit: 10 }).catch((e) => ({ error: String(e.message || e) })),
      positionTrackingOverview(projectId).catch((e) => ({ error: String(e.message || e) })),
    ]);
    return {
      mode: "position_tracking",
      domain,
      database,
      projectId,
      trackingOverview,
      trackedKeywords,
      trackedCompetitors,
      fetchedAt: new Date().toISOString(),
    };
  }

  // Fall back to Domain Analytics when no Project ID is configured.
  const [overview, topKeywords, organicCompetitors] = await Promise.all([
    domainOverview(domain, database).catch((e) => ({ error: String(e.message || e) })),
    domainOrganicKeywords(domain, { database, limit: 15 }).catch((e) => ({ error: String(e.message || e) })),
    domainOrganicCompetitors(domain, { database, limit: 10 }).catch((e) => ({ error: String(e.message || e) })),
  ]);

  const namedCompetitorData = await Promise.all(
    competitors.slice(0, 5).map(async (c) => {
      try {
        const o = await domainOverview(c, database);
        return { domain: c, overview: o };
      } catch (err) {
        return { domain: c, error: String(err.message || err) };
      }
    }),
  );

  return {
    mode: "domain_analytics",
    domain,
    database,
    overview,
    topKeywords,
    organicCompetitors,
    namedCompetitors: namedCompetitorData,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────

function fmtN(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function fmtMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return `$${fmtN(num)}`;
}

function formatSemrushMessages(snap) {
  if (snap.skipped) return [`Semrush snapshot skipped: ${snap.skipped}`];

  // Position Tracking mode (preferred for local/small sites)
  if (snap.mode === "position_tracking") {
    return formatPositionTrackingMessages(snap);
  }

  return formatDomainAnalyticsMessages(snap);
}

function formatPositionTrackingMessages(snap) {
  const messages = [];

  // ── Message 1: tracking overview
  const o = snap.trackingOverview;
  if (o && !o.error) {
    messages.push(
      `📊 *Semrush Position Tracking — ${snap.domain}*\n` +
      `\n` +
      `Tracked keywords: ${fmtN(o.Tn) || "—"}\n` +
      `Visibility (SoV): ${o.Vu || "—"}\n` +
      `Avg position: ${o.Av || "—"}\n` +
      `Est. traffic: ${fmtN(o.Tt) || "—"}\n` +
      `Coverage: ${o.Cv || "—"}`
    );
  } else {
    messages.push(`📊 *Semrush Position Tracking — ${snap.domain}*: ${o?.error || "no overview data"}`);
  }

  // ── Message 2: top tracked keywords (best ranking first)
  if (Array.isArray(snap.trackedKeywords) && snap.trackedKeywords.length) {
    const lines = snap.trackedKeywords.slice(0, 12).map((k, i) => {
      const pos = k.Po || "—";
      const trend = k.Pd && Number(k.Pd) !== 0
        ? ` (${Number(k.Pd) > 0 ? "↓" : "↑"}${Math.abs(Number(k.Pd))})` : "";
      const vol = fmtN(k.Nq);
      return `${i + 1}. "${k.Ph}" — #${pos}${trend} · vol ${vol}/mo`;
    });
    messages.push(`🔑 *Tracked keywords — current ranks*\n\n${lines.join("\n")}`);
  } else if (snap.trackedKeywords?.error) {
    messages.push(`🔑 *Tracked keywords*: ${snap.trackedKeywords.error}`);
  }

  // ── Message 3: tracked competitors
  if (Array.isArray(snap.trackedCompetitors) && snap.trackedCompetitors.length) {
    const lines = snap.trackedCompetitors.slice(0, 8).map((c, i) =>
      `${i + 1}. ${c.Dn} — visibility ${c.Vu || "—"} · avg pos ${c.Av || "—"}`
    );
    messages.push(`🏁 *Tracked competitors*\n\n${lines.join("\n")}`);
  } else if (snap.trackedCompetitors?.error) {
    messages.push(`🏁 *Tracked competitors*: ${snap.trackedCompetitors.error}`);
  }

  return messages;
}

function formatDomainAnalyticsMessages(snap) {
  const messages = [];

  // ── Message 1: domain overview
  const o = snap.overview;
  if (o && !o.error) {
    messages.push(
      `📊 *Semrush snapshot — ${snap.domain}* (${snap.database.toUpperCase()})\n` +
      `\n` +
      `Organic keywords: ${fmtN(o.Or)}\n` +
      `Organic traffic: ${fmtN(o.Ot)} / month\n` +
      `Traffic value: ${fmtMoney(o.Oc)}\n` +
      `Semrush rank: #${fmtN(o.Rk)}`
    );
  } else {
    messages.push(`📊 *Semrush — ${snap.domain}*: ${o?.error || "no data"}`);
  }

  // ── Message 2: top ranking keywords
  if (Array.isArray(snap.topKeywords) && snap.topKeywords.length) {
    const lines = snap.topKeywords.slice(0, 10).map((k, i) => {
      const pos = k.Po || "—";
      const trend = k.Pd && Number(k.Pd) !== 0
        ? ` (${Number(k.Pd) > 0 ? "↑" : "↓"}${Math.abs(Number(k.Pd))})` : "";
      const vol = fmtN(k.Nq);
      return `${i + 1}. "${k.Ph}" — #${pos}${trend} · vol ${vol}/mo`;
    });
    messages.push(`🔑 *Top ranking keywords*\n\n${lines.join("\n")}`);
  } else if (snap.topKeywords?.error) {
    messages.push(`🔑 *Top ranking keywords*: ${snap.topKeywords.error}`);
  }

  // ── Message 3: named competitor overviews
  if (snap.namedCompetitors?.length) {
    const lines = snap.namedCompetitors.map((c) => {
      if (c.error) return `• ${c.domain} — ${c.error}`;
      const co = c.overview || {};
      return `• ${c.domain} — ${fmtN(co.Or)} kw · ${fmtN(co.Ot)} traffic · ${fmtMoney(co.Oc)} value`;
    });
    messages.push(`🏁 *Tracked competitors*\n\n${lines.join("\n")}`);
  }

  // ── Message 4: auto-detected organic competitors
  if (Array.isArray(snap.organicCompetitors) && snap.organicCompetitors.length) {
    const lines = snap.organicCompetitors.slice(0, 8).map((c, i) =>
      `${i + 1}. ${c.Dn} — ${fmtN(c.Np)} shared kw · ${fmtN(c.Or)} total kw · ${fmtN(c.Ot)} traffic`
    );
    messages.push(`🔍 *Top organic competitors (Semrush-detected)*\n\n${lines.join("\n")}`);
  }

  return messages;
}

function formatKeywordResearch(phrase, overview, related) {
  const messages = [];
  if (overview) {
    messages.push(
      `🔎 *Keyword: "${phrase}"*\n` +
      `\n` +
      `Search volume: ${fmtN(overview.Nq)}/mo\n` +
      `CPC: ${fmtMoney(overview.Cp)}\n` +
      `Competition: ${overview.Co || "—"}\n` +
      `Total results: ${fmtN(overview.Nr)}`
    );
  } else {
    messages.push(`🔎 *Keyword: "${phrase}"*: no data found`);
  }
  if (Array.isArray(related) && related.length) {
    const lines = related.slice(0, 12).map((k, i) =>
      `${i + 1}. ${k.Ph} — ${fmtN(k.Nq)}/mo · ${fmtMoney(k.Cp)} CPC`
    );
    messages.push(`🌱 *Related phrases*\n\n${lines.join("\n")}`);
  }
  return messages;
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  runSemrushSnapshot,
  formatSemrushMessages,
  domainOverview,
  domainOrganicKeywords,
  domainOrganicCompetitors,
  domainNewLost,
  keywordOverview,
  keywordRelated,
  formatKeywordResearch,
  positionTrackingKeywords,
  positionTrackingCompetitors,
  positionTrackingOverview,
};
