// GSC → kb_chunks ingestion.
//
// Pulls a weekly snapshot of GSC data per tenant and turns it into
// embeddable, semantically-searchable knowledge chunks the strategist
// bot can recall later via match_client_kb.
//
// Snapshot covers:
//   • Overall traffic this week vs last (one summary chunk)
//   • Top 10 queries this week (one snapshot chunk)
//   • Queries that moved materially in clicks or rank (one chunk each)
//   • Pages that moved materially in clicks (one chunk each)
//
// Source IDs encode the week range so re-running the same week safely
// replaces prior rows.
//
// Uses the OAuth refresh-token GSC client (lib/gsc-oauth.js) — works
// for Domain properties (sc-domain:foo.com) where service accounts
// silently fail.
//
// Env vars required:
//   GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN  — for GSC OAuth
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY              — for kb_chunks
//   OPENAI_API_KEY                                        — for embeddings

const { client: supa, embedBatch } = require("./supabase.js");
const { gscPost } = require("./gsc-oauth.js");

const QUERY_CLICKS_DELTA_PCT = 25;     // ≥25% click change = "movement"
const QUERY_POSITION_DELTA   = 2;       // ≥2 positions = "movement"
const PAGE_CLICKS_DELTA_PCT  = 25;
const TOP_N_QUERIES          = 10;
const ROW_LIMIT              = 250;

// ─── Public entry point ────────────────────────────────────────────────────

async function ingestGscForClient(clientRow) {
  if (!clientRow?.gsc_property) {
    return { skipped: `client ${clientRow?.slug || "?"} has no gsc_property` };
  }
  const property = clientRow.gsc_property;

  const snapshot = await fetchGscWeekSnapshot({ property });
  if (snapshot.skipped || snapshot.error) return snapshot;

  const chunks = snapshotToChunks(snapshot, clientRow);
  if (chunks.length === 0) return { property, chunks_written: 0, note: "no chunks generated" };

  const embeddings = await embedBatch(chunks.map((c) => c.chunk_text));

  // Replace any same-period rows so re-runs don't accumulate duplicates.
  const sb = supa();
  const sourceIds = chunks.map((c) => c.source_id);
  await sb.from("kb_chunks")
    .delete()
    .eq("client_id", clientRow.id)
    .in("source_id", sourceIds);

  const rows = chunks.map((c, i) => ({
    client_id: clientRow.id,
    source_type: c.source_type,
    source_id: c.source_id,
    source_date: c.source_date,
    chunk_text: c.chunk_text,
    chunk_index: i,
    embedding: embeddings[i],
    metadata: c.metadata || {},
  }));

  const { error } = await sb.from("kb_chunks").insert(rows);
  if (error) throw new Error(`kb_chunks insert: ${error.message}`);

  return { property, chunks_written: rows.length, period: snapshot.range };
}

// ─── Snapshot fetch ────────────────────────────────────────────────────────

