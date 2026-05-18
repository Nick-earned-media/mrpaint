#!/usr/bin/env node
/**
 * One-off: fetch every blog post from the live mrpaint.com.au, convert the
 * article body to markdown, and write a frontmatter'd .md file to blog/.
 *
 *   node scripts/import-blog.js
 *
 * Idempotent — re-running overwrites the destination files.
 */
const fs = require("node:fs");
const path = require("node:path");
const { load } = require("cheerio");
const TurndownService = require("turndown");

const SLUGS = [
  "10-diy-painting-hacks-that-you-need-to-know",
  "5-easy-paint-waste-disposal-tips",
  "5-ways-to-save-on-house-painting",
  "are-tenants-obligated-to-have-a-rental-repainted",
  "backyard-design-ideas",
  "best-exterior-house-colours",
  "best-garden-features",
  "budget-ideas-bathroom",
  "concrete-cancer",
  "covid-19-how-the-pandemic-is-shaping-interior-design",
  "energy-efficiency-multi-storey-building-guide",
  "home-decor-trends",
  "home-design-safety-tips-for-seniors",
  "home-renovation-budget-tips",
  "how-do-you-know-when-its-time-to-replace-your-roof",
  "how-much-does-it-cost-to-paint-a-house",
  "how-to-choose-a-color-palette-for-your-house",
  "how-to-decorate-your-home-on-a-budget",
  "how-to-make-a-small-space-seem-big",
  "how-to-move-a-washing-machine-without-hiring-a-mover",
  "how-to-paint-a-wall",
  "how-to-save-money-on-your-next-diy-project",
  "how-to-save-your-lawn-from-dead-and-dormant-spots",
  "inside-interior-design-how-to-match-blinds-to-decor",
  "painting-tips-to-help-sell-your-house",
  "popular-interior-decorating-styles",
  "renovation-project-tips",
  "rental-property-tips",
  "six-awesome-snacks-for-boosting-your-brainpower",
  "the-benefits-of-tiny-house-living",
  "top-tips-for-a-refreshing-restroom-renovation",
  "trending-tiny-houses-as-work-from-home-garden-offices",
  "what-is-curb-appeal",
];

const OUT_DIR = path.join(__dirname, "..", "blog");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});
// Strip out images that are decorative WordPress chrome (logos, avatars)
turndown.addRule("strip-empty-figures", {
  filter: (node) => node.nodeName === "FIGURE" && !node.textContent.trim() && !node.querySelector("img[src]"),
  replacement: () => "",
});

async function fetchPost(slug) {
  const url = `https://mrpaint.com.au/blog/${slug}/`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${slug}: HTTP ${r.status}`);
  return r.text();
}

function extractPost(html, slug) {
  const $ = load(html);
  $("script, style, noscript, link[rel='stylesheet'], iframe").remove();

  // Title: prefer h1, fall back to <title>
  let title = $("h1").first().text().trim();
  if (!title) title = $("title").text().replace(/\s*-\s*MrPaint.*$/i, "").trim();

  // Date: og:article:published_time or article datetime or meta property
  let dateRaw =
    $("meta[property='article:published_time']").attr("content") ||
    $("time[datetime]").attr("datetime") ||
    $("meta[name='date']").attr("content") ||
    "";
  let date = "";
  if (dateRaw) {
    const d = new Date(dateRaw);
    if (!isNaN(d)) date = d.toISOString().slice(0, 10);
  }

  // Meta description (used as summary)
  const description = $("meta[name='description']").attr("content")?.trim() || "";

  // Find the article body. WordPress / Elementor sites usually have one of these.
  const bodySelectors = [
    ".elementor-widget-theme-post-content",
    ".elementor-widget-theme-post-content .elementor-widget-container",
    "[itemprop='articleBody']",
    ".entry-content",
    "article .post-content",
    "article",
  ];
  let bodyHtml = "";
  for (const sel of bodySelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) {
      // Inside the body, strip site-wide noise.
      el.find("script, style, .related-posts, .share-buttons, .author-box, .post-navigation, nav, .breadcrumbs, .elementor-widget-post-comments, .comments").remove();
      // Strip h1 (we capture it separately as the page title)
      el.find("h1").first().remove();
      bodyHtml = el.html() || "";
      break;
    }
  }
  if (!bodyHtml) throw new Error(`${slug}: no article body found`);

  let bodyMd = turndown.turndown(bodyHtml).trim();
  // Tidy: collapse 3+ consecutive blank lines, strip lines that are just "&nbsp;"
  bodyMd = bodyMd
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*&nbsp;\s*$/gm, "")
    .replace(/&nbsp;/g, " ");

  return { title, date, description, bodyMd };
}

function frontmatter(fields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (!v) continue;
    if (k === "date") lines.push(`date: ${v}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0, fail = 0;
  // Serial with a polite delay between requests — last time we ran in parallel
  // and tripped Cloudflare's anti-bot, blocking the IP for hours.
  for (const slug of SLUGS) {
    try {
      const html = await fetchPost(slug);
      const { title, date, description, bodyMd } = extractPost(html, slug);
      const summary = description || bodyMd.split("\n").find((l) => l.length > 60)?.slice(0, 200) || "";
      const md = frontmatter({ title, date: date || "2024-01-01", summary }) + bodyMd + "\n";
      fs.writeFileSync(path.join(OUT_DIR, `${slug}.md`), md);
      console.log(`✓ ${slug}  (${bodyMd.length} chars)`);
      ok++;
    } catch (err) {
      console.error(`✗ ${slug}: ${err.message}`);
      fail++;
    }
    await sleep(1500);
  }
  console.log(`\nDone: ${ok} succeeded, ${fail} failed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
