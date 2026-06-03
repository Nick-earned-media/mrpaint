// Twilio WhatsApp webhook handler — MrPaint editorial + conversational bot.
//
// Flow:
//   1. Validate Twilio signature.
//   2. Whitelist check (ALLOWED_PHONES).
//   3. Ack Twilio immediately with empty TwiML so the 10s timeout never bites.
//   4. Background work via waitUntil():
//      - Slash commands / media → execute directly.
//      - Otherwise: Claude Haiku classifies into a site-edit operation.
//      - Site-edit ops → file edit, GitHub commit to bot/* branch, preview URL.
//      - "Unknown" intent → falls through to chat() (the conversational
//        strategist with retrieval + tools — see lib/chat.js).
//      - On "YES" → merge branch to main. On "NO" → delete branch.
//
// Env vars:
//   TWILIO_AUTH_TOKEN, TWILIO_ACCOUNT_SID
//   TWILIO_FROM            — optional, defaults to sandbox "whatsapp:+14155238886"
//   ANTHROPIC_API_KEY
//   GITHUB_TOKEN, GITHUB_REPO   ("Nick-earned-media/mrpaint")
//   ALLOWED_PHONES         — E.164, comma-separated
//   SKIP_SIGNATURE_CHECK=1 — for local testing

const crypto = require("node:crypto");
const { waitUntil } = require("@vercel/functions");

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "whatsapp:+14155238886";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "Nick-earned-media/mrpaint";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || "";
const VERCEL_PROJECT_SLUG = process.env.VERCEL_PROJECT_SLUG || "mrpaint";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || ""; // optional, only needed for team-scoped tokens
const ALLOWED_PHONES = (process.env.ALLOWED_PHONES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SKIP_SIGNATURE_CHECK = process.env.SKIP_SIGNATURE_CHECK === "1";

const VERCEL_TEAM_SLUG = "nick-brogdens-projects";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const params = req.body || {};
  const fromRaw = String(params.From || "");
  const messageBody = String(params.Body || "").trim();
  const numMedia = parseInt(params.NumMedia || "0", 10) || 0;
  const media = numMedia > 0
    ? { url: String(params.MediaUrl0 || ""), contentType: String(params.MediaContentType0 || "") }
    : null;

  if (!SKIP_SIGNATURE_CHECK) {
    const signature = req.headers["x-twilio-signature"];
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${proto}://${host}${req.url}`;
    if (!signature || !verifySignature(TWILIO_AUTH_TOKEN, signature, url, params)) {
      console.warn("twilio-webhook: invalid signature");
      res.status(403).send("Forbidden");
      return;
    }
  }

  const phone = fromRaw.replace(/^whatsapp:/, "");
  if (!ALLOWED_PHONES.includes(phone)) {
    console.warn("twilio-webhook: rejected phone", { phone });
    return reply(res, "Sorry — this number isn't authorised to edit the MrPaint site.");
  }
  if (!messageBody && !media) {
    return reply(res, "Got an empty message. Send some text, or attach a photo with a caption.");
  }

  // Ack Twilio immediately so the webhook doesn't time out — actual work
  // continues in the background and the reply is sent via the Twilio API.
  ack(res);

  waitUntil(handleMessage(fromRaw, messageBody, media).catch(async (err) => {
    console.error("bot error:", err);
    await sendMessage(fromRaw, `⚠️ ${truncate(String(err.message || err), 400)}`);
  }));
};

async function handleMessage(fromWa, message, media) {
  if (!ANTHROPIC_API_KEY) {
    return sendMessage(fromWa, "⚠️ ANTHROPIC_API_KEY isn't set on the server.");
  }
  // Photo attached? Route to gallery upload (caption-or-prompt-for-it).
  if (media?.url) {
    return executeAddGalleryPhoto(fromWa, message, media);
  }
  // Slash commands bypass the LLM classifier — they're explicit + cheap.
  const trimmed = message.trim().toLowerCase();
  if (trimmed === "/audit" || trimmed === "audit") {
    return executeAudit(fromWa);
  }
  if (trimmed === "/rankings" || trimmed === "rankings") {
    return executeRankings(fromWa);
  }
  if (trimmed === "/semrush" || trimmed === "semrush") {
    return executeSemrush(fromWa);
  }
  if (trimmed.startsWith("/semrush kw ") || trimmed.startsWith("semrush kw ")) {
    const phrase = message.trim().replace(/^\/?semrush\s+kw\s+/i, "").trim();
    return executeSemrushKw(fromWa, phrase);
  }
  if (trimmed === "/reset" || trimmed === "reset") {
    return executeReset(fromWa);
  }
  if (trimmed === "/sync" || trimmed === "sync") {
    return executeSyncKeywords(fromWa);
  }
  if (trimmed === "/digest" || trimmed === "digest") {
    return executeDigest(fromWa);
  }
  const intent = await classifyIntent(message);
  intent._original_message = message;
  await routeIntent(fromWa, intent);
}

