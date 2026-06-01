// Validate that the database is wired correctly and KB retrieval works.
// Runs a few canonical queries against both platform_kb and client kb_chunks.
//
// Run after `npm run ingest:platform` and `npm run ingest:client`:
//   node scripts/smoke-test-kb.js

require("../lib/load-env.js");

const {
  client: supa,
  searchPlatformKb,
  searchClientKb,
  getClientBySlug,
  getClientProfile,
} = require("../lib/supabase.js");

async function main() {
  console.log("─── Smoke test 1: client lookup ───");
  const client = await getClientBySlug("mrpaint");
  if (!client) throw new Error("client mrpaint not found — run db:seed first");
  console.log(`  ✓ Found client: ${client.display_name} (id=${client.id.slice(0, 8)}…)`);

  console.log("\n─── Smoke test 2: client_profile loaded ───");
  const profile = await getClientProfile(client.id);
  if (!profile) throw new Error("client_profile not seeded");
  console.log(`  ✓ Suburbs served: ${profile.suburbs_served.length}`);
  console.log(`  ✓ Paint brands: ${JSON.parse(JSON.stringify(profile.paint_brands_used)).length}`);
  console.log(`  ✓ Do-say vocabulary: ${profile.do_say.length} terms`);

  console.log("\n─── Smoke test 3: platform_kb row count ───");
  const { count: pkbCount, error: e1 } = await supa()
    .from("platform_kb").select("*", { count: "exact", head: true });
  if (e1) throw e1;
  console.log(`  ✓ platform_kb rows: ${pkbCount}`);

  console.log("\n─── Smoke test 4: kb_chunks row count for mrpaint ───");
  const { count: kbCount, error: e2 } = await supa()
    .from("kb_chunks").select("*", { count: "exact", head: true })
    .eq("client_id", client.id);
  if (e2) throw e2;
  console.log(`  ✓ kb_chunks rows: ${kbCount}`);

  console.log("\n─── Smoke test 5: semantic search — platform_kb ───");
  const q1 = "how to ask for Google reviews from customers";
  const r1 = await searchPlatformKb(q1, { count: 3 });
  console.log(`  query: "${q1}"`);
  r1.forEach((row, i) =>
    console.log(`    ${i + 1}. [${row.source}] ${row.chunk_text.slice(0, 80)}…  (sim=${row.similarity.toFixed(3)})`)
  );

  console.log("\n─── Smoke test 6: semantic search — client kb_chunks ───");
  const q2 = "weatherboard strip and repaint";
  const r2 = await searchClientKb(client.id, q2, { count: 3 });
  console.log(`  query: "${q2}"`);
  r2.forEach((row, i) =>
    console.log(`    ${i + 1}. [${row.source_type}] ${row.chunk_text.slice(0, 80)}…  (sim=${row.similarity.toFixed(3)})`)
  );

  console.log("\n─── Smoke test 7: competitor rows ───");
  const { data: comps } = await supa()
    .from("competitors").select("name, domain").eq("client_id", client.id);
  console.log(`  ✓ ${comps.length} competitors loaded:`);
  comps.forEach((c) => console.log(`    - ${c.name} (${c.domain})`));

  console.log("\n✓ All smoke tests passed. KB foundation is wired and retrievable.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
