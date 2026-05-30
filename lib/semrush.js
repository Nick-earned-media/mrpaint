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

function parseSemrushCsv(text) {
  const lines = text.split("\n").filter((l) => l.length);
  if (lines.length < 2) return [];
  const headers = lines[0].split(";").map((h) => h.trim());
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

// ─── Position Tracking (Projects API) — stubs until project is wired ──────

// Position Tracking returns daily ranks for tracked keywords + competitors.
// Lives at a different endpoint (api.semrush.com/management/v1/projects/...)
// and uses the same API key but project-scoped responses. Wire this up once
// SEMRUSH_PROJECT_ID is set.
async function positionTracking() {
  if (!process.env.SEMRUSH_PROJECT_ID) {
    return { skipped: "SEMRUSH_PROJECT_ID not set — finish setting up the Semrush project first." };
  }
  return { skipped: "Position Tracking endpoint not implemented yet — needs Project + tracking config in Semrush UI." };
}

// ─── High-level snapshot for WhatsApp / cron ──────────────────────────────

async function runSemrushSnapshot({
  domain = process.env.SEMRUSH_DOMAIN || DEFAULT_DOMAIN,
  database = process.env.SEMRUSH_DATABASE || DEFAULT_DB,
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

  // Pull everything in parallel.
  const [overview, topKeywords, organicCompetitors] = await Promise.all([
    domainOverview(domain, database).catch((e) => ({ error: String(e.message || e) })),
    domainOrganicKeywords(domain, { database, limit: 15 }).catch((e) => ({ error: String(e.message || e) })),
    domainOrganicCompetitors(domain, { database, limit: 10 }).catch((e) => ({ error: String(e.message || e) })),
  ]);

  // Pull explicit competitor overviews (in parallel) — only for the user's
  // named competitors list, so we get apples-to-apples data even if Semrush's
  // auto-detected competitors include irrelevant domains.
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
  positionTracking,
};
