// Site audit module — runs on-demand from the WhatsApp bot.
//
// Three parts (each degrades gracefully if its env vars are missing):
//   1. SEO scan of mrpaint.com.au (always runs)
//   2. Competitor opportunity gap via Ahrefs API (if AHREFS_API_TOKEN set)
//   3. GSC week-over-week trends (if GSC_SERVICE_ACCOUNT_JSON set)
//
// Returns an object the caller turns into WhatsApp messages.

const cheerio = require("cheerio");
const { fetchAhrefsGaps } = require("./ahrefs.js");
const { fetchGscTrends } = require("./gsc.js");

const SITE_BASE = process.env.AUDIT_SITE_BASE || "https://mrpaint.com.au";
const COMPETITORS = (process.env.COMPETITORS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Hard-coded list of high-value pages to audit. Could be sitemap-driven later.
const PAGES = [
  "/",
  "/painter-cairns",
  "/commercial-painter-cairns",
  "/industrial-painting",
  "/about",
  "/gallery",
  "/blog",
  "/contact",
];

async function runAudit() {
  const startedAt = Date.now();

  const [seoResult, ahrefsResult, gscResult] = await Promise.allSettled([
    runSeoScan(),
    COMPETITORS.length > 0 && process.env.AHREFS_API_TOKEN
      ? fetchAhrefsGaps({ site: hostname(SITE_BASE), competitors: COMPETITORS })
      : Promise.resolve({ skipped: "no AHREFS_API_TOKEN or COMPETITORS env var" }),
    process.env.GSC_SERVICE_ACCOUNT_JSON
      ? fetchGscTrends({ siteUrl: SITE_BASE })
      : Promise.resolve({ skipped: "no GSC_SERVICE_ACCOUNT_JSON env var" }),
  ]);

  return {
    site: SITE_BASE,
    durationMs: Date.now() - startedAt,
    seo: settled(seoResult),
    competitors: settled(ahrefsResult),
    gsc: settled(gscResult),
  };
}

function settled(result) {
  return result.status === "fulfilled"
    ? result.value
    : { error: String(result.reason?.message || result.reason) };
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// ─── SEO scan ─────────────────────────────────────────────────────────────

async function runSeoScan() {
  const findings = [];
  const pageReports = [];

  for (const path of PAGES) {
    const url = SITE_BASE + path;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "MrPaintAuditBot/1.0 (+contact: adrian@mrpaint.com.au)" },
        redirect: "follow",
      });
      const headers = Object.fromEntries(r.headers);
      const html = await r.text();
      const checks = analysePage({ url, path, status: r.status, headers, html });
      pageReports.push(checks);
    } catch (err) {
      pageReports.push({ url, path, error: String(err.message || err) });
    }
  }

  // Aggregate cross-page findings.
  aggregateFindings(pageReports, findings);

  // Score: 100 - (critical*15 + high*8 + medium*3 + low*1) clamped to 0..100
  const score = computeScore(findings);

  return { score, findings, pageReports };
}

