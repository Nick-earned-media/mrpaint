// /admin terminal — conversational site editor for the client.
//
// POST { messages: [{role, content}...], draft: {branch}|null }
//   → { reply, actions: [string], draft: {branch}|null }
//
// Auth: mp_admin session cookie (see api/admin/auth.js). The browser keeps
// conversation history + the active draft branch in localStorage and sends
// both with every request; this endpoint is stateless.
//
// All mutations follow the same preview→approve flow as the WhatsApp bot,
// but on admin/* branches (bot/* is reserved for WhatsApp so a stray "YES"
// over there can never merge a terminal draft):
//   edit/create tools commit to one admin/<ts> draft branch per session
//   → preview_changes polls Vercel for the branch preview URL
//   → publish_changes merges to main / discard_changes deletes the branch.
//
// Guardrails: the model only gets surgical tools over whitelisted content
// paths (root content .njk pages, _data/*.json, blog/*.md). Layouts, config,
// api/, lib/ and css are not reachable, so structural changes are impossible
// by construction — not just by prompt.

const { ghJson, ghGetContents, ghCommitMulti, findVercelPreviewUrl, GITHUB_REPO } = require("../../lib/github-bot.js");
const { isAuthed } = require("../../lib/admin-session.js");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";
const SITE_URL = process.env.PUBLIC_BASE_URL || "https://mrpaint.com.au";
const MAX_TOOL_ITERATIONS = 8;
const MAX_HISTORY = 30;

// ─── path guardrails ──────────────────────────────────────────────────────

const PROTECTED_ROOT_PAGES = new Set(["sitemap.njk", "admin.njk"]);

function isEditablePath(p) {
  if (typeof p !== "string" || p.includes("..")) return false;
  if (/^blog\/[a-z0-9][a-z0-9-]*\.md$/.test(p)) return true;
  if (/^_data\/[a-z0-9_][a-z0-9_-]*\.json$/.test(p)) return true;
  if (/^[a-z0-9][a-z0-9-]*\.njk$/.test(p) && !PROTECTED_ROOT_PAGES.has(p)) return true;
  return false;
}

function isReadablePath(p) {
  if (isEditablePath(p)) return true;
  // Layouts are readable for context but never writable.
  return typeof p === "string" && !p.includes("..") && /^_includes\/[a-z0-9_-]+\.njk$/.test(p);
}

