// DataForSEO API client for the conversational bot.
//
// Three call surfaces (all on-demand, no cron):
//   - getLiveSerp(keyword)      → page-1 Google organic (top 10) + SERP features
//   - getAIOverview(keyword)    → Google AI Overview text + citations for the query
//   - getLLMMentions(domain, query) → ChatGPT/Gemini/Perplexity citations
//
// Auth: Basic (base64 of DFS_LOGIN:DFS_PASSWORD).
// Location: Australia country code = 2036. Language code = 'en'.
//
// All calls log a small row to Supabase `dataforseo_usage` (if the table
// exists) so Nick can monitor spend. Console-logs as a fallback.

// Localised to Cairns specifically — national Australia SERP (location_code
// 2036) does not reflect what a Cairns user actually sees. Google heavily
// personalises by physical location for local-intent queries like "painter
// cairns" or "painter [suburb]", so a Cairns-localised query is essential
// for getting "where do I actually rank" right.
const DEFAULT_LOCATION_NAME = "Cairns,Queensland,Australia";
const FALLBACK_LOCATION_CODE = 2036; // Australia — used only if name resolution fails
const LANG_CODE = "en";

// Indicative per-call cost (USD) — DataForSEO live/advanced rates as of 2026.
// Used only for usage logging, not enforcement.
const COST_PER_CALL = {
  live_serp:     0.002,
  ai_overview:   0.002,
  llm_mentions:  0.002,
};

