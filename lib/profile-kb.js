// Structured client profile → kb_chunks.
//
// Reads the client_profile row and splits it into semantic sections — each
// section becomes its own embedded chunk in kb_chunks. The bot then retrieves
// the relevant section via searchClientKb when the operator's question maps
// to it (e.g. "what brands do I use?" pulls the paint_brands chunk).
//
// Idempotent: a stable source_id per section (e.g. `profile:services`) means
// re-running this replaces the prior chunk instead of accumulating.
//
// Source types: profile:fundamentals, profile:services, profile:suburbs,
//                profile:brands, profile:staff, profile:voice, profile:goals,
//                profile:competitive, profile:warranty_hours,
//                profile:notable_jobs.

const { client: supa, embed } = require("./supabase.js");

async function ingestProfileForClient(clientRow) {
  if (!clientRow?.id) return { skipped: "no client row" };

  const sb = supa();
  const { data: profile, error } = await sb
    .from("client_profile")
    .select("*")
    .eq("client_id", clientRow.id)
    .maybeSingle();
  if (error) throw new Error(`profile read: ${error.message}`);
  if (!profile) return { skipped: `no client_profile row for ${clientRow.slug}` };

  const chunks = profileToChunks(profile, clientRow);
  if (chunks.length === 0) return { chunks_written: 0, note: "profile is empty" };

  // Embed in one batch.
  const { embedBatch } = require("./supabase.js");
  const embeddings = await embedBatch(chunks.map((c) => c.chunk_text));

  // Replace any existing rows with the same source_id (one row per section).
  const sourceIds = chunks.map((c) => c.source_id);
  await sb.from("kb_chunks")
    .delete()
    .eq("client_id", clientRow.id)
    .in("source_id", sourceIds);

  const today = new Date().toISOString();
  const rows = chunks.map((c, i) => ({
    client_id: clientRow.id,
    source_type: c.source_type,
    source_id: c.source_id,
    source_date: today,
    chunk_text: c.chunk_text,
    chunk_index: i,
    embedding: embeddings[i],
    metadata: c.metadata || {},
  }));

  const { error: insErr } = await sb.from("kb_chunks").insert(rows);
  if (insErr) throw new Error(`kb_chunks insert: ${insErr.message}`);

  return { chunks_written: rows.length, sections: chunks.map((c) => c.source_id) };
}

// ─── Section splitter ──────────────────────────────────────────────────────

