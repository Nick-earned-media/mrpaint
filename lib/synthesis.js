// Weekly behaviour synthesis — rolls up a week's worth of behaviour:* events
// into one consolidated paragraph the bot can recall as "what we learned about
// this client this week".
//
// Two purposes:
//   1. Surfaces patterns the raw events alone might not (the bot's semantic
//      search returns 5 chunks; a synthesis chunk that summarises 30 events
//      gives it more signal per slot).
//   2. Acts as a controlled-detail rollup so older weeks can be archived /
//      pruned without losing the gist.
//
// Source type:
//   synthesis:weekly   — one row per client per ISO week
//
// LLM: Claude Haiku 4.5 (fast, cheap, more than enough for summarisation).

const { client: supa, embed } = require("./supabase.js");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are summarising one week of activity on a marketing-ops bot used by a single business owner. You receive a list of recorded events: jobs they published, drafts they rejected, and questions they asked the bot.

Your job: produce ONE short factual paragraph (max 150 words) that captures the patterns of the week. No speculation. No filler. Concrete facts only.

Aim to mention:
- How many jobs were published this week, in which suburbs, of what type, with what materials
- Any drafts that were rejected and what they were about
- Any recurring themes in the questions (e.g. "asked about pricing 3 times", "kept returning to the topic of commercial work")
- Anything notable or unusual

If there is nothing material to summarise, return the exact string "NOTHING_NOTABLE".

Reply with plain text only — no markdown, no headers, no preamble.`;

async function synthesiseWeekForClient(clientRow) {
  if (!clientRow?.id) return { skipped: "no client row" };
  if (!ANTHROPIC_API_KEY) return { skipped: "ANTHROPIC_API_KEY not set" };

  const sb = supa();

  const now = new Date();
  const periodEnd = new Date(now);
  const periodStart = new Date(now); periodStart.setDate(periodStart.getDate() - 7);
  const period = `${periodStart.toISOString().slice(0, 10)}_${periodEnd.toISOString().slice(0, 10)}`;

  // Pull behaviour events from the past 7 days.
  const { data: events, error } = await sb.from("kb_chunks")
    .select("source_type, chunk_text, source_date, metadata")
    .eq("client_id", clientRow.id)
    .like("source_type", "behaviour:%")
    .gte("source_date", periodStart.toISOString())
    .order("source_date", { ascending: true });
  if (error) throw new Error(`behaviour pull: ${error.message}`);

  if (!events || events.length < 3) {
    return { skipped: `only ${events?.length || 0} behaviour events this week — nothing to synthesise` };
  }

  const eventList = events.map((e, i) =>
    `[${i + 1}] (${e.source_type.replace("behaviour:", "")}, ${e.source_date.slice(0, 10)}) ${e.chunk_text}`
  ).join("\n\n");

  const userPrompt =
    `Client: ${clientRow.display_name || clientRow.slug}\n` +
    `Period: ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}\n` +
    `Event count: ${events.length}\n\n` +
    `Events:\n${eventList}`;

  // Call Claude.
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic ${MODEL} ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  const summary = (data.content?.[0]?.text || "").trim();

  if (!summary || summary === "NOTHING_NOTABLE") {
    return { skipped: `Claude returned no notable synthesis`, events_seen: events.length };
  }

  // Embed + upsert.
  const chunk_text =
    `Weekly synthesis for ${clientRow.display_name || clientRow.slug} ` +
    `(${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}):\n\n${summary}`;

  const embedding = await embed(chunk_text);
  const source_id = `synthesis:weekly:${period}`;

  await sb.from("kb_chunks")
    .delete()
    .eq("client_id", clientRow.id)
    .eq("source_id", source_id);

  const { error: insErr } = await sb.from("kb_chunks").insert({
    client_id: clientRow.id,
    source_type: "synthesis:weekly",
    source_id,
    source_date: now.toISOString(),
    chunk_text,
    embedding,
    metadata: {
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      event_count: events.length,
      model: MODEL,
    },
  });
  if (insErr) throw new Error(`synthesis insert: ${insErr.message}`);

  return { period: { start: periodStart.toISOString().slice(0, 10), end: periodEnd.toISOString().slice(0, 10) }, events_seen: events.length, summary_chars: summary.length };
}

module.exports = { synthesiseWeekForClient };
