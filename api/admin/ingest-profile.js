// Manual admin endpoint to re-ingest the structured client_profile into
// kb_chunks. Run this after editing the profile in Supabase (or as part of
// onboarding a new client) to refresh the bot's structured knowledge.
//
// Auth: Bearer token in Authorization header, compared against INGEST_TOKEN.
//
// Query params:
//   ?client=mrpaint     — slug of the client to ingest (required)
//
// Returns: { ok: true, chunks_written: N, sections: [...] }

const { client: supa } = require("../../lib/supabase.js");
const { ingestProfileForClient } = require("../../lib/profile-kb.js");

module.exports = async function handler(req, res) {
  const expected = process.env.INGEST_TOKEN ? `Bearer ${process.env.INGEST_TOKEN}` : null;
  if (expected && req.headers.authorization !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const slug = req.query?.client;
  if (!slug) return res.status(400).json({ error: "Missing ?client=<slug>" });

  try {
    const { data: clientRow, error } = await supa()
      .from("clients")
      .select("id, slug, display_name")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    if (!clientRow) return res.status(404).json({ error: `client ${slug} not found` });

    const result = await ingestProfileForClient(clientRow);
    return res.status(200).json({ ok: true, slug, ...result });
  } catch (err) {
    console.error("[ingest-profile]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