async function routeIntent(fromWa, intent) {
  switch (intent.operation) {
    case "update_business_info":
      return executeUpdateBusinessInfo(fromWa, intent);
    case "update_text":
      return executeUpdateText(fromWa, intent);
    case "add_blog_post":
      return executeAddBlogPost(fromWa, intent);
    case "approve":
      return handleApprove(fromWa);
    case "discard":
      return handleDiscard(fromWa);
    case "needs_image":
    case "add_gallery_photo":
      return sendMessage(fromWa,
        "🤖 To add a photo to the gallery, send it as a WhatsApp attachment WITH a caption in the same message.\n\n" +
        "Tap the photo before sending → add a caption like:\n" +
        "• \"interior repaint — Trinity Beach\"\n" +
        "• \"commercial fit-out, Cairns CBD\"\n" +
        "• \"roof restoration, Palm Cove\"\n\n" +
        "Include the category (residential/commercial/industrial/roof), title, and location."
      );
    case "unknown":
      // Not a site-edit request — route to the conversational strategist.
      return executeChat(fromWa, intent._original_message || "");
    default:
      return sendMessage(fromWa, `🤖 Got an unexpected intent:\n${JSON.stringify(intent, null, 2)}`);
  }
}

// ─── Intent classifier (Haiku) ────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are the backend webhook for a Cairns painting business (MrPaint). Adrian, the owner, messages you in plain English to edit his static website. Classify each message into ONE operation and extract parameters. Reply with valid JSON ONLY — no prose, no code fences.

Operations:
- update_business_info: change a sitewide business field. {"operation":"update_business_info","field":"phone"|"email"|"address"|"hours","value":string}
- add_blog_post: write a new blog post from a topic or short brief. {"operation":"add_blog_post","title":string,"body_markdown":string}. Generate a 250-450 word body in tradie-friendly Cairns voice.
- add_gallery_photo: not doable with text only. {"operation":"needs_image","message":string}
- update_text: change specific text on the site (hero copy, an FAQ answer, a button label, etc.). {"operation":"update_text","description":string}
- approve: user is confirming a pending change ("yes", "publish", "ship", "ok go", "yes please"). {"operation":"approve"}
- discard: user is cancelling a pending change ("no", "cancel", "discard", "nope", "scrap it"). {"operation":"discard"}
- unknown: doesn't match any operation. {"operation":"unknown","reason":string}

Examples:
"change the phone to 0412 345 678" → {"operation":"update_business_info","field":"phone","value":"0412 345 678"}
"YES" → {"operation":"approve"}
"yes publish it" → {"operation":"approve"}
"nope cancel that" → {"operation":"discard"}
"add a blog post about prepping a Queenslander" → {"operation":"add_blog_post","title":"Prepping a Queenslander for an exterior repaint","body_markdown":"..."}
"swap the hero photo on the homepage" → {"operation":"needs_image","message":"send me the photo to use"}
"add a . at the end of the homepage h1" → {"operation":"update_text","description":"add a period at the end of the homepage h1"}
"when will it be done" → {"operation":"unknown","reason":"question about timeline/status, not a website edit request"}

