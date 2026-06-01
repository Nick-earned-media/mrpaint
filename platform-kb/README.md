# Platform Knowledge Base — Source Content

This directory holds the **platform-wide marketing knowledge** the conversational strategist retrieves from. Every client benefits from the same body of curated content.

When the EMintel platform proper is built, this directory moves there. For now it lives in `~/mrpaint/platform-kb/` so the bot has something to retrieve from while we validate the conversational architecture with Adrian.

## How content gets into Sonnet's context

1. User asks a question over WhatsApp
2. Question gets embedded → similarity search across `platform_kb` chunks
3. Top 3–5 most relevant chunks injected into the system prompt
4. Sonnet generates response grounded in those chunks (no hallucination, real frameworks)

## Adding new content

Each `.md` file should start with frontmatter:

```yaml
---
source: semrush               # publisher / brand
source_url: https://...       # original URL for citation
topic: local-seo              # tag — local-seo, gbp, reviews, geo, content, links
audience: tradies             # tradies | enterprise | both
fetched_at: 2026-05-31
quality: high                 # high | medium | low (low = filler, deprioritize)
---

# Article title

Body content in markdown...
```

Then run the (forthcoming) embedding script: each H2/H3 section becomes one chunk in `platform_kb`. ~1500 tokens per chunk is the sweet spot.

## Initial sources (2026-05-31)

| File | Topic | Source |
|---|---|---|
| `local-seo-semrush.md` | Local SEO fundamentals | semrush.com |
| `local-seo-backlinko.md` | Local SEO definitive guide | backlinko.com |
| `local-seo-searchengineland.md` | Local SEO algorithm + factors | searchengineland.com |
| `gbp-semrush.md` | Google Business Profile optimisation | semrush.com |
| `google-reviews-semrush.md` | Getting more Google reviews | semrush.com |
| `google-reviews-square-au.md` | Getting Google reviews — AU context, tradie-friendly | squareup.com/au |
| `geo-2026-searchengineland.md` | Generative Engine Optimisation 2026 | searchengineland.com |
| `geo-vs-seo-earnedmedia.md` | Is GEO the new SEO | earnedmedia.com.au |
| `ai-seo-geo-earnedmedia.md` | Complete guide to GEO + AI SEO | earnedmedia.com.au |
