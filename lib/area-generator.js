// Suburb-page generator. Takes a suburb name + Adrian's discovery transcript
// and asks Sonnet to produce:
//   - njk_content      : the full Eleventy template (modelled on painter-trinity-beach.njk)
//   - preview_html_body: the rendered body for /api/preview (no layout chrome)
//   - title, suburb_slug, njk_filename
//
// The system prompt embeds the Trinity Beach template as the structural
// reference. Sonnet adapts it for the new suburb, weaving in the answers
// from the transcript and the keyword targets.

const SONNET_MODEL = "claude-sonnet-4-5";

const SYSTEM_PROMPT = `You are generating a service-area page for MrPaint (Adrian Tucci), a Cairns-region painter, for a specific Cairns suburb. You're modelling on this proven template structure:

\`\`\`
---
layout: base.njk
title: Painter {Suburb} — Local Cairns Northern Beaches Painters
description: Trade-qualified painters in {Suburb} ({postcode}). [specific service mix]. Free quote — 0478 659 766.
permalink: /painter-{slug}/
canonical: /painter-{slug}/
---

<section class="hero">...HERO with H1 "Painter {Suburb}"...</section>
<div class="phone-band">...phone CTA band...</div>

<section class="copy-block">
  <h2>What painting in {Suburb} actually involves</h2>
  <p>...local context: where the suburb is, housing stock, specific local conditions...</p>
  <p>Here's what we see on nearly every {Suburb} repaint:</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:20px">
    <div style="background:#fff;border:1px solid var(--rule);border-radius:12px;padding:20px">
      <h3 style="margin:0 0 8px;font-size:17px;color:var(--ink);font-weight:700">{Issue 1}</h3>
      <p style="margin:0;color:var(--ink-2);line-height:1.55">{plain explanation}</p>
    </div>
    {2-4 more local-issue cards}
  </div>
  <p style="margin-top:24px">{repaint cycle + paint systems used + 'we don't cut corners on prep' line}</p>
</section>

<section class="copy-block">
  <h2>What we paint in {Suburb}</h2>
  <p>{intro}</p>
  <h3 class="subhead">Exterior repaints</h3><p>{details}</p>
  <h3 class="subhead">Eaves, soffits, fascia</h3><p>{details}</p>
  <h3 class="subhead">Interior repaints</h3><p>{details}</p>
  {2-3 more service H3s relevant to this suburb}
</section>

<section class="copy-block" style="background:var(--bg-soft)">
  <h2>Local, properly trained, and you're not paying for a salesman</h2>
  <p>{credibility paragraph mentioning Adrian, founded 2014, local}</p>
  <ul class="dot-list">
    <li>Trade-qualified, fully insured, QBCC-licensed</li>
    {5-6 trust bullets}
  </ul>
</section>

<section style="background:#fff;padding:clamp(48px,6vw,80px) 0">
  <div class="wrap text-center">
    {final CTA + neighbouring suburb chips linking out}
  </div>
</section>

<section class="faq-block">
  <h2>Painting in {Suburb} — FAQs</h2>
  <div class="faq-list">
    <details open><summary>{Q1}</summary><div>{A1}</div></details>
    {5 more FAQs}
  </div>
</section>

{LocalBusiness JSON-LD with areaServed = {Suburb}}
{BreadcrumbList JSON-LD}
{FAQPage JSON-LD}
\`\`\`

VOICE RULES (locked):
- Plain tradie English. Short sentences. Contractions always.
- NO marketing-speak ("transform", "premium", "leverage", "pride ourselves", "second to none", "we pride").
- Specific over generic. If the transcript mentions a paint product (Dulux Weathershield, Sikkens, Solver), use it.
- "boss" / "chief" / "mate" do NOT appear in written content — those are spoken-only.
- E-E-A-T signals: mention Adrian (the owner-operator), founding year (2014), local base (Holloways Beach), QBCC licence, free fixed-price quote.

OUTPUT FORMAT — reply with VALID JSON ONLY (no prose, no code fences):
{
  "suburb_slug": "{kebab-case slug, e.g. 'bungalow' or 'edge-hill'}",
  "title": "{<60 chars page title for the <title> tag}",
  "description": "{<160 chars meta description}",
  "njk_filename": "painter-{suburb_slug}.njk",
  "njk_content": "{the full Eleventy template file, frontmatter + body + JSON-LD scripts. PRESERVE all Nunjucks expressions like {{ site.phone_link }}, {{ site.phone_display }}, {{ site.founded }}, {{ site.url }}, {{ site.address.* }}. ESCAPE properly inside JSON.}",
  "preview_html_body": "{the rendered body content as PLAIN HTML — Nunjucks expressions REPLACED with their literal values (phone 0478 659 766, founded 2014, base Holloways Beach, etc.). This is what /api/preview shows.}"
}

GUIDANCE:
- Pull as much suburb-specific detail from the transcript as you can — housing stock, paint problems, jobs done, landmarks, customer types. Don't invent details that aren't there; if a topic is light, write less rather than padding.
- If the transcript mentions specific job examples, weave them into the "Why MrPaint" or services sections naturally.
- The FAQs should be 4-6 questions specific to that suburb (not generic Cairns FAQs).
- Cross-link to 2-3 nearby suburbs from the suburb chips section + back to /painter-cairns/.
- Always include LocalBusiness JSON-LD with areaServed matching the suburb. Estimate postcode + geo from the suburb name; if you can't, omit the postal code and geo blocks rather than guess wrong.
- Do not include image references — images get added separately. Leave the hero area copy-only or use a placeholder note.`;

async function generateAreaPage({ suburb, transcript }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

  const userInput = `Suburb: ${suburb}\n\nAdrian's discovery transcript:\n\n${transcript}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userInput }],
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Sonnet ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  const raw = data.content?.[0]?.text || "";
  const parsed = extractJson(raw);

  for (const k of ["suburb_slug", "title", "njk_filename", "njk_content", "preview_html_body"]) {
    if (!parsed[k]) throw new Error(`generateAreaPage: missing ${k} in Sonnet output`);
  }
  return parsed;
}

function extractJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const fenced = t.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i !== -1 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error("no parseable JSON in Sonnet response");
}

module.exports = { generateAreaPage };
