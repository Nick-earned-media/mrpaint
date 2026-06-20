// Conversational orchestrator. The bot brain.
//
// Public API: chat({ clientId, phoneNumber, message }) → string (the bot's reply)
//
// What it does each turn:
//   1. Open or resume a conversation thread for this client+phone.
//   2. Build context: profile, pinned voice samples, recent thread history,
//      semantically-retrieved chunks from both client KB and platform KB.
//   3. Call Claude Sonnet with strategist prompt + context + tools.
//   4. Loop tool_use → run tool → tool_result → next turn (max 5 iterations).
//   5. Persist user + assistant + tool turns to conversation_messages.
//   6. Return the final assistant text.
//
// Env vars: ANTHROPIC_API_KEY.

const fs = require("fs");
const path = require("path");

const {
  client: supa,
  searchClientKb,
  searchPlatformKb,
  getOrCreateThread,
  appendMessage,
  getRecentMessages,
  getClientProfile,
  getPinnedVoiceSamples,
} = require("./supabase.js");

const { TOOL_DEFINITIONS, dispatch } = require("./tools.js");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SONNET_MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ITERATIONS = 5;
const MAX_TOKENS_PER_TURN = 1500;

// Load the strategist prompt template once.
const STRATEGIST_PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, "strategist-prompt.md"),
  "utf8"
);

async function chat({ clientId, phoneNumber, message, clientRow }) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!clientId) throw new Error("clientId required");
  if (!message) throw new Error("message required");

  // 1. Open / resume thread.
  const thread = await getOrCreateThread(clientId, phoneNumber);

  // 2. Persist the user's message FIRST so it's recorded even if the model fails.
  await appendMessage(thread.id, { role: "user", content: message });

  // 3. Build context in parallel.
  const [profile, voiceSamples, recentMessages, clientKb, platformKb] = await Promise.all([
    getClientProfile(clientId),
    getPinnedVoiceSamples(clientId, 3),
    getRecentMessages(thread.id, 20),
    searchClientKb(clientId, message, { count: 5 }).catch(() => []),
    searchPlatformKb(message, { count: 5 }).catch(() => []),
  ]);

  // 4. Build the system prompt with all retrieved context.
  const systemPrompt = buildSystemPrompt({
    template: STRATEGIST_PROMPT_TEMPLATE,
    clientRow,
    profile,
    voiceSamples,
    clientKb,
    platformKb,
  });

  // 5. Convert thread history to Anthropic message format.
  // Exclude the just-inserted user message; we'll add it back as the latest turn.
  const history = recentMessages
    .filter((m) => m.id !== undefined)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.content && String(m.content).trim().length > 0);

  // Drop the most recent user message if it matches the one we just inserted
  // (they're the same; we'll add the current one fresh below).
  const lastUserIdx = (() => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") return i;
    }
    return -1;
  })();
  const trimmedHistory =
    lastUserIdx >= 0 && history[lastUserIdx].content === message
      ? history.slice(0, lastUserIdx)
      : history;

  const messages = [];
  for (const m of trimmedHistory) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: message });

  // 6. Tool loop.
  const ctx = { clientId, phoneNumber, clientRow };
  let finalText = "";

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const resp = await callSonnet({
      system: systemPrompt,
      messages,
      tools: TOOL_DEFINITIONS,
    });

    // Append assistant content blocks to messages.
    messages.push({ role: "assistant", content: resp.content });

    // Collect tool_use blocks, if any.
    const toolUses = resp.content.filter((c) => c.type === "tool_use");

    if (toolUses.length === 0) {
      // No tools used → done. Extract the text.
      const textBlocks = resp.content.filter((c) => c.type === "text");
      finalText = textBlocks.map((c) => c.text).join("\n").trim();
      break;
    }

    // Run each tool in parallel and assemble tool_result blocks.
    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        const result = await dispatch(tu.name, tu.input, ctx);
        // Persist the tool call + result for the audit trail.
        await appendMessage(thread.id, {
          role: "tool",
          content: typeof result === "string" ? result : JSON.stringify(result),
          toolName: tu.name,
          toolCalls: [{ id: tu.id, name: tu.name, input: tu.input }],
          toolPayload: { result },
        }).catch(() => {});
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        };
      })
    );

    messages.push({ role: "user", content: toolResults });

    // If Sonnet didn't signal end_turn, loop again.
    if (resp.stop_reason === "end_turn") {
      const textBlocks = resp.content.filter((c) => c.type === "text");
      finalText = textBlocks.map((c) => c.text).join("\n").trim();
      // But there were tool_uses with no text — usually the model wants another turn.
      if (!finalText) continue;
      break;
    }
  }

  if (!finalText) {
    finalText = "I had a go at that but couldn't get a clean answer out. Try rephrasing?";
  }

  // 7. Persist the final assistant message.
  await appendMessage(thread.id, { role: "assistant", content: finalText }).catch(() => {});

  // 8. Record the Q&A as a behaviour event in the KB. Fire and forget —
  //    never blocks the response and never throws back to the caller.
  try {
    const { recordQuestionAnswered } = require("./behaviour-kb.js");
    recordQuestionAnswered({
      clientId,
      threadId: thread.id,
      question: message,
      answer: finalText,
    }).catch(() => {});
  } catch {}

  return finalText;
}

