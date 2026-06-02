// One-shot: pull Semrush Position Tracking for MrPaint right now.
// Populates tracked_keywords + writes today's keyword_history baseline.
//
//   node scripts/sync-semrush-once.js

require("../lib/load-env.js");

const { getClientBySlug } = require("../lib/supabase.js");
const { syncTrackedKeywords } = require("../lib/sync-semrush.js");

async function main() {
  const client = await getClientBySlug("mrpaint");
  if (!client) throw new Error("client mrpaint not found");
  console.log(`Syncing Semrush → tracked_keywords for ${client.display_name}…`);
  const r = await syncTrackedKeywords(client.id);
  console.log("✓ Done");
  console.log(JSON.stringify(r, null, 2));
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
