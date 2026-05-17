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
