// Shared competitor-filtering rules.
//
// Reports and the conversational bot both pull a list of "top competitors by
// share of voice" from Semrush. Without filtering, this surfaces national
// brand aggregators (Airtasker, Hipages, etc.) that aren't real competitors
// for a local tradie — they're a different business model entirely and
// commenting on them is noise.
//
// Two layers of filtering:
//   1. WHITELIST — if the client has rows in their `competitors` table, only
//      surface domains that match those entries. This is the canonical mode.
//   2. AGGREGATOR BLACKLIST — bootstrap safety net for when the whitelist
//      is empty: always strip well-known brand aggregators so the report
//      doesn't ship garbage on day one.

// Maximum competitors that can be on a client's whitelist. Adrian can add
// up to this many via WhatsApp; past the cap he has to remove one first.
const MAX_COMPETITORS = 8;

// Brand aggregators / marketplaces / directories — never count as competitors
// for a local trade business, regardless of their share of voice.
const BRAND_AGGREGATORS = [
  "airtasker.com",
  "hipages.com",
  "oneflare.com",
  "serviceseeking.com",
  "yellowpages.com",
  "truelocal.com",
  "localsearch.com",
  "yelp.com",
  "gumtree.com",
  "houzz.com",
  "trustpilot.com",
  "productreview.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
];

function normalizeDomain(d) {
  if (!d) return "";
  return String(d).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

function isBrandAggregator(domain) {
  const n = normalizeDomain(domain);
  return BRAND_AGGREGATORS.some((agg) => n === agg || n.endsWith("." + agg) || n === agg.replace(/\.com$/, ".com.au") || n.endsWith("." + agg.replace(/\.com$/, ".com.au")));
}

/**
 * Filter Semrush competitor rows down to either the client's whitelist
 * (when populated) or "everything except brand aggregators" (bootstrap).
 *
 * @param {Array<{domain:string, sov:number, ...}>} rows
 * @param {Array<{domain?:string, name?:string}>} knownCompetitors
 * @returns filtered rows in same shape
 */
function filterCompetitors(rows, knownCompetitors) {
  if (!Array.isArray(rows)) return [];
  const known = Array.isArray(knownCompetitors) ? knownCompetitors.filter((c) => c && c.domain) : [];

  if (known.length > 0) {
    // Whitelist mode — only domains that match a known competitor pass.
    const allowed = new Set(known.map((c) => normalizeDomain(c.domain)));
    return rows.filter((r) => allowed.has(normalizeDomain(r.domain)));
  }

  // Bootstrap mode — no whitelist, so just strip aggregators.
  return rows.filter((r) => !isBrandAggregator(r.domain));
}

module.exports = {
  MAX_COMPETITORS,
  BRAND_AGGREGATORS,
  normalizeDomain,
  isBrandAggregator,
  filterCompetitors,
};