Reply with the JSON object only.`;

async function classifyIntent(message) {
  return callAnthropic({
    model: "claude-haiku-4-5",
    max_tokens: 800,
    system: CLASSIFIER_SYSTEM_PROMPT,
    user: message,
    parseJson: true,
  });
}

// ─── update_business_info ─────────────────────────────────────────────────

async function executeUpdateBusinessInfo(fromWa, intent) {
  const { field, value } = intent;
  if (!field || !value) throw new Error(`update_business_info: missing field/value`);

  await sendMessage(fromWa, `🤖 Updating ${field} to "${value}"…`);

  const file = await ghGetContents("_data/site.json", "main");
  const site = JSON.parse(Buffer.from(file.content, "base64").toString("utf-8"));
  const before = JSON.stringify(site[field] ?? null);
  applyBusinessFieldUpdate(site, field, value);

  const branch = `bot/${Date.now()}-update-${slug(field)}`;
  const sha = await ghCommit({
    branch,
    file: "_data/site.json",
    content: JSON.stringify(site, null, 2) + "\n",
    message: `Bot: update ${field} to ${truncate(String(value), 80)}`,
    baseRef: "main",
  });

  await sendPreviewMessage(fromWa, {
    summary: `Updated **${field}**.\nBefore: ${before}\nAfter: "${value}"`,
    branch, sha,
  });
}

function applyBusinessFieldUpdate(site, field, value) {
  if (field === "phone") {
    site.phone = value;
    site.phone_display = value;
    const digits = String(value).replace(/\D/g, "");
    site.phone_link = digits.startsWith("04") && digits.length === 10
      ? `tel:+61${digits.slice(1)}`
      : `tel:${String(value).replace(/\s/g, "")}`;
  } else if (field === "email") {
    site.email = value;
  } else if (field === "hours") {
    site.hours = value;
  } else if (field === "address") {
    const m = String(value).match(/^(.+?),\s*(.+?)\s+([A-Z]{2,3})\s*(\d{4})$/);
    if (m) site.address = { ...site.address, street: m[1], suburb: m[2], state: m[3], postcode: m[4] };
    else site.address = { ...site.address, street: value };
  } else {
    throw new Error(`Unknown business field: ${field}`);
  }
}

// ─── /audit ───────────────────────────────────────────────────────────────

async function executeAudit(fromWa) {
  await sendMessage(fromWa, "🔍 Running full audit on mrpaint.com.au — SEO + competitors + GSC. Back in ~30-40s.");
  const { runAudit, formatAuditMessages } = require("../lib/audit.js");
  const audit = await runAudit();
  const messages = formatAuditMessages(audit);
  // Send messages sequentially so they arrive in order in WhatsApp.
  for (const m of messages) {
    await sendMessage(fromWa, m);
  }
}

// ─── /rankings ────────────────────────────────────────────────────────────

async function executeRankings(fromWa) {
  await sendMessage(fromWa, "📊 Pulling Rank Tracker data from Ahrefs…");
  const { fetchRankings, formatRankingsMessages } = require("../lib/rankings.js");
  const r = await fetchRankings();
  for (const m of formatRankingsMessages(r)) {
    await sendMessage(fromWa, m);
  }
}

// ─── /semrush ─────────────────────────────────────────────────────────────

async function executeSemrush(fromWa) {
  await sendMessage(fromWa, "📊 Pulling Semrush snapshot — domain overview + competitors. Back in ~15s.");
  const { runSemrushSnapshot, formatSemrushMessages } = require("../lib/semrush.js");
  try {
    const snap = await runSemrushSnapshot();
    for (const m of formatSemrushMessages(snap)) {
      await sendMessage(fromWa, m);
    }
  } catch (err) {
    await sendMessage(fromWa, `⚠️ Semrush snapshot failed: ${err.message || err}`);
  }
}

async function executeSemrushKw(fromWa, phrase) {
  if (!phrase) {
    return sendMessage(fromWa, '🤖 Usage: "/semrush kw painter cairns"');
  }
  await sendMessage(fromWa, `🔎 Researching "${phrase}" on Semrush…`);
  const { keywordOverview, keywordRelated, formatKeywordResearch } = require("../lib/semrush.js");
  try {
    const database = process.env.SEMRUSH_DATABASE || "au";
    const [overview, related] = await Promise.all([
      keywordOverview(phrase, database),
      keywordRelated(phrase, { database, limit: 12 }),
    ]);
    for (const m of formatKeywordResearch(phrase, overview, related)) {
      await sendMessage(fromWa, m);
    }
  } catch (err) {
    await sendMessage(fromWa, `⚠️ Semrush keyword lookup failed: ${err.message || err}`);
  }
}

// ─── /digest — manually fire the Friday digest right now ────────────────

async function executeDigest(fromWa) {
  await sendMessage(fromWa, "📊 Generating this week's report URL…");
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://mrpaint.vercel.app";
  const today = new Date().toISOString().slice(0, 10);
  const url = `${PUBLIC_BASE_URL}/reports/cairns/${today}`;
  await sendMessage(fromWa,
    `📊 Friday digest — Cairns week ending ${today}.\n\n${url}\n\nReply with a question if you want me to dig into anything.`
  );
}

// ─── /sync — manually trigger Semrush → Supabase keyword sync ────────────

async function executeSyncKeywords(fromWa) {
  await sendMessage(fromWa, "📊 Syncing Semrush position tracking → Supabase. Back in ~15s.");
  const phone = fromWa.replace(/^whatsapp:/, "");
  let supaMod, syncMod;
  try {
    supaMod = require("../lib/supabase.js");
    syncMod = require("../lib/sync-semrush.js");
  } catch (err) {
    return sendMessage(fromWa, `⚠️ ${err.message || err}`);
  }
  const clientRow = await supaMod.getClientByPhone(phone);
  if (!clientRow) return sendMessage(fromWa, "🤖 No client linked to this number.");
  try {
    const r = await syncMod.syncTrackedKeywords(clientRow.id);
    return sendMessage(fromWa,
      `✅ Synced.\n\n` +
      `Tracked keywords: ${r.synced}\n` +
      `History rows written for ${r.snapshot_date}: ${r.history_rows}\n` +
      `Campaign: ${r.campaign_id} (${r.engine})\n` +
      `Domain: ${r.domain}` +
      (r.note ? `\n\nNote: ${r.note}` : "")
    );
  } catch (err) {
    console.error("sync error:", err);
    return sendMessage(fromWa, `⚠️ Sync failed: ${truncate(String(err.message || err), 400)}`);
  }
}

// ─── /reset — clear the active conversation thread so next chat starts fresh ─

async function executeReset(fromWa) {
  const phone = fromWa.replace(/^whatsapp:/, "");
  let supaMod;
  try {
    supaMod = require("../lib/supabase.js");
  } catch (err) {
    return sendMessage(fromWa, `⚠️ ${err.message || err}`);
  }
  const clientRow = await supaMod.getClientByPhone(phone);
  if (!clientRow) return sendMessage(fromWa, "🤖 No client linked to this number.");
  const { error } = await supaMod.client()
    .from("conversation_threads")
    .update({ last_active_at: "2020-01-01T00:00:00Z" })
    .eq("client_id", clientRow.id)
    .eq("phone_number", phone);
  if (error) return sendMessage(fromWa, `⚠️ Reset failed: ${error.message}`);
  return sendMessage(fromWa, "🧹 Conversation cleared. Next message starts a fresh thread with no past context.");
}

// ─── chat (conversational strategist with retrieval + tools) ─────────────

async function executeChat(fromWa, message) {
  if (!message) {
    return sendMessage(fromWa, "Got an empty message — what's on your mind?");
  }
  const phone = fromWa.replace(/^whatsapp:/, "");
  let chatMod, supaMod;
  try {
    chatMod = require("../lib/chat.js");
    supaMod = require("../lib/supabase.js");
  } catch (err) {
    return sendMessage(fromWa, `⚠️ Chat module not available: ${err.message || err}`);
  }
  const clientRow = await supaMod.getClientByPhone(phone);
  if (!clientRow) {
    return sendMessage(fromWa,
      "Couldn't find a client linked to this number in the database. " +
      "Make sure your phone is in the clients.allowed_phones array."
    );
  }
  // Fire-and-forget "thinking" status so the user sees activity while the
  // chat() call (which can take 5-15s with tool loops) runs in the background.
  // We use a context-aware status if the question pattern matches a known tool.
  const status = pickThinkingStatus(message);
  sendMessage(fromWa, status).catch(() => {});
  try {
    const reply = await chatMod.chat({
      clientId: clientRow.id,
      phoneNumber: phone,
      message,
      clientRow,
    });
    return sendMessage(fromWa, reply);
  } catch (err) {
    console.error("chat error:", err);
    return sendMessage(fromWa, `⚠️ ${truncate(String(err.message || err), 400)}`);
  }
}

function pickThinkingStatus(message) {
  const m = String(message).toLowerCase();
  if (/(ranking|rank|position|visibility|semrush|sov|share.*voice)/.test(m)) {
    return "📊 Pulling your latest Semrush data…";
  }
  if (/(competitor|beating|losing|against)/.test(m)) {
    return "📊 Checking competitor data in Semrush…";
  }
  if (/(review|rating|google review|gbp|business profile)/.test(m)) {
    return "📚 Checking the local-SEO playbook…";
  }
  if (/(remind|follow up|nudge)/.test(m)) {
    return "📝 Setting that up…";
  }
  if (/(job|just (did|finished)|painted|customer)/.test(m)) {
    return "📝 Logging that…";
  }
  return "🤔 Hang on, checking that for you…";
}

// ─── update_text (Sonnet-powered template edit) ──────────────────────────

const EDITOR_SYSTEM_PROMPT = `You are an expert Eleventy/Nunjucks template editor. Given a description of a text or markup change and the project's editable files, identify exactly which file to modify and produce a surgical edit.

