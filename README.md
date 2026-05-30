# tradie-template

Static site template for tradie businesses, built with Eleventy and deployed on Vercel.

Content lives in `_data/*.json` and `blog/*.md` so it can be edited programmatically (e.g. via a future WhatsApp bot) without touching templates.

## Structure

```
_data/        site.json, services.json, gallery.json, testimonials.json, faq.json
_includes/    base.njk (layout), post.njk (blog post layout)
blog/         markdown posts
assets/       css, images, gallery photos
*.njk         page templates (one per top-level page)
```

## Local dev

```bash
npm install
npm run dev      # http://localhost:8080 with live reload
npm run build    # outputs to _site/
```

## Editing content

- **Site-wide** (phone, address, hours): `_data/site.json`
- **Services**: `_data/services.json` (array — slug + title + summary + details)
- **Gallery**: `_data/gallery.json` (array — image path + caption + category)
- **Testimonials**: `_data/testimonials.json`
- **FAQ**: `_data/faq.json`
- **Blog**: drop a markdown file in `blog/` with frontmatter (`title`, `date`, `summary`)

## Deploying

Vercel auto-detects Eleventy. Build command: `npm run build`, output directory: `_site`.
Site is configured `noindex` by default (see `vercel.json`) — remove that header before going public.

## WhatsApp bot + integrations

The Vercel function at `api/whatsapp.js` accepts inbound WhatsApp messages via Twilio,
classifies intent with Claude Haiku, and routes to site edits / blog posts / gallery
uploads / SEO commands. The weekly cron at `api/cron-weekly.js` runs Monday 9am Brisbane
and pushes GSC + Semrush snapshots to the configured WhatsApp number.

### Slash commands

- `/audit` — full SEO audit (technical + competitor + GSC)
- `/rankings` — Ahrefs Rank Tracker movers + top tracked keywords
- `/semrush` — Semrush domain snapshot + competitor overview
- `/semrush kw <phrase>` — Semrush keyword research (volume, CPC, related)

### Environment variables

| Var | Where used | Required for |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | classifier + editor | All WhatsApp bot ops |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | sending replies | All WhatsApp ops |
| `ALLOWED_PHONES` | sender allow-list | Webhook security |
| `GITHUB_REPO`, `GITHUB_TOKEN` | commit + PR flow | Site edits |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_SLUG`, `VERCEL_TEAM_ID` | preview URL discovery | Site edits |
| `AHREFS_API_TOKEN`, `AHREFS_PROJECT_DOMAIN`, `AHREFS_PROJECT_ID`, `AHREFS_COUNTRY` | Ahrefs lib | `/audit`, `/rankings` |
| `COMPETITORS` | competitor list (comma-separated) | `/audit`, `/semrush` |
| `GSC_SERVICE_ACCOUNT_JSON`, `GSC_SITE_URL` | Search Console | Weekly cron, `/audit` |
| `SEMRUSH_API_KEY` | Semrush Analytics API | `/semrush`, weekly cron |
| `SEMRUSH_DATABASE` | country DB (default `au`) | `/semrush` |
| `SEMRUSH_DOMAIN` | analysed domain (default `mrpaint.com.au`) | `/semrush` |
| `SEMRUSH_COMPETITORS` | optional override of `COMPETITORS` for Semrush | `/semrush` |
| `SEMRUSH_PROJECT_ID` | Semrush Position Tracking project | Future |
| `CRON_DIGEST_TO_PHONE` | destination for weekly digest (E.164) | Weekly cron |
| `CRON_SECRET` | Vercel auto-sets for cron auth | Weekly cron |
| `AUDIT_SITE_BASE` | base URL audited by `/audit` | `/audit` |

### Setting Semrush env vars on Vercel

```bash
vercel env add SEMRUSH_API_KEY production
vercel env add SEMRUSH_DATABASE production    # "au"
vercel env add SEMRUSH_DOMAIN production      # "mrpaint.com.au"
```

The Domain Analytics endpoints (used by `/semrush`) work as soon as the key is set.
Position Tracking + Site Audit need a Semrush *Project* configured in the Semrush UI
(add competitors + tracked keywords there) — wire `SEMRUSH_PROJECT_ID` later.