function slugify(s) {
  return String(s).toLowerCase().replace(/['"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

// ─── system prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the website editor terminal for MrPaint (mrpaint.com.au), a painting business in Cairns run by Adrian. You're talking to Adrian or his team via a command-line interface on the site's /admin page.

Your job: edit website content and create new pages when asked. You have tools that read files, make surgical edits, and create pages from the site's existing templates.

HOW THE SITE WORKS
- It's a static site. Content lives in three places:
  - Page files: index.njk (homepage), about.njk, contact.njk, gallery.njk, painter-cairns.njk, commercial-painter-cairns.njk, industrial-painting.njk, blog.njk — HTML with template tags.
  - Data files (_data/*.json): site.json (phone, email, address, hours, socials), faq.json, testimonials.json, services_trio.json, trust_marquee.json, gallery.json, locations.json (one entry per suburb page under /areas/), cairns_recent_jobs.json.
  - Blog posts: blog/*.md markdown files.
- Suburb/area pages are generated automatically from locations.json entries — to add a suburb page, add an entry (create_area_page tool), never a new file.

WORKFLOW (always follow this)
1. Changes are NEVER live immediately. Every edit/create commits to a draft. After making changes, tell the user what you changed and that they can type "preview" to see it or "publish" to push it live.
2. "preview" → preview_changes tool (takes up to a minute to build). Give them the link.
3. "publish" / "approve" / "yes push it live" → publish_changes tool.
4. "discard" / "scrap it" → discard_changes tool.
5. Multiple edits before publishing is fine — they accumulate on the same draft.

RULES
- Content only. You may change text, prices, FAQs, testimonials, business details, photos' captions, blog posts, and create new pages from existing templates. You must NOT restructure the site: no changes to layout files, navigation structure, CSS/styling, or config — politely decline and suggest they ask Nick at Earned Media for structural work.
- Before editing, read the file first so your old_string matches exactly.
- Keep the site's voice: plain-spoken Aussie tradie-friendly English, no marketing fluff, no exclamation-mark overload. Match the tone of existing copy.
- For blog posts: practical, helpful, 300-600 words unless asked otherwise, written for Cairns homeowners.
- For new service pages: follow the same structure and tone as commercial-painter-cairns.njk (read it first as a reference). Sections wrapped in <section class="..."><div class="wrap">...</div></section>.
- Photos can't be uploaded here — tell them to WhatsApp photos to the bot like they already do.
- If a request is ambiguous, ask one short clarifying question rather than guessing.

STYLE
- This is a terminal: be brief. Short sentences, no headers, no bullet-point essays. One or two lines for confirmations.
- Australian English (colour, organise).
- Never show file diffs, JSON or code unless asked — describe changes in plain words ("Updated the homepage hero to mention free quotes").`;

// ─── tools ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_site_files",
    description: "List all editable files on the site: pages, data files, blog posts, and the suburbs that have area pages.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read the current content of a file (from the draft if one is active, otherwise the live site). Always read before editing.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative path, e.g. index.njk, _data/faq.json, blog/my-post.md" } },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description: "Make a surgical text replacement in an editable file. old_string must be copied EXACTLY from the file (read_file first) and must appear exactly once. Commits to the draft.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact existing text to replace — verbatim, must be unique in the file" },
        new_string: { type: "string", description: "Replacement text" },
        summary: { type: "string", description: "One short line describing the change, used as the commit message" },
      },
      required: ["path", "old_string", "new_string", "summary"],
    },
  },
  {
    name: "create_blog_post",
    description: "Create a new blog post at /blog/<slug>/. Commits to the draft.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body_markdown: { type: "string", description: "Post body in markdown, no H1 (title renders separately)" },
        summary: { type: "string", description: "1-sentence summary for the blog index" },
      },
      required: ["title", "body_markdown"],
    },
  },
  {
    name: "create_area_page",
    description: "Create a new suburb/area page at /areas/<slug>/ by adding an entry to locations.json — the page generates from the existing area template. Commits to the draft.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Suburb name, e.g. 'Smithfield'" },
        postcode: { type: "string" },
        intro: { type: "string", description: "2-3 sentence intro about painting work in this suburb, matching the tone of existing entries" },
        common_jobs: { type: "string", description: "1-2 sentences listing typical jobs there" },
        lat: { type: "number" },
        lng: { type: "number" },
      },
      required: ["name", "postcode", "intro", "common_jobs"],
    },
  },
  {
    name: "create_service_page",
    description: "Create a new service page at /<slug>/ using the site's base layout, e.g. roof-painting-cairns. Read commercial-painter-cairns.njk first and follow its section structure and tone. Commits to the draft.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "URL slug, lowercase with hyphens, e.g. roof-painting-cairns" },
        title: { type: "string", description: "Page <title>, e.g. 'Roof Painting Cairns — Free Quotes'" },
        description: { type: "string", description: "Meta description, ~150 chars" },
        body_html: { type: "string", description: "Page body HTML using the same section/wrap classes as existing service pages. May reference {{ site.* }} values." },
      },
      required: ["slug", "title", "description", "body_html"],
    },
  },
  {
    name: "preview_changes",
    description: "Get a preview URL for the current draft. Takes up to ~90 seconds while the preview builds.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "publish_changes",
    description: "Push the current draft live (merge to main). Only call when the user clearly asks to publish/approve.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "discard_changes",
    description: "Throw away the current draft without publishing. Only call when the user clearly asks to discard.",
    input_schema: { type: "object", properties: {} },
  },
];

// ─── tool implementations ─────────────────────────────────────────────────

function makeToolContext() {
  // Mutable per-request state shared by the tool implementations.
  return { draft: null, actions: [] };
}

async function readRepoFile(path, ref) {
  const f = await ghGetContents(path, ref);
  return Buffer.from(f.content, "base64").toString("utf-8");
}

async function fileExists(path, ref) {
  try { await ghGetContents(path, ref); return true; }
  catch { return false; }
}

async function commitToDraft(ctx, { path, content, message }) {
  if (!ctx.draft) {
    ctx.draft = { branch: `admin/${Date.now()}-terminal`, sha: null };
  }
  const baseRef = ctx.draft.sha ? ctx.draft.branch : "main";
  const sha = await ghCommitMulti({
    branch: ctx.draft.branch,
    baseRef,
    message: `Admin terminal: ${message}`,
    files: [{ path, content }],
  });
  ctx.draft.sha = sha;
  return sha;
}

function draftRef(ctx) {
  return ctx.draft?.sha ? ctx.draft.branch : "main";
}

async function runTool(name, input, ctx) {
  switch (name) {
    case "list_site_files": {
      const ref = draftRef(ctx);
      const branch = await ghJson("GET", `/repos/${GITHUB_REPO}/branches/${encodeURIComponent(ref)}`);
      const tree = await ghJson("GET", `/repos/${GITHUB_REPO}/git/trees/${branch.commit.sha}?recursive=1`);
      const paths = tree.tree.filter((t) => t.type === "blob").map((t) => t.path);
      const pages = paths.filter((p) => /^[a-z0-9-]+\.njk$/.test(p) && !PROTECTED_ROOT_PAGES.has(p));
      const data = paths.filter((p) => /^_data\/.+\.json$/.test(p));
      const blog = paths.filter((p) => /^blog\/.+\.md$/.test(p));
      let areas = [];
      try {
        const locations = JSON.parse(await readRepoFile("_data/locations.json", ref));
        areas = locations.map((l) => `${l.name} (/areas/${l.slug}/)`);
      } catch {}
      return { pages, data_files: data, blog_posts: blog, area_pages: areas };
    }

    case "read_file": {
      const { path } = input;
      if (!isReadablePath(path)) return { error: `Not readable: ${path}. Only site content files can be read.` };
      try {
        return { path, content: await readRepoFile(path, draftRef(ctx)) };
      } catch {
        return { error: `File not found: ${path}` };
      }
    }

    case "edit_file": {
      const { path, old_string, new_string, summary } = input;
      if (!isEditablePath(path)) return { error: `Not editable: ${path}. Content files only — layouts, styling and config are off limits.` };
      let content;
      try { content = await readRepoFile(path, draftRef(ctx)); }
      catch { return { error: `File not found: ${path}` }; }
      const count = content.split(old_string).length - 1;
      if (count === 0) return { error: "old_string not found in file — read the file again and copy the text exactly." };
      if (count > 1) return { error: `old_string appears ${count} times — include more surrounding context so it's unique.` };
      if (path.endsWith(".json")) {
        const updated = content.replace(old_string, new_string);
        try { JSON.parse(updated); }
        catch (e) { return { error: `That edit would break the JSON file (${e.message}). Adjust the replacement.` }; }
      }
      const updated = content.replace(old_string, new_string);
      await commitToDraft(ctx, { path, content: updated, message: summary || `edit ${path}` });
      ctx.actions.push(`✏️ ${summary || `edited ${path}`}`);
      return { ok: true, path, draft_branch: ctx.draft.branch };
    }

    case "create_blog_post": {
      const { title, body_markdown } = input;
      if (!title || !body_markdown) return { error: "Need both title and body_markdown." };
      const postSlug = slugify(title);
      const path = `blog/${postSlug}.md`;
      if (await fileExists(path, draftRef(ctx))) return { error: `A post with that slug already exists (${path}). Pick a different title.` };
      const today = new Date().toISOString().slice(0, 10);
      const summary = input.summary || body_markdown.split("\n").find((l) => l.trim().length > 40)?.slice(0, 180) || "";
      const md = `---\ntitle: ${yamlQuote(title)}\ndate: ${today}\nsummary: ${yamlQuote(summary)}\n---\n\n${body_markdown}\n`;
      await commitToDraft(ctx, { path, content: md, message: `add blog post "${title.slice(0, 60)}"` });
      ctx.actions.push(`📝 drafted blog post "${title}"`);
      return { ok: true, path, url_when_live: `/blog/${postSlug}/`, draft_branch: ctx.draft.branch };
    }

    case "create_area_page": {
      const { name, postcode, intro, common_jobs, lat, lng } = input;
      const areaSlug = slugify(name);
      const ref = draftRef(ctx);
      let locations;
      try { locations = JSON.parse(await readRepoFile("_data/locations.json", ref)); }
      catch (e) { return { error: `Couldn't load locations.json: ${e.message}` }; }
      if (locations.some((l) => l.slug === areaSlug)) return { error: `An area page for ${name} already exists (/areas/${areaSlug}/).` };
      locations.push({
        name, slug: areaSlug, highlighted: false, publish: true,
        postcode: String(postcode),
        lat: typeof lat === "number" ? lat : null,
        lng: typeof lng === "number" ? lng : null,
        intro, common_jobs, recent_jobs: [],
      });
      await commitToDraft(ctx, {
        path: "_data/locations.json",
        content: JSON.stringify(locations, null, 2) + "\n",
        message: `add area page for ${name}`,
      });
      ctx.actions.push(`📍 created area page for ${name}`);
      return { ok: true, url_when_live: `/areas/${areaSlug}/`, draft_branch: ctx.draft.branch };
    }

    case "create_service_page": {
      const { slug: rawSlug, title, description, body_html } = input;
      const pageSlug = slugify(rawSlug);
      if (!pageSlug) return { error: "Invalid slug." };
      const path = `${pageSlug}.njk`;
      if (!isEditablePath(path)) return { error: `Can't create ${path}.` };
      if (await fileExists(path, draftRef(ctx))) return { error: `${path} already exists — edit it instead.` };
      const frontmatter = [
        "---",
        "layout: base.njk",
        `title: ${yamlQuote(title)}`,
        `description: ${yamlQuote(description)}`,
        `permalink: /${pageSlug}/`,
        `canonical: /${pageSlug}/`,
        "---",
      ].join("\n");
      await commitToDraft(ctx, { path, content: `${frontmatter}\n\n${body_html}\n`, message: `add service page /${pageSlug}/` });
      ctx.actions.push(`📄 created service page /${pageSlug}/`);
      return { ok: true, path, url_when_live: `/${pageSlug}/`, draft_branch: ctx.draft.branch };
    }

    case "preview_changes": {
      if (!ctx.draft?.sha) return { error: "No draft changes yet — make an edit first." };
      ctx.actions.push("👁 building preview…");
      try {
        const url = await findVercelPreviewUrl({ commitSha: ctx.draft.sha });
        if (!url) return { error: "Preview build timed out — try 'preview' again in a minute." };
        ctx.actions.push(`👁 preview ready: ${url}`);
        return { preview_url: url };
      } catch (e) {
        return { error: `Preview build failed: ${e.message}` };
      }
    }

    case "publish_changes": {
      if (!ctx.draft?.branch) return { error: "No draft to publish — make an edit first." };
      const branch = ctx.draft.branch;
      try {
        await ghJson("POST", `/repos/${GITHUB_REPO}/merges`, {
          base: "main", head: branch, commit_message: `Admin terminal: merge ${branch}`,
        });
      } catch (err) {
        const msg = String(err?.message || err);
        if (/409|merge conflict/i.test(msg)) {
          await deleteBranch(branch).catch(() => {});
          ctx.draft = null;
          return { error: "The site changed since this draft was made and it no longer merges cleanly. Draft scrapped — please redo the change." };
        }
        return { error: `Publish failed: ${msg.slice(0, 200)}. Draft is untouched — try again.` };
      }
      await deleteBranch(branch).catch(() => {});
      ctx.draft = null;
      ctx.actions.push("🚀 published to live site");
      return { ok: true, live_url: SITE_URL, note: "Live in ~60 seconds once the build finishes." };
    }

    case "discard_changes": {
      if (!ctx.draft?.branch) return { error: "No draft to discard." };
      await deleteBranch(ctx.draft.branch).catch(() => {});
      ctx.draft = null;
      ctx.actions.push("🗑 draft discarded");
      return { ok: true };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function deleteBranch(branch) {
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mrpaint-bot",
    },
  });
  if (!r.ok && r.status !== 422) throw new Error(`Delete branch ${branch} → ${r.status}`);
}

// ─── Anthropic loop ───────────────────────────────────────────────────────

async function callClaude(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

// ─── handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isAuthed(req)) {
    return res.status(401).json({ error: "Not logged in" });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }

  const history = Array.isArray(body.messages) ? body.messages : [];
  const messages = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "Last message must be from the user" });
  }

  const ctx = makeToolContext();
  if (body.draft?.branch && /^admin\/\d+-[a-z0-9-]+$/.test(body.draft.branch)) {
    // Resume an existing draft only if its branch still exists on GitHub.
    try {
      const b = await ghJson("GET", `/repos/${GITHUB_REPO}/branches/${encodeURIComponent(body.draft.branch)}`);
      ctx.draft = { branch: body.draft.branch, sha: b.commit.sha };
    } catch { ctx.draft = null; }
  }

  try {
    let response = await callClaude(messages);

    for (let i = 0; i < MAX_TOOL_ITERATIONS && response.stop_reason === "tool_use"; i++) {
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const results = [];
      for (const tu of toolUses) {
        let result;
        try { result = await runTool(tu.name, tu.input || {}, ctx); }
        catch (err) { result = { error: String(err?.message || err).slice(0, 400) }; }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: results });
      response = await callClaude(messages);
    }

    const reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim()
      || "(done — anything else?)";

    return res.status(200).json({
      reply,
      actions: ctx.actions,
      draft: ctx.draft?.sha ? { branch: ctx.draft.branch } : null,
    });
  } catch (err) {
    console.error("admin terminal error:", err);
    return res.status(500).json({
      error: "Something went wrong on my end — try that again.",
      detail: String(err?.message || err).slice(0, 300),
      actions: ctx.actions,
      draft: ctx.draft?.sha ? { branch: ctx.draft.branch } : null,
    });
  }
};

module.exports.config = {
  maxDuration: 300,
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}