function analysePage({ url, path, status, headers, html }) {
  const $ = cheerio.load(html);
  const issues = [];

  if (status !== 200) {
    issues.push({ severity: "critical", code: "non-200", msg: `Status ${status}` });
    return { url, path, status, issues };
  }

  // X-Robots-Tag header
  const xRobots = headers["x-robots-tag"] || "";
  if (/noindex/i.test(xRobots)) {
    issues.push({ severity: "critical", code: "x-robots-noindex", msg: `Page returns X-Robots-Tag: ${xRobots} — Google will not index it.` });
  }

  // Meta robots noindex
  const metaRobots = ($("meta[name='robots']").attr("content") || "").toLowerCase();
  if (/noindex/.test(metaRobots)) {
    issues.push({ severity: "critical", code: "meta-noindex", msg: `<meta name="robots" content="${metaRobots}"> — page is blocked from indexing.` });
  }

  // Title
  const title = ($("title").first().text() || "").trim();
  if (!title) issues.push({ severity: "critical", code: "no-title", msg: "Missing <title> tag." });
  else if (title.length > 60) issues.push({ severity: "medium", code: "title-too-long", msg: `<title> is ${title.length} chars (>60 truncates in SERP): "${truncate(title, 70)}"` });
  else if (title.length < 25) issues.push({ severity: "medium", code: "title-too-short", msg: `<title> is only ${title.length} chars — under-utilised.` });

  // Meta description
  const desc = ($("meta[name='description']").attr("content") || "").trim();
  if (!desc) issues.push({ severity: "high", code: "no-meta-desc", msg: "Missing <meta name=\"description\">." });
  else if (desc.length > 160) issues.push({ severity: "medium", code: "meta-desc-too-long", msg: `Meta description is ${desc.length} chars (>160 truncates).` });
  else if (desc.length < 100) issues.push({ severity: "low", code: "meta-desc-too-short", msg: `Meta description is only ${desc.length} chars.` });

  // Canonical
  const canonical = ($("link[rel='canonical']").attr("href") || "").trim();
  if (!canonical) issues.push({ severity: "high", code: "no-canonical", msg: "Missing <link rel=\"canonical\">." });
  else {
    const expectedCanonical = SITE_BASE + (path === "/" ? "/" : path);
    if (canonical !== expectedCanonical && canonical.replace(/\/$/, "") !== expectedCanonical.replace(/\/$/, "")) {
      issues.push({ severity: "high", code: "canonical-mismatch", msg: `Canonical "${canonical}" doesn't match expected "${expectedCanonical}".` });
    }
  }

  // H1
  const h1s = $("h1");
  if (h1s.length === 0) issues.push({ severity: "high", code: "no-h1", msg: "No <h1> on the page." });
  else if (h1s.length > 1) issues.push({ severity: "medium", code: "multiple-h1", msg: `${h1s.length} <h1> tags — should be exactly one.` });

  // Open Graph
  const ogTags = ["og:title", "og:description", "og:image", "og:url", "og:type"];
  const missingOg = ogTags.filter((t) => !$(`meta[property='${t}']`).attr("content"));
  if (missingOg.length === ogTags.length) {
    issues.push({ severity: "medium", code: "no-og", msg: `No Open Graph tags — social shares will fall back to generic preview.` });
  } else if (missingOg.length > 0) {
    issues.push({ severity: "low", code: "partial-og", msg: `Missing OG tags: ${missingOg.join(", ")}` });
  }

  // Schema.org JSON-LD
  const jsonLds = $("script[type='application/ld+json']");
  let schemaTypes = [];
  jsonLds.each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const items = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
      for (const item of items) if (item["@type"]) schemaTypes.push(item["@type"]);
    } catch {
      issues.push({ severity: "high", code: "schema-malformed", msg: "JSON-LD block doesn't parse." });
    }
  });
  if (schemaTypes.length === 0) {
    issues.push({ severity: "high", code: "no-schema", msg: "No Schema.org JSON-LD." });
  }

  // Images missing alt
  const imgs = $("img");
  const imgsWithoutAlt = imgs.toArray().filter((el) => !($(el).attr("alt") || "").trim()).length;
  if (imgs.length > 0 && imgsWithoutAlt > 0) {
    const pct = Math.round((imgsWithoutAlt / imgs.length) * 100);
    const sev = pct > 30 ? "high" : "medium";
    issues.push({ severity: sev, code: "missing-alt", msg: `${imgsWithoutAlt}/${imgs.length} images missing alt text (${pct}%).` });
  }

  // Body word count (thin content detection)
  const bodyText = $("body").clone().find("script,style,nav,footer,header").remove().end().text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  if (wordCount < 300) issues.push({ severity: "high", code: "thin-content", msg: `Only ${wordCount} words of body content — risk of thin-content treatment.` });

  // Internal link audit (count)
  const links = $("a[href]").toArray();
  const internal = links.filter((el) => {
    const href = $(el).attr("href") || "";
    return href.startsWith("/") || href.startsWith(SITE_BASE);
  }).length;
  if (internal < 5) issues.push({ severity: "medium", code: "few-internal-links", msg: `Only ${internal} internal links on page.` });

  // Viewport meta
  const viewport = $("meta[name='viewport']").attr("content");
  if (!viewport) issues.push({ severity: "high", code: "no-viewport", msg: "No <meta name=\"viewport\"> — mobile rendering broken." });

  return {
    url, path, status,
    title, titleLength: title.length,
    description: desc, descriptionLength: desc.length,
    canonical, h1Count: h1s.length, wordCount,
    schemaTypes: [...new Set(schemaTypes)],
    imgsTotal: imgs.length, imgsWithoutAlt,
    internalLinks: internal,
    issues,
  };
}