Reply with VALID JSON ONLY (no prose, no code fences):
{
  "file_path": "<relative path of file to edit>",
  "old_string": "<EXACT substring of the file's current content to be replaced — must be unique within the file; include 1-3 lines of context if needed>",
  "new_string": "<replacement>",
  "reason": "<one-sentence explanation>"
}

Rules:
- old_string must be EXACT (preserve whitespace, HTML tags, Nunjucks syntax, casing, punctuation). Copy it verbatim from the file.
- old_string must be UNIQUE in the file. If the same text occurs more than once, include enough surrounding context (e.g. the parent tag) to make it unique.
- Prefer the smallest replacement that satisfies the request. If the user asks for two adjustments in the same line (e.g. add punctuation AND remove tags), do both in one replacement of that line.
- For JSON data files, edit the JSON value while preserving the rest of the file.
- Never include code fences or commentary in your reply — JSON only.`;

const EDITABLE_FILES = [
  "index.njk", "about.njk", "painter-cairns.njk", "commercial-painter-cairns.njk",
  "industrial-painting.njk", "gallery.njk", "blog.njk", "contact.njk",
  "_includes/base.njk", "_includes/post.njk",
  "_data/site.json", "_data/gallery.json", "_data/services_trio.json",
  "_data/trust_marquee.json", "_data/locations.json", "_data/faq.json",
];

async function executeUpdateText(fromWa, intent) {
  const { description } = intent;
  if (!description) throw new Error("update_text: missing description");

  await sendMessage(fromWa, `🤖 Working on: ${truncate(description, 120)}\n(scanning templates, ~10-25s)`);

  // Pull editable files from main in parallel.
  const fileResults = await Promise.all(EDITABLE_FILES.map(async (path) => {
    try {
      const f = await ghGetContents(path, "main");
      return { path, content: Buffer.from(f.content, "base64").toString("utf-8") };
    } catch { return null; }
  }));
  const files = fileResults.filter(Boolean);

  // Ask Sonnet to figure out the edit.
  const editorPayload = `Description: ${description}\n\nEditable files:\n` +
    files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");

  const edit = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    system: EDITOR_SYSTEM_PROMPT,
    user: editorPayload,
    parseJson: true,
  });

  if (!edit?.file_path || !edit?.old_string || !edit?.new_string) {
    throw new Error(`Editor returned incomplete edit: ${JSON.stringify(edit).slice(0, 300)}`);
  }
  const target = files.find((f) => f.path === edit.file_path);
  if (!target) throw new Error(`File not in editable list: ${edit.file_path}`);

  const newContent = target.content.replace(edit.old_string, edit.new_string);
  if (newContent === target.content) {
    throw new Error(`Edit didn't apply — old_string not found in ${edit.file_path}. Try rephrasing.`);
  }

  const branch = `bot/${Date.now()}-update-text`;
  const sha = await ghCommit({
    branch,
    file: edit.file_path,
    content: newContent,
    message: `Bot: ${truncate(description, 60)}`,
    baseRef: "main",
  });

  await sendPreviewMessage(fromWa, {
    summary: `Edited **${edit.file_path}**\nReason: ${edit.reason || description}`,
    branch, sha,
  });
}

