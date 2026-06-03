// Job → suburb-page entry + GBP draft generator.
//
// Takes a captured job (from the `jobs` Supabase table) plus suburb context
// (from _data/locations.json), and produces:
//   - title          (suburb-page entry H3, mentions suburb + job type)
//   - body           (180-350 words, conversational tradie voice, mentions
//                     specific details from the job, soft internal link)
//   - photo_alt      (short alt text — used only if a photo gets attached
//                     later via the gallery flow)
//   - gbp_text       (300-char GBP-friendly post — hook + outcome + CTA)
//
// Both drafts come from one Sonnet call so they share specifics and voice.

const SONNET_MODEL = "claude-sonnet-4-5";

const SYSTEM_PROMPT = `You are writing on behalf of Adrian Tucci at MrPaint — a Cairns painter. Two drafts, one for his website's suburb page, one for his Google Business Profile.

VOICE:
- Plain tradie English. Short sentences. Contractions always.
- No marketing-speak. No "we pride ourselves". No "leverage", "premium quality", "transform". No emojis in the body.
- Specific over generic. If the job mentions a specific paint, suburb feature, or finish, use it.
- "boss", "chief", "mate" are NOT in written content — that's spoken voice only. Write neutrally.

TWO OUTPUTS:

1. **Suburb-page entry** — for /areas/[suburb]/ on the website
   - title: 6-10 words. Format like "Exterior repaint, [Suburb] [postcode area if relevant]" or "Full repaint on a [house style] in [Suburb]". Specific job type + location.
   - body: 180-350 words. Open with the job in one sentence. Then a paragraph on what was involved (prep, products, finish, anything notable). Close with one short paragraph linking the work to what makes that suburb's housing stock distinctive (use the provided suburb context). No CTA — the page already has those.
   - photo_alt: 8-15 words. "Freshly repainted weatherboard exterior in Trinity Beach, Cairns" — describe the visible job.

2. **GBP draft** — for Google Business Profile post
   - 250-300 characters max (HARD limit — Google truncates after 300).
   - Open with what got done (hook). One line on the result. End with a soft CTA like "Free quote — call us" or "Want one like this? Get in touch."
   - One line per sentence-fragment. Use double newlines between hook / outcome / CTA.

VOICE REINFORCEMENT:
- Adrian's been painting in Cairns since 2014. He's based in Holloways Beach. He's not selling — he's telling you about a job.
- Don't say "the team" or "our experts". Use "we" or "I" naturally.
- Don't oversell. If a job was "a standard interior repaint", say that.

REPLY WITH VALID JSON ONLY (no prose, no code fences):
{
  "title": "...",
  "body": "...",
  "photo_alt": "...",
  "gbp_text": "..."
}`;

async function generateJobContent({ job, suburbCtx }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing — can't generate job content");

  const input = {
    job: {
      suburb: job.suburb,
      summary: job.summary,
      raw_transcript: job.raw_transcript || null,
      structured_facts: job.structured_facts || {},
    },
    suburb_context: {
      name: suburbCtx.name,
      slug: suburbCtx.slug,
      postcode: suburbCtx.postcode,
      intro: suburbCtx.intro,
      common_jobs: suburbCtx.common_jobs,
      recent_jobs_count: (suburbCtx.recent_jobs || []).length,
    },
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Generate the two drafts for this job:\n\n${JSON.stringify(input, null, 2)}` }],
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Anthropic ${r.status}: ${detail.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data.content?.[0]?.text || "";

  // Strip code fences if present, then parse.
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Try to recover a JSON object from anywhere in the response.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Couldn't parse Sonnet response as JSON: ${text.slice(0, 200)}`);
    parsed = JSON.parse(m[0]);
  }

  return {
    title:     String(parsed.title || "").trim(),
    body:      String(parsed.body || "").trim(),
    photo_alt: String(parsed.photo_alt || "").trim(),
    gbp_text:  String(parsed.gbp_text || "").trim(),
  };
}

module.exports = {
  generateJobContent,
};
