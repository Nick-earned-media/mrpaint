// Twilio WhatsApp webhook handler — MrPaint editorial bot.
//
// Flow:
//   1. Validate Twilio signature.
//   2. Whitelist check (ALLOWED_PHONES).
//   3. Ack Twilio immediately with empty TwiML so the 10s timeout never bites.
//   4. Background work via waitUntil():
//      - Claude Haiku classifies the message into an operation.
//      - Operation executes (file edit, GitHub commit to bot/* branch).
//      - Reply with preview URL + YES/NO prompt via Twilio Messages API.
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
const ALLOWED_PHONES = (process.env.ALLOWED_PHONES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SKIP_SIGNATURE_CHECK = process.env.SKIP_SIGNATURE_CHECK === "1";

const VERCEL_PROJECT_SLUG = "mrpaint";
const VERCEL_TEAM_SLUG = "nick-brogdens-projects";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const params = req.body || {};
  const fromRaw = String(params.From || "");
  const messageBody = String(params.Body || "").trim();

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
  if (!messageBody) {
    return reply(res, "Got an empty message. Send some text to try.");
  }

  // Ack Twilio immediately so the webhook doesn't time out — actual work
  // continues in the background and the reply is sent via the Twilio API.
  ack(res);

  waitUntil(handleMessage(fromRaw, messageBody).catch(async (err) => {
    console.error("bot error:", err);
    await sendMessage(fromRaw, `⚠️ ${truncate(String(err.message || err), 400)}`);
  }));
};

async function handleMessage(fromWa, message) {
  if (!ANTHROPIC_API_KEY) {
    return sendMessage(fromWa, "⚠️ ANTHROPIC_API_KEY isn't set on the server.");
  }
  const intent = await classifyIntent(message);
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
      return sendMessage(fromWa, `🤖 ${intent.message || "Send the photo as a WhatsApp attachment (image handling lands next)."}`);
    case "unknown":
      return sendMessage(fromWa,
        `🤖 Not sure what to do with that.${intent.reason ? " " + intent.reason : ""}\n\n` +
        `Try:\n` +
        `• "change phone to 0412 345 678"\n` +
        `• "add a . at the end of the homepage h1"\n` +
        `• "add a blog post about prepping a Queenslander"\n` +
        `• "YES" / "NO" to approve or discard a pending change`
      );
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
  await ghCommit({
    branch,
    file: "_data/site.json",
    content: JSON.stringify(site, null, 2) + "\n",
    message: `Bot: update ${field} to ${truncate(String(value), 80)}`,
    baseRef: "main",
  });

  await sendPreviewMessage(fromWa, {
    summary: `Updated **${field}**.\nBefore: ${before}\nAfter: "${value}"`,
    branch,
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
  await ghCommit({
    branch,
    file: edit.file_path,
    content: newContent,
    message: `Bot: ${truncate(description, 60)}`,
    baseRef: "main",
  });

  await sendPreviewMessage(fromWa, {
    summary: `Edited **${edit.file_path}**\nReason: ${edit.reason || description}`,
    branch,
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
  await ghCommit({
    branch,
    file: `blog/${slugTitle}.md`,
    content: md,
    message: `Bot: add blog post "${truncate(title, 60)}"`,
    baseRef: "main",
  });

  await sendPreviewMessage(fromWa, {
    summary: `Drafted blog post:\n**${title}**\n\n${truncate(body_markdown, 240)}`,
    branch,
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

async function sendPreviewMessage(fromWa, { summary, branch }) {
  const previewUrl = `https://${VERCEL_PROJECT_SLUG}-git-${branch.replace(/\//g, "-")}-${VERCEL_TEAM_SLUG}.vercel.app`;
  await sendMessage(fromWa,
    `✅ ${summary}\n\n` +
    `Branch: \`${branch}\`\n` +
    `Preview: ${previewUrl}\n` +
    `(takes ~60s to build)\n\n` +
    `Reply YES to publish, NO to discard.`
  );
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
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(clean); }
  catch (e) { throw new Error(`Couldn't parse JSON from ${model}: ${clean.slice(0, 300)}`); }
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
  await ghJson("PUT", `/repos/${GITHUB_REPO}/contents/${encodeURIComponent(file)}`, {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });
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
