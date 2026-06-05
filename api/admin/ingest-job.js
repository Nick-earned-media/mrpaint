// Out-of-band job ingestion endpoint.
//
// Same pipeline as the WhatsApp executeAddPhotoJob handler, but driven by a
// direct multipart upload instead of a Twilio webhook. Built so we can ingest
// jobs that arrived outside WhatsApp (e.g. files Nick downloaded directly,
// jobs Adrian shared via SMS/AirDrop, batch backfills).
//
// Auth: Bearer token in Authorization header, compared against INGEST_TOKEN.
//
// Body (multipart/form-data):
//   - video    (file, required)  the job media — mp4/mov/webm
//   - audio    (file, optional)  voice note describing the job; Whisper
//                                transcribes it into the caption
//   - caption  (text,  optional) explicit caption override (skips Whisper)
//   - suburb_override (text, optional) force a specific suburb slug
//   - submitted_by    (text, optional) phone for Supabase client lookup;
//                                      defaults to env DEFAULT_BOT_PHONE
//
// Returns JSON with: transcript, classifier_output, generated_content,
// branch, sha, preview_url, and a hint that the existing WhatsApp YES flow
// (latest bot/* branch) will merge + fire the GBP Slack post.
//
// Bumped maxDuration to 300s — Whisper + Sonnet + GitHub + Vercel preview
// poll can take 60-120s total.

