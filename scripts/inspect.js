#!/usr/bin/env node
/**
 * Quick HTML inspector. Strips Elementor cruft and prints visible text structure
 * (title, meta, headings, paragraphs, images) from one mirrored page.
 *
 *   node scripts/inspect.js /tmp/mrpaint-mirror/index.html
 *
 * Used during the initial content-audit phase of the static rebuild.
 */
const fs = require("node:fs");
const path = require("node:path");
const { load } = require("cheerio");

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/inspect.js <path-to-html>");
  process.exit(1);
}

const html = fs.readFileSync(file, "utf8");
const $ = load(html);

$("script, style, noscript, link[rel='stylesheet'], iframe").remove();

const title = $("title").text().trim();
const desc = $("meta[name='description']").attr("content") || "";
const canonical = $("link[rel='canonical']").attr("href") || "";

console.log(`FILE:        ${file}`);
console.log(`TITLE:       ${title}`);
console.log(`DESCRIPTION: ${desc}`);
console.log(`CANONICAL:   ${canonical}`);
console.log("---");

$("h1, h2, h3, h4, p, li").each((_, el) => {
  const tag = el.tagName.toUpperCase();
  const text = $(el).text().replace(/\s+/g, " ").trim();
  if (!text || text.length < 3) return;
  if (text.length > 400) return;
  console.log(`[${tag}] ${text}`);
});

console.log("---");
console.log("IMAGES:");
$("img").each((_, el) => {
  const src = $(el).attr("src") || $(el).attr("data-src") || "";
  const alt = $(el).attr("alt") || "";
  if (!src) return;
  if (src.includes("data:image")) return;
  console.log(`  ${src}  (alt: "${alt}")`);
});
