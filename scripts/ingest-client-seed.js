// Ingest ~/mrpaint/platform-kb/seed-from-adrian/*.txt into kb_chunks for
// the mrpaint client. Adrian's voice notes become L3 semantic memory.
//
// Run with:
//   node scripts/ingest-client-seed.js

require("../lib/load-env.js");

const fs = require("fs");
const path = require("path");
const { client: supa, embedBatch, getClientBySlug } = require("../lib/supabase.js");

const SEED_DIR = path.join(__dirname, "..", "platform-kb", "seed-from-adrian");
const CLIENT_SLUG = "mrpaint";

// Files we want to ingest. Each entry: filename → metadata for the chunk.
const FILES = [
  {
    file: "audio-1-brinsmead.txt",
    source_type: "voice_note",
    source_id: "audio-1-brinsmead",
    source_date: "2026-05-31T14:40:18+10:00",
    metadata: { suburb: "Brinsmead", job_type: "exterior_hardwood_refresh", brands: ["Sikkens"] },
    extract_cleaned_section: true, // strip raw transcript noise, use the CLEANED section
  },
  {
    file: "audio-2-bungalow-eves.txt",
    source_type: "voice_note",
    source_id: "audio-2-bungalow-eves",
    source_date: "2026-05-31T14:46:46+10:00",
    metadata: { suburb: "Bungalow", job_type: "pressure_wash_prep", brands: [] },
    extract_cleaned_section: true,
  },
  {
    file: "audio-3-bungalow-queenslander.txt",
    source_type: "voice_note",
    source_id: "audio-3-bungalow-queenslander",
    source_date: "2026-05-31T14:47:57+10:00",
    metadata: { suburb: "Bungalow", job_type: "full_weatherboard_strip_recoat", brands: ["Sikkens", "Dulux", "Festool", "Makita"], architectural_style: "high-set Queenslander" },
    extract_cleaned_section: true,
  },
  {
    file: "photos.md",
    source_type: "seed",
    source_id: "photos-2026-05-31",
    source_date: "2026-05-31T14:46:29+10:00",
    metadata: { type: "photo_index", suburbs: ["Bungalow"] },
    extract_cleaned_section: false,
  },
];

function extractCleanedTranscript(raw) {
  const m = raw.match(/CLEANED \(best-guess interpretation\):\n[─]+\n([\s\S]*?)(?:\n\nCONFIDENCE|$)/);
  return m ? m[1].trim() : raw;
}

async function main() {
  const client = await getClientBySlug(CLIENT_SLUG);
  if (!client) {
    throw new Error(`Client '${CLIENT_SLUG}' not found — run db/seeds/001_mrpaint_profile.sql first`);
  }
  console.log(`Client: ${client.display_name} (${client.id})`);

  // Build chunks
  const chunkRecords = [];
  for (const entry of FILES) {
    const filepath = path.join(SEED_DIR, entry.file);
    if (!fs.existsSync(filepath)) {
      console.log(`  skip ${entry.file} (missing)`);
      continue;
    }
    const raw = fs.readFileSync(filepath, "utf8");
    const text = entry.extract_cleaned_section ? extractCleanedTranscript(raw) : raw;

    chunkRecords.push({
      file: entry.file,
      source_type: entry.source_type,
      source_id: entry.source_id,
      source_date: entry.source_date,
      chunk_text: text,
      metadata: entry.metadata,
    });
  }

  if (!chunkRecords.length) {
    console.log("No chunks to ingest");
    return;
  }

  console.log(`Embedding ${chunkRecords.length} chunks…`);
  const embeddings = await embedBatch(chunkRecords.map((c) => c.chunk_text));

  // Delete existing rows for these source_ids so re-runs are idempotent
  const sourceIds = chunkRecords.map((c) => c.source_id);
  await supa().from("kb_chunks")
    .delete()
    .eq("client_id", client.id)
    .in("source_id", sourceIds);

  const rows = chunkRecords.map((c, i) => ({
    client_id: client.id,
    source_type: c.source_type,
    source_id: c.source_id,
    source_date: c.source_date,
    chunk_text: c.chunk_text,
    chunk_index: 0,
    embedding: embeddings[i],
    metadata: c.metadata,
  }));

  const { error } = await supa().from("kb_chunks").insert(rows);
  if (error) throw error;

  console.log(`✓ Ingested ${rows.length} kb_chunks for ${client.display_name}`);
}

main().catch((err) => {
  console.error("Client seed ingestion failed:", err);
  process.exit(1);
});