async function fetchGscWeekSnapshot({ property }) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const thisEnd = new Date(today); thisEnd.setDate(thisEnd.getDate() - 3); // GSC ~3-day lag
  const thisStart = new Date(thisEnd); thisStart.setDate(thisStart.getDate() - 6);
  const prevEnd = new Date(thisStart); prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6);

  const range = (s, e) => ({ startDate: fmt(s), endDate: fmt(e) });
  const thisRange = range(thisStart, thisEnd);
  const prevRange = range(prevStart, prevEnd);

  const propPath = `/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const ask = (dates, dimensions) =>
    gscPost(propPath, { ...dates, dimensions, rowLimit: dimensions.length ? ROW_LIMIT : 1 });

  let thisAgg, prevAgg, thisByQuery, prevByQuery, thisByPage, prevByPage;
  try {
    [thisAgg, prevAgg, thisByQuery, prevByQuery, thisByPage, prevByPage] = await Promise.all([
      ask(thisRange, []),
      ask(prevRange, []),
      ask(thisRange, ["query"]),
      ask(prevRange, ["query"]),
      ask(thisRange, ["page"]),
      ask(prevRange, ["page"]),
    ]);
  } catch (err) {
    return { error: err.message };
  }

  const aggRow = (r) => {
    const row = r.rows?.[0];
    return { clicks: row?.clicks || 0, impressions: row?.impressions || 0 };
  };
  const dimRows = (r) => (r.rows || []).map((row) => ({
    key: row.keys[0],
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    position: row.position || 0,
  }));

  const thisAggR = aggRow(thisAgg);
  const prevAggR = aggRow(prevAgg);
  const thisQueries = dimRows(thisByQuery);
  const prevQueries = dimRows(prevByQuery);
  const thisPages = dimRows(thisByPage);
  const prevPages = dimRows(prevByPage);

  const prevQueriesMap = new Map(prevQueries.map((r) => [r.key, r]));
  const queryMovers = [];
  for (const cur of thisQueries) {
    const prev = prevQueriesMap.get(cur.key);
    if (!prev) continue;
    const clicksDelta = pctChange(cur.clicks, prev.clicks);
    const posDelta = (prev.position || 0) - (cur.position || 0);
    if (Math.abs(clicksDelta) >= QUERY_CLICKS_DELTA_PCT || Math.abs(posDelta) >= QUERY_POSITION_DELTA) {
      queryMovers.push({
        query: cur.key,
        clicks: cur.clicks, prev_clicks: prev.clicks, clicks_delta_pct: round1(clicksDelta),
        position: round1(cur.position), prev_position: round1(prev.position), position_delta: round1(posDelta),
        impressions: cur.impressions,
      });
    }
  }
  queryMovers.sort((a, b) => Math.abs(b.clicks_delta_pct) - Math.abs(a.clicks_delta_pct));

  const prevPagesMap = new Map(prevPages.map((r) => [r.key, r]));
  const pageMovers = [];
  for (const cur of thisPages) {
    const prev = prevPagesMap.get(cur.key);
    if (!prev) continue;
    const clicksDelta = pctChange(cur.clicks, prev.clicks);
    if (Math.abs(clicksDelta) >= PAGE_CLICKS_DELTA_PCT) {
      pageMovers.push({
        page: shortPath(cur.key),
        clicks: cur.clicks, prev_clicks: prev.clicks, clicks_delta_pct: round1(clicksDelta),
        impressions: cur.impressions,
      });
    }
  }
  pageMovers.sort((a, b) => Math.abs(b.clicks_delta_pct) - Math.abs(a.clicks_delta_pct));

  const topQueries = [...thisQueries]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, TOP_N_QUERIES)
    .map((r) => ({ query: r.key, clicks: r.clicks, impressions: r.impressions, position: round1(r.position) }));

  return {
    property,
    range: { this: thisRange, prev: prevRange },
    summary: {
      clicks_this: thisAggR.clicks, clicks_prev: prevAggR.clicks,
      clicks_delta_pct: round1(pctChange(thisAggR.clicks, prevAggR.clicks)),
      impressions_this: thisAggR.impressions, impressions_prev: prevAggR.impressions,
      impressions_delta_pct: round1(pctChange(thisAggR.impressions, prevAggR.impressions)),
    },
    topQueries,
    queryMovers,
    pageMovers,
  };
}

// ─── Chunk generation ──────────────────────────────────────────────────────

function snapshotToChunks(snap, clientRow) {
  const name = clientRow.display_name || clientRow.slug;
  const period = `${snap.range.this.startDate}_${snap.range.this.endDate}`;
  const period_date = new Date(snap.range.this.endDate + "T00:00:00Z").toISOString();
  const chunks = [];

  const s = snap.summary;
  const dir = (d) => d > 0 ? "up" : d < 0 ? "down" : "flat";

  chunks.push({
    source_type: "gsc_summary",
    source_id: `gsc:summary:${period}`,
    source_date: period_date,
    chunk_text:
      `Google Search Console weekly summary for ${name} (${snap.range.this.startDate} to ${snap.range.this.endDate}). ` +
      `Clicks: ${s.clicks_this} (${dir(s.clicks_delta_pct)} ${Math.abs(s.clicks_delta_pct)}% vs prior week's ${s.clicks_prev}). ` +
      `Impressions: ${s.impressions_this} (${dir(s.impressions_delta_pct)} ${Math.abs(s.impressions_delta_pct)}% vs prior week's ${s.impressions_prev}). ` +
      `Significantly-moving queries this week: ${snap.queryMovers.length}. ` +
      `Significantly-moving pages this week: ${snap.pageMovers.length}.`,
    metadata: { period_start: snap.range.this.startDate, period_end: snap.range.this.endDate, ...s },
  });

  if (snap.topQueries.length > 0) {
    const lines = snap.topQueries.map((q, i) =>
      `${i + 1}. "${q.query}" — ${q.clicks} clicks, ${q.impressions} impressions, avg position ${q.position}`);
    chunks.push({
      source_type: "gsc_top_queries",
      source_id: `gsc:top_queries:${period}`,
      source_date: period_date,
      chunk_text:
        `Top ${snap.topQueries.length} Google Search Console queries for ${name} this week (${snap.range.this.startDate} to ${snap.range.this.endDate}):\n` +
        lines.join("\n"),
      metadata: { period_start: snap.range.this.startDate, period_end: snap.range.this.endDate, queries: snap.topQueries },
    });
  }

  for (const m of snap.queryMovers) {
    const clicksLine = m.clicks_delta_pct !== 0
      ? `Clicks ${m.clicks_delta_pct > 0 ? "up" : "down"} ${Math.abs(m.clicks_delta_pct)}% (${m.prev_clicks} → ${m.clicks})`
      : null;
    const posLine = m.position_delta !== 0
      ? `Average position ${m.position_delta > 0 ? "improved" : "dropped"} by ${Math.abs(m.position_delta)} (${m.prev_position} → ${m.position})`
      : null;
    const detail = [clicksLine, posLine].filter(Boolean).join(". ");
    chunks.push({
      source_type: "gsc_query_movement",
      source_id: `gsc:query:${period}:${slug(m.query)}`,
      source_date: period_date,
      chunk_text:
        `Search query "${m.query}" moved for ${name} this week (${snap.range.this.startDate} to ${snap.range.this.endDate}). ` +
        `${detail}. Impressions this week: ${m.impressions}.`,
      metadata: { query: m.query, period_start: snap.range.this.startDate, period_end: snap.range.this.endDate, ...m },
    });
  }

  for (const m of snap.pageMovers) {
    chunks.push({
      source_type: "gsc_page_movement",
      source_id: `gsc:page:${period}:${slug(m.page)}`,
      source_date: period_date,
      chunk_text:
        `Page ${m.page} moved for ${name} this week (${snap.range.this.startDate} to ${snap.range.this.endDate}). ` +
        `Clicks ${m.clicks_delta_pct > 0 ? "up" : "down"} ${Math.abs(m.clicks_delta_pct)}% (${m.prev_clicks} → ${m.clicks}). ` +
        `Impressions this week: ${m.impressions}.`,
      metadata: { page: m.page, period_start: snap.range.this.startDate, period_end: snap.range.this.endDate, ...m },
    });
  }

  return chunks;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function pctChange(now, then) {
  if (!then) return now > 0 ? 100 : 0;
  return ((now - then) / then) * 100;
}

function round1(n) { return Math.round(n * 10) / 10; }

function shortPath(fullUrl) {
  try { return new URL(fullUrl).pathname || "/"; }
  catch { return fullUrl; }
}

function slug(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
}

module.exports = { ingestGscForClient, fetchGscWeekSnapshot, snapshotToChunks };