const Busboy = require("busboy");
const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  // ── 1. Auth ────────────────────────────────────────────────────────────
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: "INGEST_TOKEN not configured on server" });
  }
  const auth = req.headers["authorization"] || "";
  const presented = auth.replace(/^Bearer\s+/i, "").trim();
  if (!presented || !constantTimeEq(presented, expected)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // ── 2. Parse body — multipart OR JSON-with-URLs ────────────────────────
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  let fields = {};
  let video = null;
  let audio = null;

  if (contentType.includes("multipart/form-data")) {
    let parsed;
    try {
      parsed = await parseMultipart(req);
    } catch (err) {
      return res.status(400).json({ error: `multipart parse failed: ${err.message || err}` });
    }
    fields = parsed.fields;
    video = parsed.files.video;
    audio = parsed.files.audio;
  } else if (contentType.includes("application/json")) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return res.status(400).json({ error: `json parse failed: ${err.message || err}` });
    }
    fields = body || {};
    if (!body.video_url) {
      return res.status(400).json({ error: "video_url required when posting JSON" });
    }
    try {
      video = await fetchAsBuffer(body.video_url);
    } catch (err) {
      return res.status(400).json({ error: `video_url fetch failed: ${err.message || err}` });
    }
    if (!String(video.contentType || "").toLowerCase().startsWith("video/")) {
      // Trust the URL extension if the server didn't return a video/* content type.
      const guess = guessTypeFromUrl(body.video_url);
      if (guess) video.contentType = guess;
    }
    if (body.audio_url) {
      try {
        audio = await fetchAsBuffer(body.audio_url);
      } catch (err) {
        return res.status(400).json({ error: `audio_url fetch failed: ${err.message || err}` });
      }
    }
  } else {
    return res.status(415).json({
      error: `unsupported content-type "${contentType}" — use multipart/form-data or application/json`,
    });
  }

  if (!video) {
    return res.status(400).json({ error: "video is required (multipart field 'video' or JSON 'video_url')" });
  }
  if (!String(video.contentType || "").toLowerCase().startsWith("video/")) {
    return res.status(400).json({
      error: `video must be video/*; got ${video.contentType || "unknown"}`,
    });
  }

  // ── 3. Get caption (transcribe audio or use override) ──────────────────
  let caption = (fields.caption || "").trim();
  let transcript = null;
  if (!caption) {
    if (!audio) {
      return res.status(400).json({
        error: "no caption and no audio — provide one of: caption field, or audio file/url",
      });
    }
    const t = await transcribeAudioBuffer({
      buf: audio.buf,
      contentType: audio.contentType,
    });
    if (!t.ok) {
      return res.status(502).json({ error: `transcription failed: ${t.error}` });
    }
    transcript = t.text;
    caption = t.text;
  }

  // ── 4. Classify caption (Sonnet Haiku) ─────────────────────────────────
  let meta;
  try {
    meta = await callAnthropic({
      model: "claude-haiku-4-5",
      max_tokens: 700,
      system: PHOTO_JOB_CLASSIFIER_SYSTEM,
      user: caption,
      parseJson: true,
    });
  } catch (err) {
    return res.status(502).json({ error: `classifier failed: ${err.message || err}`, transcript });
  }

  // suburb_override = the PAGE the entry will go on. It doesn't overwrite
  // the detected job suburb — that's preserved as the "writing location" so
  // the generated title/body keep the actual neighbourhood mention.
  // Example: classifier detects Smithfield, override = Cairns CBD →
  // entry lives on /areas/cairns-cbd/ but title says "Smithfield, Cairns".
  let pageSearchTerm;
  if (fields.suburb_override) {
    if (!meta.is_job) { meta.is_job = true; meta.job = meta.job || {}; }
    pageSearchTerm = fields.suburb_override;
  } else {
    if (!meta.is_job || !meta.job?.suburb) {
      return res.status(400).json({
        error: "classifier did not detect a job with a known suburb. Provide a clearer caption or set suburb_override.",
        transcript, classifier_output: meta,
      });
    }
    pageSearchTerm = meta.job.suburb;
  }

  // ── 5. Match suburb against locations.json ─────────────────────────────
  const GITHUB_REPO = process.env.GITHUB_REPO;
  if (!GITHUB_REPO) return res.status(503).json({ error: "GITHUB_REPO not configured" });
  if (!process.env.GITHUB_TOKEN) return res.status(503).json({ error: "GITHUB_TOKEN not configured" });

  const locFile = await ghGetContents(GITHUB_REPO, "_data/locations.json", "main");
  const locations = JSON.parse(Buffer.from(locFile.content, "base64").toString("utf-8"));
  const norm = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "-");
  const wantedSlug = norm(pageSearchTerm);
  const suburbIdx = locations.findIndex(
    (l) => norm(l.name) === wantedSlug || norm(l.slug) === wantedSlug
  );
  if (suburbIdx === -1) {
    const knownSuburbs = locations.map((l) => l.name).join(", ");
    return res.status(400).json({
      error: `page "${pageSearchTerm}" doesn't match a known suburb on the site. Known: ${knownSuburbs}`,
      transcript, classifier_output: meta,
    });
  }
  const suburb = locations[suburbIdx];

  // Writing location: prefer the classifier's detected suburb (more specific
  // and what was actually said). When override sends the entry to a different
  // page, append ", Cairns" so Sonnet writes "Smithfield, Cairns" naturally.
  const detectedDifferent = meta.job?.suburb && norm(meta.job.suburb) !== norm(suburb.name);
  const writingLocation = detectedDifferent
    ? `${meta.job.suburb}, Cairns`
    : suburb.name;

  // ── 6. Generate suburb-page entry + GBP draft ──────────────────────────
  let jobContent;
  try {
    const { generateJobContent } = require("../../lib/job-publisher.js");
    jobContent = await generateJobContent({
      job: {
        suburb: writingLocation,
        summary: meta.job?.summary || `${meta.job?.job_type || "paint"} job in ${writingLocation}`,
        raw_transcript: caption,
        structured_facts: {
          job_type: meta.job?.job_type,
          brands_used: meta.job?.brands_used,
          architectural_style: meta.job?.architectural_style,
        },
      },
      suburbCtx: suburb,
    });
  } catch (err) {
    return res.status(502).json({
      error: `generateJobContent failed: ${err.message || err}`,
      transcript, classifier_output: meta,
    });
  }

  // ── 7. Commit binary + content JSON atomically ─────────────────────────
  //    target_page selects WHERE the entry lives:
  //      - default               → _data/locations.json[suburb].recent_jobs (suburb page)
  //      - "/painter-cairns/"    → _data/cairns_recent_jobs.json (the Cairns hub page)
  const ts = Date.now();
  const ext = pickVideoExt(video.contentType);
  const fileSlug = slugify(meta.job?.summary || jobContent.title || "video");
  const videoPath = `assets/videos/work-${fileSlug}-${ts}.${ext}`;
  const today = new Date().toISOString().slice(0, 10);
  const targetPage = String(fields.target_page || "").trim();

  const recentJobEntry = {
    date: today,
    title: jobContent.title,
    body: jobContent.body,
    photo_alt: jobContent.photo_alt,
    video: `/${videoPath}`,
  };

  let commitFiles;
  let commitContextLabel;
  if (targetPage === "/painter-cairns/") {
    let existing;
    try {
      const cf = await ghGetContents(GITHUB_REPO, "_data/cairns_recent_jobs.json", "main");
      existing = JSON.parse(Buffer.from(cf.content, "base64").toString("utf-8"));
    } catch { existing = []; }
    if (!Array.isArray(existing)) existing = [];
    const updated = [recentJobEntry, ...existing].slice(0, 12);
    commitFiles = [
      { path: videoPath, content: video.buf.toString("base64"), encoding: "base64" },
      { path: "_data/cairns_recent_jobs.json", content: JSON.stringify(updated, null, 2) + "\n", encoding: "utf-8" },
    ];
    commitContextLabel = "/painter-cairns/";
  } else {
    suburb.recent_jobs = [recentJobEntry, ...(Array.isArray(suburb.recent_jobs) ? suburb.recent_jobs : [])].slice(0, 6);
    locations[suburbIdx] = suburb;
    commitFiles = [
      { path: videoPath, content: video.buf.toString("base64"), encoding: "base64" },
      { path: "_data/locations.json", content: JSON.stringify(locations, null, 2) + "\n", encoding: "utf-8" },
    ];
    commitContextLabel = `/areas/${suburb.slug}/`;
  }

  const branchSlug = targetPage === "/painter-cairns/" ? "cairns-hub" : suburb.slug;
  const branch = `bot/${ts}-videojob-${branchSlug}`.slice(0, 200);
  let sha;
  try {
    sha = await ghCommitMulti({
      repo: GITHUB_REPO,
      branch, baseRef: "main",
      message: `Bot: add video job to ${commitContextLabel} (manual ingest)`,
      files: commitFiles,
    });
  } catch (err) {
    return res.status(502).json({
      error: `git commit failed: ${err.message || err}`,
      transcript, classifier_output: meta, generated_content: jobContent,
    });
  }

  // ── 8. Insert Supabase pending_approval row (best-effort) ──────────────
  const submittedBy = (fields.submitted_by || process.env.DEFAULT_BOT_PHONE || "").trim();
  let supabaseInserted = false;
  try {
    if (submittedBy) {
      const { client: supa } = require("../../lib/supabase.js");
      const phone = submittedBy.replace(/^whatsapp:/, "");
      const { data: client } = await supa()
        .from("clients").select("id, site_url").contains("allowed_phones", [phone]).maybeSingle();
      if (client?.id) {
        const liveMediaUrl = client.site_url
          ? `${client.site_url.replace(/\/$/, "")}/${videoPath}`
          : `https://mrpaint.vercel.app/${videoPath}`;
        const livePageUrl = client.site_url
          ? `${client.site_url.replace(/\/$/, "")}${commitContextLabel}`
          : `https://mrpaint.vercel.app${commitContextLabel}`;
        await supa()
          .from("jobs")
          .insert({
            client_id: client.id,
            captured_at: new Date().toISOString(),
            suburb: suburb.name,
            summary: meta.job?.summary,
            raw_transcript: caption,
            structured_facts: {
              job_type: meta.job?.job_type,
              brands_used: meta.job?.brands_used,
              architectural_style: meta.job?.architectural_style,
              video_url: `/${videoPath}`,
              pending_publish: {
                branch, sha,
                suburb_slug: suburb.slug,
                suburb_name: suburb.name,
                page_url: livePageUrl,
                gbp_text: jobContent.gbp_text,
                job_title: jobContent.title,
                photo_alt: jobContent.photo_alt,
                created_at: new Date().toISOString(),
                media_type: "video",
                video_url: liveMediaUrl,
              },
            },
            status: "pending_approval",
          });
        supabaseInserted = true;
      }
    }
  } catch (err) {
    console.warn("[ingest-job] Supabase write failed:", err.message);
  }

  // ── 9. Poll Vercel for preview URL ─────────────────────────────────────
  let previewUrl = null;
  let previewError = null;
  if (process.env.VERCEL_TOKEN) {
    try {
      previewUrl = await findVercelPreviewUrl({ commitSha: sha });
    } catch (err) {
      previewError = String(err.message || err);
    }
  }

  return res.status(200).json({
    ok: true,
    transcript,
    classifier_output: meta,
    generated_content: jobContent,
    suburb: { name: suburb.name, slug: suburb.slug, postcode: suburb.postcode },
    branch,
    sha,
    diff_url: `https://github.com/${GITHUB_REPO}/commit/${sha}`,
    preview_url: previewUrl,
    preview_error: previewError,
    supabase_row_created: supabaseInserted,
    next_step:
      "Review the preview, then text YES to the WhatsApp bot — it'll find the latest bot/* branch and merge. " +
      "GBP Slack ping will fire on merge. " +
      "If Supabase row wasn't created (no client phone match), the GBP ping won't fire — set submitted_by to a known client phone next time.",
  });
};