// ─── add_blog_post ────────────────────────────────────────────────────────

async function executeAddBlogPost(fromWa, intent) {
  const { title, body_markdown } = intent;
  if (!title || !body_markdown) throw new Error("add_blog_post: missing title or body");

  const today = new Date().toISOString().slice(0, 10);
  const slugTitle = slug(title);
  const summary = body_markdown.split("\n").find((l) => l.trim().length > 40)?.slice(0, 180) || "";
  const md = `---\ntitle: ${title.replace(/"/g, '\\"')}\ndate: ${today}\nsummary: ${summary.replace(/"/g, '\\"')}\n---\n\n${body_markdown}\n`;

  await sendMessage(fromWa, `🤖 Drafting blog post "${title}"…`);

  const branch = `bot/${Date.now()}-blog-${slugTitle}`;
  const sha = await ghCommit({
    branch,
    file: `blog/${slugTitle}.md`,
    content: md,
    message: `Bot: add blog post "${truncate(title, 60)}"`,
    baseRef: "main",
  });

  await sendPreviewMessage(fromWa, {
    summary: `Drafted blog post:\n**${title}**\n\n${truncate(body_markdown, 240)}`,
    branch, sha,
  });
}

// ─── add_gallery_photo ───────────────────────────────────────────────────

const GALLERY_CAPTION_SYSTEM = `Extract gallery item fields from a caption describing a paint-job photo. Reply with valid JSON ONLY:
{
  "title": string,
  "category": "residential" | "commercial" | "industrial" | "roof",
  "location": string (Cairns suburb if mentioned, else ""),
  "postcode": string (4-digit AU postcode if implied — Trinity Beach=4879, Holloways=4878, Palm Cove=4879, Edge Hill=4870, Edmonton=4869, Cairns CBD=4870, Smithfield=4878, Portsmith=4870 — else ""),
  "note": string (short description, optional)
}

Infer category from clues if not explicit: interior/exterior/house/home/door/ceiling = residential, shop/office/cafe/strata = commercial, warehouse/factory/workshop = industrial, roof = roof. Default residential. Title should be Sentence Case.`;