function profileToChunks(p, clientRow) {
  const name = clientRow.display_name || clientRow.slug;
  const chunks = [];

  // 1. Fundamentals — founded year, service radius, location summary.
  const fundParts = [];
  if (p.founded_year) fundParts.push(`${name} was founded in ${p.founded_year}.`);
  if (p.service_radius_km) fundParts.push(`Service radius: about ${p.service_radius_km} km from base.`);
  if (p.warranty) fundParts.push(`Warranty: ${p.warranty}.`);
  if (fundParts.length) {
    chunks.push({
      source_type: "profile:fundamentals",
      source_id: "profile:fundamentals",
      chunk_text: `Business fundamentals for ${name}. ${fundParts.join(" ")}`,
      metadata: { founded_year: p.founded_year, service_radius_km: p.service_radius_km },
    });
  }

  // 2. Services
  if (Array.isArray(p.services) && p.services.length) {
    const lines = p.services.map((s, i) => `${i + 1}. ${typeof s === "string" ? s : (s.name || JSON.stringify(s))}`);
    chunks.push({
      source_type: "profile:services",
      source_id: "profile:services",
      chunk_text: `Services offered by ${name}:\n${lines.join("\n")}`,
      metadata: { services: p.services },
    });
  }

  // 3. Suburbs served
  if (Array.isArray(p.suburbs_served) && p.suburbs_served.length) {
    chunks.push({
      source_type: "profile:suburbs",
      source_id: "profile:suburbs",
      chunk_text: `${name} regularly works in these suburbs: ${p.suburbs_served.join(", ")}.`,
      metadata: { suburbs_served: p.suburbs_served },
    });
  }

  // 4. Brands + preferred products
  const brandParts = [];
  if (Array.isArray(p.paint_brands_used) && p.paint_brands_used.length) {
    const lines = p.paint_brands_used.map((b) => {
      if (typeof b === "string") return b;
      const products = Array.isArray(b.products) && b.products.length ? ` (${b.products.join(", ")})` : "";
      const use = b.use_case ? ` for ${b.use_case}` : "";
      return `${b.brand}${products}${use}`;
    });
    brandParts.push(`Paint brands: ${lines.join("; ")}.`);
  }
  if (Array.isArray(p.tool_brands_used) && p.tool_brands_used.length) {
    const lines = p.tool_brands_used.map((b) => typeof b === "string" ? b : (b.brand || JSON.stringify(b)));
    brandParts.push(`Tool brands: ${lines.join(", ")}.`);
  }
  if (p.preferred_products && Object.keys(p.preferred_products).length) {
    const lines = Object.entries(p.preferred_products).map(([useCase, product]) => `${useCase}: ${product}`);
    brandParts.push(`Preferred products by use case — ${lines.join("; ")}.`);
  }
  if (brandParts.length) {
    chunks.push({
      source_type: "profile:brands",
      source_id: "profile:brands",
      chunk_text: `Materials and tools ${name} uses. ${brandParts.join(" ")}`,
      metadata: {
        paint_brands_used: p.paint_brands_used,
        tool_brands_used: p.tool_brands_used,
        preferred_products: p.preferred_products,
      },
    });
  }

  // 5. Staff
  if (Array.isArray(p.staff) && p.staff.length) {
    const lines = p.staff.map((s) => {
      if (typeof s === "string") return s;
      const role = s.role ? ` — ${s.role}` : "";
      const specialties = Array.isArray(s.specialties) && s.specialties.length ? ` (specialties: ${s.specialties.join(", ")})` : "";
      return `${s.name}${role}${specialties}`;
    });
    chunks.push({
      source_type: "profile:staff",
      source_id: "profile:staff",
      chunk_text: `Staff at ${name}:\n${lines.join("\n")}`,
      metadata: { staff: p.staff },
    });
  }

  // 6. Voice rules — do/don't say + business values
  const voiceParts = [];
  if (Array.isArray(p.business_values) && p.business_values.length) {
    voiceParts.push(`Business values: ${p.business_values.join("; ")}.`);
  }
  if (Array.isArray(p.do_say) && p.do_say.length) {
    voiceParts.push(`Things to say: ${p.do_say.map((s) => `"${s}"`).join("; ")}.`);
  }
  if (Array.isArray(p.dont_say) && p.dont_say.length) {
    voiceParts.push(`Things to avoid saying: ${p.dont_say.map((s) => `"${s}"`).join("; ")}.`);
  }
  if (voiceParts.length) {
    chunks.push({
      source_type: "profile:voice",
      source_id: "profile:voice",
      chunk_text: `Brand voice rules for ${name}. ${voiceParts.join(" ")}`,
      metadata: {
        business_values: p.business_values,
        do_say: p.do_say,
        dont_say: p.dont_say,
      },
    });
  }

  // 7. Goals
  if (p.goals && Object.keys(p.goals).length) {
    const lines = [];
    if (p.goals.success_definition) lines.push(`Success looks like: ${p.goals.success_definition}.`);
    if (p.goals.growth_signals)    lines.push(`Growth signals to watch for: ${p.goals.growth_signals}.`);
    if (p.goals.stuck_areas)       lines.push(`Areas feeling stuck: ${p.goals.stuck_areas}.`);
    if (p.goals.ideal_customer)    lines.push(`Ideal customer: ${p.goals.ideal_customer}.`);
    if (p.goals.avoid_segments)    lines.push(`Customer segments to avoid: ${p.goals.avoid_segments}.`);
    if (lines.length) {
      chunks.push({
        source_type: "profile:goals",
        source_id: "profile:goals",
        chunk_text: `Goals and direction for ${name}. ${lines.join(" ")}`,
        metadata: { goals: p.goals },
      });
    }
  }

  // 8. Competitive position
  if (p.competitive_position && Object.keys(p.competitive_position).length) {
    const lines = [];
    if (p.competitive_position.strengths) lines.push(`Strengths vs competitors: ${p.competitive_position.strengths}.`);
    if (p.competitive_position.gaps)      lines.push(`Gaps vs competitors: ${p.competitive_position.gaps}.`);
    if (lines.length) {
      chunks.push({
        source_type: "profile:competitive",
        source_id: "profile:competitive",
        chunk_text: `Competitive position of ${name}. ${lines.join(" ")}`,
        metadata: { competitive_position: p.competitive_position },
      });
    }
  }

  // 9. Hours
  if (p.hours && Object.keys(p.hours).length) {
    const lines = Object.entries(p.hours).map(([day, h]) => `${day}: ${h}`);
    chunks.push({
      source_type: "profile:warranty_hours",
      source_id: "profile:warranty_hours",
      chunk_text: `Operating hours for ${name}:\n${lines.join("\n")}${p.warranty ? `\n\nWarranty: ${p.warranty}` : ""}`,
      metadata: { hours: p.hours, warranty: p.warranty },
    });
  }

  // 10. Notable jobs
  if (Array.isArray(p.notable_jobs) && p.notable_jobs.length) {
    const lines = p.notable_jobs.map((j, i) => {
      if (typeof j === "string") return `${i + 1}. ${j}`;
      const parts = [j.title || j.summary || JSON.stringify(j)];
      if (j.suburb) parts.push(`(${j.suburb})`);
      if (j.year)   parts.push(j.year);
      return `${i + 1}. ${parts.join(" ")}`;
    });
    chunks.push({
      source_type: "profile:notable_jobs",
      source_id: "profile:notable_jobs",
      chunk_text: `Notable jobs from ${name}:\n${lines.join("\n")}`,
      metadata: { notable_jobs: p.notable_jobs },
    });
  }

  return chunks;
}

module.exports = { ingestProfileForClient, profileToChunks };