module.exports.config = {
  maxDuration: 300,
};

// ─── JSON body + URL fetch helpers ───────────────────────────────────────

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

async function fetchAsBuffer(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, contentType: r.headers.get("content-type") || "" };
}

function guessTypeFromUrl(url) {
  const u = String(url || "").toLowerCase().split("?")[0];
  if (u.endsWith(".mp4")) return "video/mp4";
  if (u.endsWith(".mov")) return "video/quicktime";
  if (u.endsWith(".webm")) return "video/webm";
  if (u.endsWith(".3gp")) return "video/3gpp";
  return null;
}

// ─── multipart parser ────────────────────────────────────────────────────

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 4, fileSize: 80 * 1024 * 1024 } });
    } catch (err) {
      return reject(err);
    }
    const fields = {};
    const files = {};
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("file", (name, stream, info) => {
      const chunks = [];
      let truncated = false;
      stream.on("data", (c) => chunks.push(c));
      stream.on("limit", () => { truncated = true; });
      stream.on("end", () => {
        if (truncated) return reject(new Error(`file ${name} exceeded 80MB limit`));
        files[name] = {
          buf: Buffer.concat(chunks),
          filename: info.filename,
          contentType: info.mimeType,
        };
      });
      stream.on("error", reject);
    });
    bb.on("error", reject);
    bb.on("close", () => resolve({ fields, files }));
    req.pipe(bb);
  });
}