async function executeAddGalleryPhoto(fromWa, caption, media) {
  if (!caption) {
    return sendMessage(fromWa,
      "🤖 Got the photo but no caption. WhatsApp lets you add one before sending — tap the photo, type a caption like:\n\n" +
      "• \"residential interior — Trinity Beach\"\n" +
      "• \"commercial fit-out, Cairns CBD\"\n\n" +
      "Then send again and I'll add it to the gallery."
    );
  }
  if (!media?.url) throw new Error("executeAddGalleryPhoto: missing media URL");

  await sendMessage(fromWa, `🤖 Adding photo: "${truncate(caption, 100)}"…`);

  // 1. Parse caption into structured fields.
  const meta = await callAnthropic({
    model: "claude-haiku-4-5",
    max_tokens: 400,
    system: GALLERY_CAPTION_SYSTEM,
    user: caption,
    parseJson: true,
  });

  // 2. Download the image from Twilio's signed media URL.
  const imageBuf = await downloadTwilioMedia(media.url);
  const contentType = (media.contentType || "").toLowerCase();
  const ext = contentType.includes("png") ? "png"
            : contentType.includes("webp") ? "webp"
            : contentType.includes("gif") ? "gif"
            : "jpg";
  const ts = Date.now();
  const fileSlug = slug(meta.title || "photo");
  const imagePath = `assets/images/work-${fileSlug}-${ts}.${ext}`;

  // 3. Read current gallery.json from main; prepend the new entry.
  const galleryFile = await ghGetContents("_data/gallery.json", "main");
  const gallery = JSON.parse(Buffer.from(galleryFile.content, "base64").toString("utf-8"));
  const newItem = {
    image: `/${imagePath}`,
    alt: meta.title,
    title: meta.title,
    category: meta.category || "residential",
    location: meta.location || "",
    postcode: meta.postcode || "",
    note: meta.note || "",
  };
  gallery.unshift(newItem);

  // 4. Commit BOTH files (binary image + updated JSON) atomically via git trees.
  const branch = `bot/${ts}-gallery-${fileSlug}`.slice(0, 200);
  const sha = await ghCommitMulti({
    branch,
    baseRef: "main",
    message: `Bot: add gallery photo "${truncate(meta.title, 60)}"`,
    files: [
      { path: imagePath, content: imageBuf.toString("base64"), encoding: "base64" },
      { path: "_data/gallery.json", content: JSON.stringify(gallery, null, 2) + "\n", encoding: "utf-8" },
    ],
  });

  await sendPreviewMessage(fromWa, {
    summary:
      `Added to gallery:\n**${meta.title}**\n` +
      `Category: ${meta.category} · ${meta.location || "—"}${meta.postcode ? " · " + meta.postcode : ""}` +
      (meta.note ? `\nNote: ${meta.note}` : ""),
    branch, sha,
  });
}

// ─── approve / discard ────────────────────────────────────────────────────

