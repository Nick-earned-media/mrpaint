#!/usr/bin/env node
/**
 * Audit (and optionally rewrite) internal links inside the imported blog
 * posts. Three buckets:
 *
 *   1. Internal absolute (mrpaint.com.au/...) — these came in from the
 *      WordPress import as absolute URLs and point to the OLD site. Rewrite
 *      them to relative paths so they stay internal on the new deploy.
 *   2. Internal relative (/path/...) — already relative. Just check the
 *      target page exists on the new site.
 *   3. External (any other domain) — leave alone.
 *
 *   node scripts/audit-blog-links.js          # audit only, prints report
 *   node scripts/audit-blog-links.js --fix    # rewrite mrpaint.com.au links
 */
const fs = require("node:fs");
const path = require("node:path");

const BLOG_DIR = path.join(__dirname, "..", "blog");
const FIX = process.argv.includes("--fix");

// Pages that actually exist on the new site (top-level pages we built).
const KNOWN_PAGES = new Set([
  "/",
  "/about/",
  "/painter-cairns/",
  "/commercial-painter-cairns/",
  "/industrial-painting/",
  "/gallery/",
  "/blog/",
  "/contact/",
]);

// Old WordPress URLs that need to redirect to new equivalents.
const URL_REWRITES = {
  "/about-us/": "/about/",
  "/contact-us/": "/contact/",
  "/painter/": "/painter-cairns/",
  "/commercial-painter-sydney/": "/commercial-painter-cairns/",
  "/roof-painter-sydney/": "/painter-cairns/",
  "/blog/author/adrian-tucci/": "/about/",
};

function normalize(href) {
  // Strip query / fragment for membership checks
  try {
    const u = new URL(href, "https://mrpaint.com.au/");
    return u.pathname.endsWith("/") || u.pathname.includes(".")
      ? u.pathname
      : u.pathname + "/";
  } catch { return href; }
}

function isInternalAbsolute(href) {
  return /^https?:\/\/(www\.)?mrpaint\.com\.au\b/i.test(href);
}

function toRelative(href) {
  return href.replace(/^https?:\/\/(www\.)?mrpaint\.com\.au/i, "");
}

function classifyTarget(href) {
  // Returns one of: blog-post-exists, blog-post-missing, page-known,
  // page-rewritable, page-unknown, wp-asset, external, anchor.
  if (href.startsWith("#")) return "anchor";
  let u;
  try { u = new URL(href, "https://mrpaint.com.au/"); }
  catch { return "external"; }
  if (u.host !== "mrpaint.com.au" && u.host !== "www.mrpaint.com.au") {
    return "external";
  }
  const p = u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
  if (p.startsWith("/wp-content/")) return "wp-asset";
  if (p.startsWith("/blog/")) {
    const slug = p.replace(/^\/blog\//, "").replace(/\/$/, "");
    if (!slug || slug === "blog") return "page-known"; // /blog/
    const exists = fs.existsSync(path.join(BLOG_DIR, `${slug}.md`));
    return exists ? "blog-post-exists" : "blog-post-missing";
  }
  if (KNOWN_PAGES.has(p)) return "page-known";
  if (URL_REWRITES[p]) return "page-rewritable";
  return "page-unknown";
}

function extractLinks(md) {
  // Markdown link: [text](href)
  const links = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(md))) {
    links.push({ text: m[1], href: m[2], full: m[0], index: m.index });
  }
  return links;
}

const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md"));
const report = { byType: {}, byFile: {} };
let totalLinks = 0, totalRewrites = 0;

for (const file of files) {
  const filePath = path.join(BLOG_DIR, file);
  let content = fs.readFileSync(filePath, "utf-8");
  const links = extractLinks(content);
  const fileReport = [];
  let rewritten = 0;
  for (const link of links) {
    totalLinks++;
    const type = classifyTarget(link.href);
    report.byType[type] = (report.byType[type] || 0) + 1;
    fileReport.push({ href: link.href, type, text: link.text.slice(0, 60) });

    if (FIX && isInternalAbsolute(link.href)) {
      let newHref = toRelative(link.href);
      // Apply URL rewrites for stale paths (about-us → about, etc.)
      const normalisedNew = normalize(newHref);
      if (URL_REWRITES[normalisedNew]) {
        newHref = URL_REWRITES[normalisedNew];
      }
      const newLink = `[${link.text}](${newHref})`;
      content = content.replace(link.full, newLink);
      rewritten++;
    }
  }
  if (FIX && rewritten > 0) {
    fs.writeFileSync(filePath, content);
    totalRewrites += rewritten;
  }
  if (fileReport.length) report.byFile[file] = fileReport;
}

// Print summary
console.log(`Scanned ${files.length} posts. Found ${totalLinks} links.\n`);
console.log("Links by type:");
for (const [t, c] of Object.entries(report.byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(22)} ${c}`);
}
console.log();

if (FIX) {
  console.log(`\nRewrote ${totalRewrites} mrpaint.com.au absolute URLs to relative paths.\n`);
}

// Detail: any problematic links
const problems = [];
for (const [file, fileLinks] of Object.entries(report.byFile)) {
  for (const l of fileLinks) {
    if (l.type === "blog-post-missing" || l.type === "page-unknown") {
      problems.push({ file, ...l });
    }
  }
}
if (problems.length) {
  console.log(`⚠ ${problems.length} potentially broken internal links:\n`);
  for (const p of problems) {
    console.log(`  ${p.file}`);
    console.log(`    → ${p.href}  [${p.type}]  (anchor text: "${p.text}")`);
  }
} else {
  console.log("✅ All internal links point to existing pages or posts.");
}
