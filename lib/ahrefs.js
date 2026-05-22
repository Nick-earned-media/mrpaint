// Ahrefs API v3 wrapper — pulls competitor keyword gaps.
//
// Strategy (v1):
//   1. Get the top organic keywords for our site and for each competitor.
//   2. Find keywords competitors rank for in top 10 where we don't rank
//      (or rank >20). Sort by volume.
//   3. Return the top opportunities.
//
// Env vars:
//   AHREFS_API_TOKEN — Bearer token from Ahrefs → Settings → API.
//   AHREFS_COUNTRY   — Default "au".

const AHREFS_BASE = "https://api.ahrefs.com/v3";
const COUNTRY = process.env.AHREFS_COUNTRY || "au";
const MAX_KEYWORDS_PER_DOMAIN = 100;

async function fetchAhrefsGaps({ site, competitors }) {
  const token = process.env.AHREFS_API_TOKEN;
  if (!token) return { skipped: "AHREFS_API_TOKEN not set" };
  if (!competitors?.length) return { skipped: "COMPETITORS env var not set" };

  const ours = await getOrganicKeywords(site, token);
  const theirs = await Promise.all(
    competitors.map(async (c) => ({ domain: c, keywords: await getOrganicKeywords(c, token).catch((e) => ({ error: e.message })) }))
  );

  // Build a set of our keyword phrases (normalised) for fast lookup.
  const ourMap = new Map();
  for (const k of ours.keywords || []) {
    ourMap.set(k.keyword.toLowerCase(), k.position);
  }

  // For each competitor, find keywords they rank top-10 that we don't.
  const opportunities = [];
  for (const t of theirs) {
    if (t.error || !t.keywords) continue;
    for (const k of t.keywords) {
      const normalised = k.keyword.toLowerCase();
      const ourPos = ourMap.get(normalised);
      // Opportunity criteria:
      //   - competitor ranks top 10
      //   - we don't rank OR rank below 20
      //   - keyword has some search volume
      if (k.position && k.position <= 10 && (!ourPos || ourPos > 20) && (k.volume || 0) > 10) {
        opportunities.push({
          keyword: k.keyword,
          competitor: t.domain,
          competitor_position: k.position,
          our_position: ourPos || null,
          volume: k.volume || 0,
          difficulty: k.difficulty || null,
          intent: k.intent || null,
        });
      }
    }
  }

  // Deduplicate by keyword — keep the highest-ranked competitor per term.
  const dedup = new Map();
  for (const op of opportunities) {
    const existing = dedup.get(op.keyword);
    if (!existing || op.competitor_position < existing.competitor_position) {
      dedup.set(op.keyword, op);
    }
  }
  const sorted = Array.from(dedup.values()).sort((a, b) => b.volume - a.volume);

  return {
    site,
    competitorsScanned: competitors,
    opportunities: sorted,
    ourKeywordCount: (ours.keywords || []).length,
  };
}

async function getOrganicKeywords(target, token) {
  // Ahrefs v3 site-explorer/organic-keywords
  // GET https://api.ahrefs.com/v3/site-explorer/organic-keywords
  // Required params: target, country, date, output=json, select=...
  const today = new Date().toISOString().slice(0, 10);
  const url = new URL(`${AHREFS_BASE}/site-explorer/organic-keywords`);
  url.searchParams.set("target", target);
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("date", today);
  url.searchParams.set("mode", "subdomains");
  url.searchParams.set("limit", String(MAX_KEYWORDS_PER_DOMAIN));
  url.searchParams.set("order_by", "volume:desc");
  url.searchParams.set("select", "keyword,best_position,volume,kd,traffic,intents");
  url.searchParams.set("output", "json");

  const r = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Ahrefs ${r.status} for ${target}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  // Response shape (typical Ahrefs v3): { keywords: [...] } or { organic_keywords: [...] }
  // Try multiple shapes since the exact key varies by endpoint version.
  const rows = data.keywords || data.organic_keywords || data.data || data.rows || [];
  return {
    target,
    keywords: rows.map((row) => ({
      keyword: row.keyword || row.kw || "",
      position: row.best_position || row.position || row.pos || null,
      volume: row.volume || row.search_volume || 0,
      difficulty: row.kd || row.difficulty || null,
      intent: Array.isArray(row.intents) ? row.intents.join(",") : (row.intent || null),
    })),
    raw: process.env.AHREFS_DEBUG === "1" ? data : undefined,
  };
}

module.exports = { fetchAhrefsGaps };
