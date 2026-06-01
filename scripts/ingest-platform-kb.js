// Ingest ~/mrpaint/platform-kb/*.md into the platform_kb table.
//
// Chunks each article on H2 / H3 boundaries (one chunk per section),
// embeds with OpenAI text-embedding-3-small, upserts to platform_kb.
//
// Idempotent — re-running replaces existing rows for the same source_url + chunk_index.
//
// Run with:
//   node scripts/ingest-platform-kb.js

require("../lib/load-env.js");

const fs = require("fs");
const path = require("path");
const { client: supa, embedBatch } = require("../lib/supabase.js");

const KB_DIR = path.join(__dirname, "..", "platform-kb");

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

// Chunk on H2 / H3 headings. Each chunk = heading + body until next same-or-higher heading.
function chunkMarkdown(body) {
  const lines = body.split("\n");
  const chunks = [];
  let current = { heading: "Introduction", text: [] };

  for (const line of lines) {
    const h2 = line.match(/^## (.+)$/);
    const h3 = line.match(/^### (.+)$/);
    if (h2 || h3) {
      if (current.text.length) {
        chunks.push({ heading: current.heading, text: current.text.join("\n").trim() });
      }
      current = { heading: (h2 || h3)[1], text: [line] };
    } else {
      current.text.push(line);
    }
  }
  if (current.text.length) {
    chunks.push({ heading: current.heading, text: current.text.join("\n").trim() });
  }

  // Filter out chunks that are too short to be useful
  return chunks.filter((c) => c.text.length > 100);
}

async function ingestFile(filepath) {
  const raw = fs.readFileSync(filepath, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  const basename = path.basename(filepath, ".md");

  if (basename === "README" || !meta.source) {
    console.log(`  skip ${basename} (no frontmatter source)`);
    return 0;
  }

  const chunks = chunkMarkdown(body);
  if (!chunks.length) {
    console.log(`  skip ${basename} (no chunks)`);
    return 0;
  }

  console.log(`  ${basename}: ${chunks.length} chunks`);

  // Embed all chunks in one batch
  const texts = chunks.map((c) => `# ${c.heading}\n\n${c.text}`);
  const embeddings = await embedBatch(texts);

  // Delete existing rows for this source_url so re-runs are idempotent
  await supa().from("platform_kb").delete().eq("source_url", meta.source_url);

  // Insert new
  const rows = chunks.map((c, i) => ({
    source: meta.source,
    source_url: meta.source_url,
    topic: meta.topic || "general",
    audience: meta.audience || "both",
    chunk_text: texts[i],
    chunk_index: i,
    embedding: embeddings[i],
    quality: meta.quality || "high",
    fetched_at: meta.fetched_at ? new Date(meta.fetched_at).toISOString() : new Date().toISOString(),
    metadata: { heading: c.heading, basename },
  }));

  const { error } = await supa().from("platform_kb").insert(rows);
  if (error) throw error;

  return rows.length;
}

async function main() {
  const files = fs.readdirSync(KB_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => path.join(KB_DIR, f));

  console.log(`Found ${files.length} platform-kb .md files`);

  let total = 0;
  for (const f of files) {
    try {
      total += await ingestFile(f);
    } catch (err) {
      console.error(`  ERR ${path.basename(f)}: ${err.message}`);
    }
  }

  console.log(`\n✓ Ingested ${total} chunks into platform_kb`);
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
