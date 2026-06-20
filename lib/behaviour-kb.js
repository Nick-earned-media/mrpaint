// Behaviour event capture — turns operator actions into searchable knowledge.
//
// Each function in here is fire-and-forget. They never throw, never block
// the caller. If the embedding API or Supabase write fails we log a warning
// and move on — the user-facing flow must not pay the cost of a slow KB
// write or a missing embedding.
//
// Source types:
//   behaviour:job_published       — operator approved a draft, it went live
//   behaviour:job_rejected        — operator binned a draft
//   behaviour:question_answered   — operator asked the strategist something
//                                    and got a useful reply
//
// The bot retrieves these via searchClientKb() the same way it retrieves
// any other knowledge chunk. Over time the bot starts noticing patterns
// like "Adrian binned the last three drafts that mentioned a specific
// brand" or "questions about pricing strategy come up roughly weekly".

const { client: supa, embed } = require("./supabase.js");

async function recordEvent(clientId, sourceType, sourceId, chunkText, metadata) {
  if (!clientId || !chunkText) return;
  try {
    const embedding = await embed(chunkText);
    const { error } = await supa().from("kb_chunks").insert({
      client_id: clientId,
      source_type: sourceType,
      source_id: sourceId,
      source_date: new Date().toISOString(),
      chunk_text: chunkText,
      embedding,
      metadata: metadata || {},
    });
    if (error) console.warn(`[behaviour-kb] ${sourceType} insert failed:`, error.message);
  } catch (err) {
    console.warn(`[behaviour-kb] ${sourceType} failed:`, err.message);
  }
}

// ─── Job published ────────────────────────────────────────────────────────

async function recordJobPublished({ clientId, jobId, jobTitle, suburb, jobType, products, pagePath, pageUrl, mediaType }) {
  if (!clientId) return;
  const productsStr = Array.isArray(products) && products.length ? products.join(", ") : null;
  const today = new Date().toISOString().slice(0, 10);

  const parts = [
    jobTitle ? `Published a job titled "${jobTitle}".` : "Published a job.",
    suburb ? `Location: ${suburb}.` : null,
    jobType ? `Job type: ${jobType}.` : null,
    productsStr ? `Products used: ${productsStr}.` : null,
    pagePath || pageUrl ? `Posted on ${pagePath || pageUrl}.` : null,
    mediaType ? `Primary media: ${mediaType}.` : null,
    `Approved by operator on ${today}.`,
  ].filter(Boolean);

  await recordEvent(
    clientId,
    "behaviour:job_published",
    `behaviour:job_published:${jobId || `${today}-${Math.random().toString(36).slice(2, 8)}`}`,
    parts.join(" "),
    { job_id: jobId, suburb, job_type: jobType, products, page_path: pagePath, page_url: pageUrl, media_type: mediaType, event_date: today },
  );
}

// ─── Job rejected ─────────────────────────────────────────────────────────

async function recordJobRejected({ clientId, jobId, jobTitle, suburb, jobType, products }) {
  if (!clientId) return;
  const productsStr = Array.isArray(products) && products.length ? products.join(", ") : null;
  const today = new Date().toISOString().slice(0, 10);

  const parts = [
    jobTitle ? `Discarded a draft titled "${jobTitle}".` : "Discarded a draft.",
    suburb ? `Location: ${suburb}.` : null,
    jobType ? `Job type: ${jobType}.` : null,
    productsStr ? `Mentioned products: ${productsStr}.` : null,
    `Rejected by operator on ${today}.`,
  ].filter(Boolean);

  await recordEvent(
    clientId,
    "behaviour:job_rejected",
    `behaviour:job_rejected:${jobId || `${today}-${Math.random().toString(36).slice(2, 8)}`}`,
    parts.join(" "),
    { job_id: jobId, suburb, job_type: jobType, products, event_date: today },
  );
}

// ─── Question answered ────────────────────────────────────────────────────

async function recordQuestionAnswered({ clientId, threadId, question, answer }) {
  if (!clientId) return;
  const q = String(question || "").trim().slice(0, 600);
  const a = String(answer || "").trim().slice(0, 1200);
  if (!q || !a) return;
  if (q.length < 5) return; // skip "yes", "ok", "thanks" etc.

  const today = new Date().toISOString().slice(0, 10);
  const chunk =
    `Operator asked the strategist: "${q}"\n\n` +
    `Strategist's answer: "${a}"\n\n` +
    `Date: ${today}.`;

  await recordEvent(
    clientId,
    "behaviour:question_answered",
    `behaviour:question:${threadId || today}:${Date.now()}`,
    chunk,
    { thread_id: threadId, question: q, answer: a, event_date: today },
  );
}

module.exports = { recordJobPublished, recordJobRejected, recordQuestionAnswered };