function dfsAuth() {
  const login    = process.env.DATAFORSEO_LOGIN    || process.env.DFS_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD || process.env.DFS_PASSWORD;
  if (!login || !password) return null;
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

async function logUsage(endpoint, ctx, extra) {
  const row = {
    endpoint,
    cost_usd: COST_PER_CALL[endpoint] || 0.002,
    client_id: ctx?.clientId || null,
    phone:     ctx?.phoneNumber || null,
    keyword:   extra?.keyword || null,
    details:   extra || {},
    called_at: new Date().toISOString(),
  };
  try {
    const { client: supa } = require("./supabase.js");
    const { error } = await supa()
      .from("dataforseo_usage")
      .insert(row);
    if (error) {
      // Table likely missing — log to console so we still have visibility.
      console.log("[dfs-usage]", JSON.stringify(row));
    }
  } catch (err) {
    console.log("[dfs-usage]", JSON.stringify(row));
  }
}

// ─── Page 1 Google organic SERP ────────────────────────────────────────────

async function getLiveSerp(keyword, ctx, opts = {}) {
  const auth = dfsAuth();
  if (!auth) return { ok: false, error: "DFS credentials missing (set DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)" };
  const locationName = opts.location_name || DEFAULT_LOCATION_NAME;
  try {
    const resp = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify([{
        keyword,
        location_name: locationName,
        language_code: LANG_CODE,
        depth: 10,
      }]),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, error: `DFS SERP ${resp.status}: ${t.slice(0, 200)}` };
    }
    const data = await resp.json();
    if (data.status_code !== 20000) {
      return { ok: false, error: `DFS status ${data.status_code}: ${data.status_message || "?"}` };
    }
    const result = data?.tasks?.[0]?.result?.[0];
    const items = result?.items || [];

    // Extract organic results (top 10) and SERP features
    const organic = items
      .filter((i) => i.type === "organic")
      .slice(0, 10)
      .map((i) => ({
        position: i.rank_group,
        domain:   i.domain,
        url:      i.url,
        title:    i.title,
        snippet:  (i.description || "").slice(0, 220),
      }));
    const localPack = items
      .filter((i) => i.type === "local_pack")
      .slice(0, 3)
      .map((i) => ({
        position: i.rank_group,
        title:    i.title,
        domain:   i.domain,
        rating:   i.rating?.value,
        reviews:  i.rating?.votes_count,
        address:  i.address,
      }));
    const featureTypes = [...new Set(items.map((i) => i.type))].filter((t) => t !== "organic");

    await logUsage("live_serp", ctx, { keyword, location: locationName });
    return {
      ok: true,
      keyword,
      location: locationName,
      total_items: items.length,
      organic,
      local_pack: localPack,
      features: featureTypes,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ─── Google AI Overview ────────────────────────────────────────────────────

async function getAIOverview(keyword, clientDomain, ctx, opts = {}) {
  const auth = dfsAuth();
  if (!auth) return { ok: false, error: "DFS credentials missing" };
  const locationName = opts.location_name || DEFAULT_LOCATION_NAME;
  try {
    const resp = await fetch("https://api.dataforseo.com/v3/serp/google/ai_overview/live/advanced", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify([{
        keyword,
        location_name: locationName,
        language_code: LANG_CODE,
      }]),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, error: `DFS AIO ${resp.status}: ${t.slice(0, 200)}` };
    }
    const data = await resp.json();
    if (data.status_code !== 20000) {
      return { ok: false, error: `DFS status ${data.status_code}: ${data.status_message || "?"}` };
    }
    const items = data?.tasks?.[0]?.result?.[0]?.items ?? [];
    const aiItem = items.find((i) => i.type === "ai_overview");
    await logUsage("ai_overview", ctx, { keyword, location: locationName });
    if (!aiItem) {
      return { ok: true, keyword, location: locationName, present: false };
    }
    const text = aiItem.text ?? "";
    const refs = aiItem.references ?? aiItem.links ?? [];
    const citations = refs.map((r) => ({
      url: r.url ?? r,
      domain: extractDomain(r.url ?? r),
      title: r.title ?? "",
    }));
    const clientMentioned = clientDomain
      ? citations.some((c) => c.domain && c.domain.toLowerCase().includes(clientDomain.toLowerCase().replace(/^www\./, "")))
      : false;
    return {
      ok: true,
      keyword,
      location: locationName,
      present: true,
      text: text.slice(0, 600),
      citations: citations.slice(0, 10),
      client_mentioned: clientMentioned,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ─── LLM mentions (ChatGPT / Gemini / Perplexity / Claude) ────────────────

async function getLLMMentions(domain, query, ctx) {
  const auth = dfsAuth();
  if (!auth) return { ok: false, error: "DFS credentials missing" };
  try {
    const resp = await fetch("https://api.dataforseo.com/v3/ai_optimization/llm_mentions/search/live", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify([{ keyword: query || domain, domain, limit: 8 }]),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, error: `DFS LLM ${resp.status}: ${t.slice(0, 200)}` };
    }
    const data = await resp.json();
    if (data.status_code !== 20000) {
      return { ok: false, error: `DFS status ${data.status_code}: ${data.status_message || "?"}` };
    }
    const result = data?.tasks?.[0]?.result?.[0];
    await logUsage("llm_mentions", ctx, { keyword: query || domain, domain });
    if (!result) {
      return { ok: true, query, domain, mentions: [], ai_search_volume: null };
    }
    const items = (result.items || []).slice(0, 8);
    return {
      ok: true,
      query: query || domain,
      domain,
      ai_search_volume: result.ai_search_volume || null,
      total_count: result.total_count || 0,
      mentions: items.map((item) => ({
        engine:         item.se_type || "unknown",
        question:       item.question || item.keyword || "",
        answer_snippet: (item.answer || "").slice(0, 250),
        domain_cited:   (item.mentions || []).some((m) => m.domain === domain),
        all_cited:      (item.mentions || []).map((m) => m.domain).filter(Boolean).slice(0, 5),
      })),
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function extractDomain(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return String(url).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

module.exports = {
  getLiveSerp,
  getAIOverview,
  getLLMMentions,
  // exported for testing/inspection
  DEFAULT_LOCATION_NAME,
  FALLBACK_LOCATION_CODE,
  LANG_CODE,
};
