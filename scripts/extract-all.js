#!/usr/bin/env node
/**
 * Walk the mrpaint.com.au mirror and emit one structured JSON per page —
 * title, meta description, canonical, h1/h2/h3 in order, paragraphs in order,
 * images with src+alt — into scripts/extracted/.
 *
 * Designed to feed the static rebuild; not run at build time.
 *
 *   node scripts/extract-all.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { load } = require("cheerio");

const MIRROR = "/tmp/mrpaint-mirror";
const OUT = path.join(__dirname, "extracted");
fs.mkdirSync(OUT, { recursive: true });

const SKIP_DIRS = new Set([
  "wp-content", "wp-json", "wp-includes", "wp-admin",
  "feed", "comments", "author", "category", "page", "tag",
  "2020", "2021", "2022", "2023", "2024", "2025", "2026",
]);
const SKIP_NAMES = new Set(["wp-login.php.html", "'.html"]);

function isInteresting(file) {
  if (!file.endsWith(".html")) return false;
  if (file.includes("?p=")) return false;
  if (file.includes("?")) return false;
  const base = path.basename(file);
  if (SKIP_NAMES.has(base)) return false;
  for (const part of file.split(path.sep)) {
    if (SKIP_DIRS.has(part)) return false;
  }
  return true;
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && isInteresting(full)) acc.push(full);
  }
  return acc;
}

function extract(file) {
  const html = fs.readFileSync(file, "utf8");
  const $ = load(html);
  $("script, style, noscript, link[rel='stylesheet'], iframe, svg, .elementor-element-edit-mode").remove();

  const rel = path.relative(MIRROR, file);
  const url = "/" + rel.replace(/\\/g, "/").replace(/\/index\.html$/, "/").replace(/\.html$/, "");

  const title = $("title").text().trim();
  const description = $("meta[name='description']").attr("content") || "";
  const canonical = $("link[rel='canonical']").attr("href") || "";
  const ogImage = $("meta[property='og:image']").attr("content") || "";

  const headings = [];
  $("h1, h2, h3, h4").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && text.length > 1 && text.length < 300) headings.push({ tag, text });
  });

  const paragraphs = [];
  $("p").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && text.length > 20 && text.length < 1500) paragraphs.push(text);
  });

  const images = [];
  const seenImg = new Set();
  $("img").each((_, el) => {
    let src = $(el).attr("src") || $(el).attr("data-src") || "";
    const alt = $(el).attr("alt") || "";
    if (!src || src.includes("data:image")) return;
    if (src.startsWith("//")) src = "https:" + src;
    if (seenImg.has(src)) return;
    seenImg.add(src);
    images.push({ src, alt });
  });

  return { file: rel, url, title, description, canonical, ogImage, headings, paragraphs, images };
}

const files = walk(MIRROR).sort();
console.log(`Found ${files.length} interesting files`);

const all = [];
for (const f of files) {
  try {
    const data = extract(f);
    all.push(data);
    const slug = data.file.replace(/\//g, "__").replace(/\.html$/, "").replace(/^__/, "") || "_root";
    fs.writeFileSync(path.join(OUT, `${slug}.json`), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("FAIL", f, e.message);
  }
}

fs.writeFileSync(path.join(OUT, "_index.json"), JSON.stringify(
  all.map((p) => ({ url: p.url, title: p.title, description: p.description, headings: p.headings.length, paragraphs: p.paragraphs.length, images: p.images.length, file: p.file })),
  null, 2
));

console.log(`Wrote ${all.length} JSON files to ${OUT}`);