async function findLatestBotBranch() {
  const branches = await ghListBranches();
  const bot = branches.filter((b) => b.name.startsWith("bot/"));
  if (!bot.length) return null;
  // Branch name suffix encodes timestamp — newest = highest sort.
  bot.sort((a, b) => b.name.localeCompare(a.name));
  return bot[0].name;
}

async function handleApprove(fromWa) {
  const branch = await findLatestBotBranch();
  if (!branch) return sendMessage(fromWa, "🤖 No pending changes to publish.");

  await sendMessage(fromWa, `🤖 Merging \`${branch}\` to main…`);
  await ghMergeToMain(branch);
  await ghDeleteBranch(branch);
  await sendMessage(fromWa, `✅ Published. Live in ~60s at https://mrpaint.vercel.app`);
}

async function handleDiscard(fromWa) {
  const branch = await findLatestBotBranch();
  if (!branch) return sendMessage(fromWa, "🤖 No pending changes to discard.");
  await ghDeleteBranch(branch);
  await sendMessage(fromWa, `🗑 Discarded \`${branch}\`.`);
}

async function sendPreviewMessage(fromWa, { summary, branch, sha }) {
  const diffUrl = sha
    ? `https://github.com/${GITHUB_REPO}/commit/${sha}`
    : `https://github.com/${GITHUB_REPO}/tree/${branch.replace(/\//g, "%2F")}`;

  // Acknowledge the commit first so the user knows we're working.
  await sendMessage(fromWa,
    `✅ ${summary}\n\n` +
    `Diff (code): ${diffUrl}\n\n` +
    `🛠 Building preview… (~30-60s)`
  );

  // If we have a Vercel token, poll for the branch's auto-built preview URL
  // and send a follow-up with the rendered page link. Otherwise fall back
  // to just the diff URL + YES/NO prompt now.
  if (VERCEL_TOKEN && sha) {
    try {
      const previewUrl = await findVercelPreviewUrl({ commitSha: sha });
      if (previewUrl) {
        return sendMessage(fromWa,
          `🌐 Preview ready:\n${previewUrl}\n\n` +
          `Reply YES to publish, NO to discard.`
        );
      }
      return sendMessage(fromWa,
        `⏰ Preview build is taking longer than expected — try the diff link above, or wait a minute and refresh.\n\n` +
        `Reply YES to publish, NO to discard.`
      );
    } catch (err) {
      console.error("vercel preview poll failed:", err);
      return sendMessage(fromWa,
        `⚠️ Couldn't get a preview URL (${truncate(String(err.message || err), 120)}). Use the diff link above.\n\n` +
        `Reply YES to publish, NO to discard.`
      );
    }
  }

  await sendMessage(fromWa, `Reply YES to publish, NO to discard.`);
}

// Poll Vercel's Deployments API until the branch preview is READY (or fail).
async function findVercelPreviewUrl({ commitSha, timeoutMs = 90000, intervalMs = 5000 }) {
  const start = Date.now();
  const teamQuery = VERCEL_TEAM_ID ? `&teamId=${encodeURIComponent(VERCEL_TEAM_ID)}` : "";
  const url = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(VERCEL_PROJECT_SLUG)}&meta-githubCommitSha=${encodeURIComponent(commitSha)}&limit=1${teamQuery}`;

  while (Date.now() - start < timeoutMs) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
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
  return null; // timed out
}

// ─── Anthropic helper ─────────────────────────────────────────────────────

async function callAnthropic({ model, max_tokens, system, user, parseJson }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
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
  try { return extractJson(raw); }
  catch (e) { throw new Error(`Couldn't parse JSON from ${model}: ${truncate(String(e.message || e), 200)}\n\nFirst 300 chars of raw: ${raw.slice(0, 300)}`); }
}

// Robust JSON extraction: handles bare JSON, fenced JSON, and JSON-with-prose.
function extractJson(text) {
  if (!text) throw new Error("empty response");
  const trimmed = text.trim();
  // 1. Direct parse — Claude obeyed and replied with bare JSON.
  try { return JSON.parse(trimmed); } catch {}
  // 2. Inside a ```json … ``` (or plain ``` … ```) code fence.
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // 3. First { to matching last } — handles prose-before-JSON.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch {}
  }
  throw new Error(`no parseable JSON found`);
}

// ─── GitHub helpers (raw fetch) ───────────────────────────────────────────

const GH_BASE = "https://api.github.com";
const GH_HEADERS = () => ({
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "mrpaint-bot",
});