function aggregateFindings(pageReports, findings) {
  // Roll up the per-page issues into the top-level findings list. Group same
  // codes affecting multiple pages.
  const byCode = new Map();
  for (const page of pageReports) {
    for (const issue of page.issues || []) {
      const key = issue.code;
      if (!byCode.has(key)) byCode.set(key, { ...issue, pages: [] });
      byCode.get(key).pages.push({ path: page.path, detail: issue.msg });
    }
  }
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const rolled = Array.from(byCode.values()).sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  findings.push(...rolled);
}

function computeScore(findings) {
  let penalty = 0;
  for (const f of findings) {
    const w = { critical: 15, high: 8, medium: 3, low: 1 }[f.severity] || 0;
    penalty += w * (f.pages?.length || 1);
  }
  return Math.max(0, Math.min(100, 100 - penalty));
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// ─── WhatsApp formatting ─────────────────────────────────────────────────

function formatAuditMessages(audit) {
  const messages = [];

  // Message 1: SEO summary
  const seo = audit.seo;
  if (seo?.error) {
    messages.push(`🤖 Audit failed: ${seo.error}`);
    return messages;
  }
  const topFindings = (seo.findings || []).slice(0, 8);
  const sevIcon = { critical: "🚨", high: "⚠️", medium: "🟡", low: "🔵" };
  const lines = [
    `📊 *MrPaint SEO audit*`,
    `Score: ${seo.score}/100  ·  ${seo.pageReports.length} pages scanned  ·  ${Math.round(audit.durationMs / 1000)}s`,
    ``,
    `*Top issues* (${seo.findings.length} total):`,
  ];
  for (const f of topFindings) {
    const pages = f.pages?.length > 1
      ? `[${f.pages.length} pages]`
      : `[${f.pages?.[0]?.path || "?"}]`;
    lines.push(`${sevIcon[f.severity] || "•"} ${pages} ${f.msg}`);
  }
  if (seo.findings.length > topFindings.length) {
    lines.push(``);
    lines.push(`+ ${seo.findings.length - topFindings.length} more (lower priority)`);
  }
  messages.push(lines.join("\n"));

  // Message 2: Competitor opportunities
  const c = audit.competitors;
  if (c?.skipped) {
    messages.push(`🤝 *Competitor analysis* — skipped\n${c.skipped}\n\nSet AHREFS_API_TOKEN + COMPETITORS env vars on Vercel to enable.`);
  } else if (c?.error) {
    messages.push(`🤝 *Competitor analysis* — failed\n${c.error}`);
  } else if (c?.opportunities) {
    const m = [`🤝 *Competitor opportunities*`, ``];
    if (c.opportunities.length === 0) {
      m.push(`No high-value keyword gaps detected across ${(c.competitorsScanned || []).join(", ")}.`);
    } else {
      for (const op of c.opportunities.slice(0, 5)) {
        m.push(`• "${op.keyword}" — ${op.competitor} ranks #${op.competitor_position} (vol ${op.volume}/mo)`);
      }
    }
    messages.push(m.join("\n"));
  }

  // Message 3: GSC trends
  const g = audit.gsc;
  if (g?.skipped) {
    messages.push(`📈 *GSC trends* — skipped\n${g.skipped}\n\nAdd a Google service account JSON to Vercel as GSC_SERVICE_ACCOUNT_JSON and add its email as a Restricted user on the GSC mrpaint property.`);
  } else if (g?.error) {
    messages.push(`📈 *GSC trends* — failed\n${g.error}`);
  } else if (g?.summary) {
    const m = [`📈 *GSC week-over-week*`, ``];
    m.push(`Clicks: ${g.summary.clicksThis} (${signedPct(g.summary.clicksDelta)})`);
    m.push(`Impressions: ${g.summary.impressionsThis} (${signedPct(g.summary.impressionsDelta)})`);
    if (g.drops?.length > 0) {
      m.push(``);
      m.push(`*${g.drops.length} pages dropped ≥20%*:`);
      for (const d of g.drops.slice(0, 5)) {
        m.push(`• ${d.page} — clicks ${signedPct(d.clicksDelta)}, impr ${signedPct(d.impressionsDelta)}`);
      }
    } else {
      m.push(``);
      m.push(`No pages with ≥20% drop. ✅`);
    }
    if (g.top?.length > 0) {
      m.push(``);
      m.push(`*Top pages (last 7d)*:`);
      for (const t of g.top.slice(0, 5)) {
        m.push(`• ${t.page} — ${t.clicks} clicks, ${t.impressions} impr`);
      }
    }
    messages.push(m.join("\n"));
  }

  return messages;
}

function signedPct(n) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${Math.round(n)}%`;
}

module.exports = { runAudit, formatAuditMessages };