// ─── system prompt builder ───────────────────────────────────────────────

function buildSystemPrompt({
  template,
  clientRow,
  profile,
  voiceSamples,
  clientKb,
  platformKb,
}) {
  // Light template substitution for the bits the template references.
  const displayName = clientRow?.display_name || "your client";
  const ownerFirstName = clientRow?.owner_first_name || "the owner";
  let prompt = template
    .replace(/\{\{client\.display_name\}\}/g, displayName)
    .replace(/\{\{client\.owner_first_name\}\}/g, ownerFirstName);

  // Append the dynamic context block.
  const ctxLines = [];
  ctxLines.push("");
  ctxLines.push("---");
  ctxLines.push("");
  ctxLines.push("## LIVE CONTEXT FOR THIS TURN");
  ctxLines.push("");

  // L1 profile
  ctxLines.push("[CLIENT PROFILE — L1]");
  if (profile) {
    if (clientRow?.display_name) ctxLines.push(`business: ${clientRow.display_name}`);
    if (Array.isArray(profile.services) && profile.services.length) {
      ctxLines.push(`services: ${profile.services.map(s => typeof s === "string" ? s : (s.name || s.title || JSON.stringify(s))).join(", ")}`);
    }
    if (profile.suburbs_served?.length) ctxLines.push(`suburbs_served: ${profile.suburbs_served.join(", ")}`);
    if (Array.isArray(profile.paint_brands_used) && profile.paint_brands_used.length) {
      ctxLines.push(`paint_brands: ${profile.paint_brands_used.map(b => typeof b === "string" ? b : (b.brand || JSON.stringify(b))).join(", ")}`);
    }
    if (Array.isArray(profile.tool_brands_used) && profile.tool_brands_used.length) {
      ctxLines.push(`tool_brands: ${profile.tool_brands_used.map(b => typeof b === "string" ? b : (b.brand || JSON.stringify(b))).join(", ")}`);
    }
    if (profile.goals && typeof profile.goals === "object" && Object.keys(profile.goals).length) {
      ctxLines.push(`goals: ${Object.entries(profile.goals).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" / ")}`);
    }
    if (profile.business_values?.length) ctxLines.push(`business_values: ${profile.business_values.join(", ")}`);
    if (profile.do_say?.length) ctxLines.push(`do_say: ${profile.do_say.join(", ")}`);
    if (profile.dont_say?.length) ctxLines.push(`dont_say: ${profile.dont_say.join(", ")}`);
  } else {
    ctxLines.push("(profile not yet seeded for this client)");
  }
  ctxLines.push("");

  // L2 voice samples
  ctxLines.push("[VOICE SAMPLES — L2 (pinned)]");
  if (voiceSamples?.length) {
    voiceSamples.forEach((v, i) => {
      const channel = v.channel ? `(${v.channel})` : "";
      ctxLines.push(`sample ${i + 1} ${channel}: ${String(v.content || "").slice(0, 400)}`);
    });
  } else {
    ctxLines.push("(no pinned voice samples yet — match the do_say vocabulary above)");
  }
  ctxLines.push("");

  // L3 retrieved client KB
  ctxLines.push("[RETRIEVED FROM CLIENT KB — L3 (top 5 for this query)]");
  if (clientKb?.length) {
    clientKb.forEach((r, i) => {
      const tag = r.source_type + (r.source_date ? ` · ${String(r.source_date).slice(0, 10)}` : "");
      ctxLines.push(`chunk ${i + 1} [${tag}] sim=${Number(r.similarity).toFixed(3)}`);
      ctxLines.push(String(r.chunk_text).slice(0, 600));
      ctxLines.push("");
    });
  } else {
    ctxLines.push("(no matching chunks)");
    ctxLines.push("");
  }

  // Platform KB
  ctxLines.push("[PLATFORM KNOWLEDGE — top 5 chunks for this query]");
  if (platformKb?.length) {
    platformKb.forEach((r, i) => {
      ctxLines.push(`chunk ${i + 1} [${r.source}] sim=${Number(r.similarity).toFixed(3)}`);
      ctxLines.push(String(r.chunk_text).slice(0, 600));
      ctxLines.push("");
    });
  } else {
    ctxLines.push("(no matching chunks)");
    ctxLines.push("");
  }

  ctxLines.push("---");
  ctxLines.push("");
  ctxLines.push("Reminder: only use the above context plus the conversation history. If you need live data (rankings, semrush snapshot, captured jobs, etc.), use the tools available. Do not invent numbers, dates, or events.");

  return prompt + "\n" + ctxLines.join("\n");
}

// ─── Anthropic call ──────────────────────────────────────────────────────

async function callSonnet({ system, messages, tools }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: MAX_TOKENS_PER_TURN,
      system,
      messages,
      tools,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic ${SONNET_MODEL} ${r.status}: ${body.slice(0, 400)}`);
  }
  return r.json();
}

module.exports = { chat };