async function ghJson(method, path, body) {
  const r = await fetch(`${GH_BASE}${path}`, {
    method,
    headers: { ...GH_HEADERS(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GitHub ${method} ${path} → ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function ghGetContents(filePath, ref) {
  return ghJson("GET", `/repos/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`);
}

async function ghListBranches() {
  return ghJson("GET", `/repos/${GITHUB_REPO}/branches?per_page=100`);
}

async function ghCommit({ branch, file, content, message, baseRef }) {
  // Get base sha.
  const base = await ghJson("GET", `/repos/${GITHUB_REPO}/branches/${encodeURIComponent(baseRef)}`);

  // Create the branch (ignore "already exists").
  try {
    await ghJson("POST", `/repos/${GITHUB_REPO}/git/refs`, {
      ref: `refs/heads/${branch}`, sha: base.commit.sha,
    });
  } catch (err) {
    if (!/Reference already exists/i.test(String(err.message))) throw err;
  }

  // Get the file's current sha on the new branch.
  let sha;
  try {
    const f = await ghGetContents(file, branch);
    sha = f.sha;
  } catch { /* file doesn't exist yet */ }

  // PUT the new contents.
  const result = await ghJson("PUT", `/repos/${GITHUB_REPO}/contents/${encodeURIComponent(file)}`, {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });
  return result.commit?.sha;
}

// Atomic multi-file commit via the git tree API.
// Each file: { path, content, encoding: "utf-8" | "base64" }.
async function ghCommitMulti({ branch, baseRef, message, files }) {
  // 1. Base commit + tree SHAs.
  const base = await ghJson("GET", `/repos/${GITHUB_REPO}/branches/${encodeURIComponent(baseRef)}`);
  const baseCommitSha = base.commit.sha;
  const baseTreeSha = base.commit.commit.tree.sha;

  // 2. One blob per file.
  const treeEntries = await Promise.all(files.map(async (f) => {
    const blob = await ghJson("POST", `/repos/${GITHUB_REPO}/git/blobs`, {
      content: f.content,
      encoding: f.encoding || "utf-8",
    });
    return { path: f.path, sha: blob.sha, mode: "100644", type: "blob" };
  }));

  // 3. New tree extending base.
  const tree = await ghJson("POST", `/repos/${GITHUB_REPO}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  // 4. New commit.
  const commit = await ghJson("POST", `/repos/${GITHUB_REPO}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [baseCommitSha],
  });

  // 5. Create or fast-forward branch ref.
  try {
    await ghJson("POST", `/repos/${GITHUB_REPO}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  } catch (err) {
    if (/Reference already exists/i.test(String(err.message))) {
      await ghJson("PATCH", `/repos/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha: commit.sha,
        force: false,
      });
    } else throw err;
  }
  return commit.sha;
}

async function ghMergeToMain(branch) {
  return ghJson("POST", `/repos/${GITHUB_REPO}/merges`, {
    base: "main",
    head: branch,
    commit_message: `Bot: merge ${branch}`,
  });
}

async function ghDeleteBranch(branch) {
  const r = await fetch(`${GH_BASE}/repos/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "DELETE", headers: GH_HEADERS(),
  });
  if (!r.ok && r.status !== 422) {
    throw new Error(`Delete branch ${branch} → ${r.status}`);
  }
}

// ─── Twilio helpers ───────────────────────────────────────────────────────

function verifySignature(authToken, signature, url, params) {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + String(params[k])).join("");
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ack(res) {
  res.setHeader("Content-Type", "text/xml; charset=utf-8");
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

function reply(res, message) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`;
  res.setHeader("Content-Type", "text/xml; charset=utf-8");
  res.status(200).send(xml);
}

async function sendMessage(toWa, text) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({
    From: TWILIO_FROM,
    To: toWa.startsWith("whatsapp:") ? toWa : `whatsapp:${toWa}`,
    Body: text,
  });
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("Twilio send failed:", r.status, t.slice(0, 300));
  }
}

// Fetch a Twilio MediaUrl (signed; requires basic auth with Account SID+Token).
async function downloadTwilioMedia(url) {
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const r = await fetch(url, { headers: { Authorization: auth }, redirect: "follow" });
  if (!r.ok) throw new Error(`Twilio media download ${r.status} ${url}`);
  const arr = await r.arrayBuffer();
  return Buffer.from(arr);
}

// ─── small utils ─────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function slug(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