// ─── Whisper transcription from raw buffer ───────────────────────────────

async function transcribeAudioBuffer({ buf, contentType }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY not configured" };
  try {
    const ct = (contentType || "audio/m4a").toLowerCase();
    const ext = ct.includes("ogg") ? "ogg"
              : ct.includes("mpeg") || ct.includes("mp3") ? "mp3"
              : ct.includes("mp4") || ct.includes("m4a") ? "m4a"
              : ct.includes("wav") ? "wav"
              : ct.includes("webm") ? "webm" : "m4a";
    const blob = new Blob([buf], { type: contentType || "audio/m4a" });
    const form = new FormData();
    form.append("file", blob, `voice.${ext}`);
    form.append("model", "whisper-1");
    form.append("response_format", "text");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return { ok: false, error: `Whisper ${r.status}: ${detail.slice(0, 200)}` };
    }
    const text = (await r.text()).trim();
    if (!text) return { ok: false, error: "Whisper returned empty transcription" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ─── Anthropic (copied from api/whatsapp.js to keep this endpoint self-contained) ──

const PHOTO_JOB_CLASSIFIER_SYSTEM = `Extract fields from a caption that accompanies a paint-job photo or video. The caption may describe a job Adrian just completed (work piece, specific location) OR be a generic gallery upload. Reply with valid JSON only:

{
  "is_job": boolean,
  "gallery": {
    "title": "Sentence Case short title",
    "category": "residential" | "commercial" | "industrial" | "roof",
    "location": "Cairns suburb if mentioned, else \\"\\"",
    "postcode": "4-digit AU postcode based on suburb, else \\"\\"",
    "note": "short description, optional"
  },
  "job": {
    "suburb": "Cairns suburb name (only if is_job true)",
    "summary": "one-line summary of the job",
    "job_type": "exterior_repaint | interior_repaint | roof | commercial_fitout | touch_up | pressure_wash | other",
    "brands_used": ["Sikkens", "Dulux", "Festool", "..."],
    "architectural_style": "e.g. high-set Queenslander, fibro cottage, modern brick, or \\"\\""
  }
}

JOB CLASSIFICATION:
- is_job=TRUE when the caption describes a completed work piece in a specific location. Markers: "just finished", "just did", "completed", "done", "wrapped up", "finished today", or a clear suburb + work type.
- is_job=FALSE when the caption is generic ("team photo", "site overview", "warehouse interior shot").
- When in doubt AND a Cairns suburb is named: lean is_job=TRUE.

Suburb postcodes for gallery.postcode: Trinity Beach=4879, Holloways Beach=4878, Palm Cove=4879, Edge Hill=4870, Edmonton=4869, Cairns CBD=4870, Smithfield=4878, Portsmith=4870, Port Douglas=4877.`;

async function callAnthropic({ model, max_tokens, system, user, parseJson }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model, max_tokens, system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic ${model} ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  const raw = data.content?.[0]?.text || "";
  if (!parseJson) return raw;
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error(`Couldn't parse JSON from ${model}`);
}

// ─── GitHub helpers ──────────────────────────────────────────────────────

const GH_BASE = "https://api.github.com";

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mrpaint-bot",
  };
}

