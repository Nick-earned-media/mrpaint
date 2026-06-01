// Local smoke test for the chat() orchestrator.
// Runs three test queries end-to-end (no Twilio, just stdin/stdout).
//
//   node scripts/smoke-test-chat.js
//
// Tests:
//   1. KB retrieval only — "how do I get more Google reviews from my customers?"
//   2. KB-grounded client question — "what's the best paint for a hardwood refresher?"
//   3. Tool use — "list my competitors" → list_competitors tool call

require("../lib/load-env.js");

const { chat } = require("../lib/chat.js");
const { getClientBySlug } = require("../lib/supabase.js");

const TESTS = [
  {
    name: "Platform KB retrieval — Google reviews",
    message: "how do I get more Google reviews from my customers?",
    expect: ["review", /review|customer|ask/i],
  },
  {
    name: "Client KB retrieval — hardwood",
    message: "what should I use for a hardwood exterior refresher?",
    expect: ["Sikkens", /Sikkens|Cetol|filter|hardwood/i],
  },
  {
    name: "Tool call — list competitors",
    message: "who are my competitors?",
    expect: ["competitor", /Cairns Painting|Pete's|McLeod/i],
  },
];

async function main() {
  const client = await getClientBySlug("mrpaint");
  if (!client) throw new Error("mrpaint client not found");
  const phoneNumber = client.primary_phone || "+0000000000";
  console.log(`Using client ${client.display_name} (${client.id.slice(0, 8)}…) phone ${phoneNumber}\n`);

  let passed = 0;
  for (const t of TESTS) {
    console.log(`── ${t.name} ──`);
    console.log(`Q: ${t.message}`);
    const t0 = Date.now();
    try {
      const reply = await chat({
        clientId: client.id,
        phoneNumber,
        message: t.message,
        clientRow: client,
      });
      const ms = Date.now() - t0;
      console.log(`A (${ms}ms): ${reply.slice(0, 500)}${reply.length > 500 ? "…" : ""}`);

      const passes = t.expect.every((e) => {
        if (typeof e === "string") return reply.toLowerCase().includes(e.toLowerCase());
        if (e instanceof RegExp) return e.test(reply);
        return false;
      });
      console.log(passes ? "✓ pass\n" : "✗ FAIL — expected match not found\n");
      if (passes) passed++;
    } catch (err) {
      console.error("✗ ERROR:", err.message || err);
      console.log("");
    }
  }

  console.log(`── Result: ${passed}/${TESTS.length} passed ──`);
  process.exit(passed === TESTS.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