async function ghJson(method, path, body) {
  const r = await fetch(`${GH_BASE}${path}`, {
    method,
    headers: { ...ghHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GitHub ${method} ${path} → ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function ghGetContents(repo, filePath, ref) {
  return ghJson("GET", `/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`);
}

async function ghCommitMulti({ repo, branch, baseRef, message, files }) {
  const base = await ghJson("GET", `/repos/${repo}/branches/${encodeURIComponent(baseRef)}`);
  const baseCommitSha = base.commit.sha;
  const baseTreeSha = base.commit.commit.tree.sha;

  const treeEntries = await Promise.all(files.map(async (f) => {
    const blob = await ghJson("POST", `/repos/${repo}/git/blobs`, {
      content: f.content,
      encoding: f.encoding || "utf-8",
    });
    return { path: f.path, sha: blob.sha, mode: "100644", type: "blob" };
  }));

  const tree = await ghJson("POST", `/repos/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  const commit = await ghJson("POST", `/repos/${repo}/git/commits`, {
    message, tree: tree.sha, parents: [baseCommitSha],
  });

  try {
    await ghJson("POST", `/repos/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`, sha: commit.sha,
    });
  } catch (err) {
    if (/Reference already exists/i.test(String(err.message))) {
      await ghJson("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha: commit.sha, force: true,
      });
    } else { throw err; }
  }
  return commit.sha;
}

// ─── Vercel preview URL polling ──────────────────────────────────────────

async function findVercelPreviewUrl({ commitSha, timeoutMs = 90000, intervalMs = 5000 }) {
  const token = process.env.VERCEL_TOKEN;
  const projectSlug = process.env.VERCEL_PROJECT_SLUG || "mrpaint";
  const teamId = process.env.VERCEL_TEAM_ID || "";
  const teamQuery = teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
  const url = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectSlug)}&meta-githubCommitSha=${encodeURIComponent(commitSha)}&limit=1${teamQuery}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const data = await r.json();
      const dep = (data.deployments || [])[0];
      if (dep) {
        const state = dep.readyState || dep.state;
        if (state === "READY") return `https://${dep.url}`;
        if (state === "ERROR" || state === "CANCELED") {
          throw new Error(`Vercel build ${state}`);
        }
      }
    } else if (r.status === 401 || r.status === 403) {
      throw new Error(`Vercel auth ${r.status} — check VERCEL_TOKEN scope`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

// ─── small utilities ─────────────────────────────────────────────────────

function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function pickVideoExt(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("quicktime") || ct.includes("mov")) return "mov";
  if (ct.includes("3gpp") || ct.includes("3gp")) return "3gp";
  if (ct.includes("webm")) return "webm";
  return "mp4";
}

function slugify(s) {
  return String(s || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "video";
}
