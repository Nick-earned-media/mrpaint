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
//   TWILIO_FROM            — "whatsapp:+XXXXXXXXXX" for WhatsApp, "+XXXXXXXXXX" for SMS
//   ANTHROPIC_API_KEY
//   GITHUB_TOKEN, GITHUB_REPO   ("Nick-earned-media/mrpaint")
//   ALLOWED_PHONES         — E.164, comma-separated
//   SKIP_SIGNATURE_CHECK=1 — for local testing

const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { waitUntil } = require("@vercel/functions");

// Per-request channel context — lets Slack (or any other channel) inject its
// own sendMessage / downloadMedia without touching any execute* functions.
const channelCtx = new AsyncLocalStorage();

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
const SITE_BASE = process.env.PUBLIC_BASE_URL || "https://mrpaint.com.au";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_NOTIFY_CHANNEL = process.env.SLACK_NOTIFY_CHANNEL || "";
const SLACK_NOTIFY_USER_ID = process.env.SLACK_NOTIFY_USER_ID || "";

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
    // Log the technical detail for debugging, but never dump it to the user —
    // raw API errors (GitHub 409, Twilio 401, etc.) look like garbage in chat.
    console.error("bot error:", err);
    await sendMessage(fromRaw,
      "⚠️ Hit a snag on that one boss — give me a sec and try again. If it keeps failing, message me what you were trying to do."
    );
  }));
};

async function handleMessage(fromWa, message, media) {
  if (!ANTHROPIC_API_KEY) {
    return sendMessage(fromWa, "⚠️ ANTHROPIC_API_KEY isn't set on the server.");
  }

  // Log inbound — fire-and-forget so it never blocks the bot
  require("../lib/message-log.js").logInbound(fromWa, message, { hasMedia: !!media?.url }).catch(() => {});

  const phone = fromWa.replace(/^whatsapp:/, "");
  const captures = require("../lib/captures.js");
  const areaPages = require("../lib/area-pages.js");
  const [capture, areaPage] = await Promise.all([
    captures.getActiveCapture(phone).catch((err) => {
      console.warn("[captures] lookup failed:", err.message); return null;
    }),
    areaPages.getActiveAreaPage(phone).catch((err) => {
      console.warn("[area-pages] lookup failed:", err.message); return null;
    }),
  ]);

  // ── Media attached? Route by content type, capture-aware. ──────────────
  if (media?.url) {
    const ct = String(media.contentType || "").toLowerCase();

    if (ct.startsWith("image/") || ct.startsWith("video/")) {
      const mediaWord = ct.startsWith("video/") ? "video" : "photo";

      // Path 1 — Caption + media in the same message: direct publish.
      // Treat any active capture as superseded by this fresh, complete post.
      if (message && message.trim()) {
        if (capture) {
          await captures.markStatus(capture.id, "abandoned").catch(() => {});
        }
        return publishCairnsHubJob({
          fromWa, phone,
          mediaItems: [{ url: media.url, contentType: media.contentType }],
          description: message.trim(),
        });
      }

      // Path 2 — Media with NO caption: start or extend a capture.
      if (!capture) {
        await captures.createCapture({
          phone,
          mediaItem: { url: media.url, contentType: media.contentType },
        }).catch((err) => { throw new Error(`createCapture: ${err.message}`); });
        return sendMessage(fromWa,
          `📸 Got the ${mediaWord} boss — tell me about the job. Voice note or text works.\n\n` +
          `The bits that help the post show up in Google:\n` +
          `• *Where was it?* Cairns suburb (Trinity Beach, Edge Hill, Smithfield…)\n` +
          `• *What kind of place* — Queenslander, fibro cottage, commercial fit-out, roof job?\n` +
          `• *What was tricky or special* — heritage timber, salt damage, big colour change, etc.\n` +
          `• *Products/gear used* — paints, primers, sprayers\n\n` +
          `Keep sending more photos if you've got them — I'll bundle the lot into one post.`
        );
      }

      if (capture.status === "awaiting_description") {
        // Silent append for multi-photo batches — the initial prompt already
        // told Adrian we're collecting. On channels with a synchronous reply
        // loop (web chat) we send a brief ack so it never looks broken.
        await captures.appendMediaToCapture(capture.id, {
          url: media.url, contentType: media.contentType,
        });
        const ctx = channelCtx.getStore();
        if (ctx) {
          const updated = await captures.getActiveCapture(phone);
          const n = updated?.media_items?.length || 1;
          return sendMessage(fromWa, `📸 Photo ${n} added — keep them coming, or describe the job when you're ready.`);
        }
        return;
      }

      // Path 3 — Media arriving AFTER preview committed: ask same/new ONCE.
      if (capture.status === "preview_pending") {
        // First arrival after the preview — ask. appendPendingMedia flips the
        // status to awaiting_same_or_new so subsequent media stay silent.
        await captures.appendPendingMedia(capture.id, {
          url: media.url, contentType: media.contentType,
        });
        return sendMessage(fromWa,
          `📸 Got another one — *same job as the last preview, or a new post?*\n\n` +
          `Reply *SAME* (add to the current draft) or *NEW* (start fresh).`
        );
      }
      if (capture.status === "awaiting_same_or_new") {
        // Already asked the same/new question — silently append while we wait.
        await captures.appendPendingMedia(capture.id, {
          url: media.url, contentType: media.contentType,
        });
        return;
      }
    }

    if (ct.startsWith("audio/")) {
      sendMessage(fromWa, "🎙️ Got your voice note — transcribing…").catch(() => {});
      const { transcribeTwilioAudio } = require("../lib/transcribe.js");
      // For non-Twilio channels (e.g. web), pre-fetch the buffer via the
      // channel context so transcribe.js doesn't try to parse a fake URL.
      const _audioCtx = channelCtx.getStore();
      const _audioBuf = _audioCtx?.downloadMedia ? await _audioCtx.downloadMedia(media.url) : null;
      const result = await transcribeTwilioAudio(media.url, media.contentType, _audioBuf);
      if (!result.ok) {
        return sendMessage(fromWa, `⚠️ Couldn't transcribe that voice note: ${result.error}`);
      }
      const transcribed = result.text;

      // Voice as a description for the active capture, if one's waiting.
      if (capture && capture.status === "awaiting_description") {
        return finaliseCapture(fromWa, capture, transcribed);
      }
      if (capture && capture.status === "awaiting_same_or_new") {
        return handleSameOrNew(fromWa, capture, transcribed);
      }
      // Voice as the discovery transcript for an active area-page build.
      if (areaPage && areaPage.status === "awaiting_voice_note") {
        return finaliseAreaPage(fromWa, areaPage, transcribed);
      }

      // Otherwise the normal strategist-chat path.
      const combined = message ? `${message}\n\n${transcribed}` : transcribed;
      return executeChat(fromWa, combined);
    }

    return sendMessage(fromWa,
      `🤔 Got a "${ct || "unknown"}" attachment. I can handle photos, videos, and voice notes — other types aren't supported.`);
  }

  // ── Text-only messages. If there's an active capture/area-page waiting, route. ─
  if (areaPage && message && message.trim() && areaPage.status === "awaiting_voice_note") {
    // Adrian replied with text instead of a voice note — treat as the transcript.
    return finaliseAreaPage(fromWa, areaPage, message.trim());
  }
  if (capture && message && message.trim()) {
    if (capture.status === "awaiting_description") {
      // Don't treat short greetings/single words as job descriptions
      const isGreeting = /^(hi|hey|hello|g'day|yo|sup|test|ok|okay|thanks|cheers|yep|nope|yes|no)[\s!?.]*$/i.test(message.trim());
      if (isGreeting) {
        return sendMessage(fromWa,
          `👋 Hey boss — you've got a photo waiting for a description. Tell me about the job (location, what was done, anything special) and I'll write it up.`
        );
      }
      return finaliseCapture(fromWa, capture, message.trim());
    }
    if (capture.status === "awaiting_same_or_new") {
      return handleSameOrNew(fromWa, capture, message.trim());
    }
    // EDIT: prefix — direct body replacement without re-running the AI.
    if (capture.status === "preview_pending" && /^EDIT:/i.test(message.trim())) {
      const newBody = message.trim().replace(/^EDIT:\s*/i, "").trim();
      if (newBody) return executeEditDraft(fromWa, capture, newBody);
    }
    // status === preview_pending: fall through. The user might be sending
    // YES/NO (handled by classifyIntent → routeIntent → handleApprove/Discard)
    // or a different command (slash, audit, etc.).
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
  // /new-area Bungalow  OR  /area Bungalow  → start the area-page builder
  if (/^\/?(new-area|area|new area|new page|build page)\b/i.test(message.trim())) {
    const suburb = message.trim().replace(/^\/?(new-area|area|new area|new page|build page)\s*(for\s+)?/i, "").trim();
    if (!suburb) {
      return sendMessage(fromWa, `👍 Tell me which suburb boss — try *"new area Bungalow"* or *"build me a page for Brinsmead"*.`);
    }
    return executeNewAreaPage(fromWa, phone, suburb);
  }
  // BUILD Bungalow  /  build Smithfield  — shortcut the bot's own prompt uses
  // after a post lands on the Cairns hub with no dedicated suburb page.
  if (/^\/?build\s+[a-z][a-z\s]{2,30}$/i.test(message.trim())) {
    const suburb = message.trim().replace(/^\/?build\s+/i, "").trim();
    return executeNewAreaPage(fromWa, phone, suburb);
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
    case "new_area_page":
      return executeNewAreaPage(fromWa, fromWa.replace(/^whatsapp:/, ""), intent.suburb);
    case "escalate":
      return executeEscalate(fromWa, intent.summary || intent._original_message || "");
    case "approve":
      return handleApprove(fromWa, intent._original_message);
    case "discard":
      return handleDiscard(fromWa, intent._original_message);
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
- new_area_page: user wants a fresh suburb/service-area page built. {"operation":"new_area_page","suburb":string}. Triggers: "build me a page for X", "new area X", "create a suburb page for X", "do a page for X". Extract the suburb name only.
- add_gallery_photo: not doable with text only. {"operation":"needs_image","message":string}
- update_text: change specific text on the site (hero copy, an FAQ answer, a button label, etc.). {"operation":"update_text","description":string}
- approve: user is confirming a pending change ("yes", "publish", "ship", "ok go", "yes please"). {"operation":"approve"}
- discard: user is cancelling a pending change ("no", "cancel", "discard", "nope", "scrap it"). {"operation":"discard"}
- escalate: user wants to speak to a human / is stuck and asking for help. {"operation":"escalate","summary":string}. Triggers: "get Nick", "call Nick", "need help", "speak to someone", "contact the agency", "I'm confused", "not sure what to do", "can you get someone". Extract a one-sentence summary of what they were trying to do.
- unknown: doesn't match any operation. {"operation":"unknown","reason":string}

Examples:
"change the phone to 0412 345 678" → {"operation":"update_business_info","field":"phone","value":"0412 345 678"}
"YES" → {"operation":"approve"}
"yes publish it" → {"operation":"approve"}
"nope cancel that" → {"operation":"discard"}
"add a blog post about prepping a Queenslander" → {"operation":"add_blog_post","title":"Prepping a Queenslander for an exterior repaint","body_markdown":"..."}
"build me a page for Bungalow" → {"operation":"new_area_page","suburb":"Bungalow"}
"do a suburb page for Brinsmead" → {"operation":"new_area_page","suburb":"Brinsmead"}
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

  await sendMessage(fromWa, `👍 On it boss — sorting the ${field} now…`);

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
  await sendMessage(fromWa, "🔍 On it chief — running the full check now, give me 30 secs or so…");
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
  await sendMessage(fromWa, "📊 On it boss — pulling your rankings now, give me a sec…");
  const { fetchRankings, formatRankingsMessages } = require("../lib/rankings.js");
  const r = await fetchRankings();
  for (const m of formatRankingsMessages(r)) {
    await sendMessage(fromWa, m);
  }
}

// ─── /semrush ─────────────────────────────────────────────────────────────

async function executeSemrush(fromWa) {
  await sendMessage(fromWa, "📊 Right-o chief — checking on that for you now, give me ~15 secs…");
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
  await sendMessage(fromWa, `🔎 On it boss — looking into "${phrase}" now, give me a min…`);
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
  await sendMessage(fromWa, "📊 On it chief — pulling this week's report for you now…");
  const today = new Date().toISOString().slice(0, 10);
  const url = `${SITE_BASE}/reports/cairns/${today}`;
  await sendMessage(fromWa,
    `📊 Friday digest — Cairns week ending ${today}.\n\n${url}\n\nReply with a question if you want me to dig into anything.`
  );
}

// ─── /sync — manually trigger Semrush → Supabase keyword sync ────────────

async function executeSyncKeywords(fromWa) {
  await sendMessage(fromWa, "📊 On it boss — syncing your rank tracking now, give me ~15 secs…");
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
  return sendMessage(fromWa, "🧹 All clear boss — fresh start. Send through whenever you're ready.");
}

// ─── chat (conversational strategist with retrieval + tools) ─────────────

async function executeEscalate(fromWa, summary) {
  const phone = fromWa.replace(/^whatsapp:/, "").replace(/^slack:/, "");
  const mention = SLACK_NOTIFY_USER_ID ? `<@${SLACK_NOTIFY_USER_ID}>` : "Nick";
  const slackText = `🆘 *Adrian needs a hand*\n${mention} — he's stuck and asked to be connected.\n\n*What he was trying to do:* ${summary}\n*His number:* ${phone}`;

  if (SLACK_NOTIFY_CHANNEL && SLACK_BOT_TOKEN) {
    await postSlackAlert(slackText);
    return sendMessage(fromWa, `Done — I've pinged Nick in Slack. He'll be in touch shortly. 👍`);
  } else {
    console.warn("executeEscalate: SLACK_NOTIFY_CHANNEL or SLACK_BOT_TOKEN not set");
    return sendMessage(fromWa, `I wasn't able to reach Nick right now — try calling him directly on 0416 168 991.`);
  }
}

async function postSlackAlert(text) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: SLACK_NOTIFY_CHANNEL, text }),
  });
  const data = await r.json();
  if (!data.ok) console.error("postSlackAlert failed:", data.error);
}

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
    // If the bot's reply signals uncertainty, offer escalation
    const uncertain = /not sure|can't help|unable to|don't know|outside.*scope|can't answer|not able to/i.test(reply);
    const suffix = uncertain && SLACK_NOTIFY_CHANNEL
      ? "\n\nNeed a hand? Just reply *get Nick* and I'll ping him now."
      : "";
    return sendMessage(fromWa, reply + suffix);
  } catch (err) {
    console.error("chat error:", err);
    return sendMessage(fromWa, `⚠️ ${truncate(String(err.message || err), 400)}`);
  }
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Friendlier thinking statuses — rotates so it doesn't get repetitive.
// Per locked rule: "boss" / "chief" are fine, "mate" is NOT.
const GENERIC_PICKUPS = [
  "👍 Okily dokily, give me a min boss…",
  "🫡 Got it chief, getting that now…",
  "🫡 On it boss, hang tight…",
  "👍 Nice, I'll get that for you now chief…",
  "🫡 Right-o boss, give us a sec…",
  "👍 Yep, on it chief — one moment…",
];

const RANK_PICKUPS = [
  "🔍 Right-o boss, pulling the live Google SERP from Cairns…",
  "🔍 Got it chief, checking page 1 of Google for you now…",
  "🔍 On it boss, fetching what Google's actually showing in Cairns…",
];

const GSC_PICKUPS = [
  "📈 Yep boss, grabbing your Search Console click data…",
  "📈 Got it chief, pulling Search Console for you now…",
  "📈 On it boss, checking what's bringing you traffic…",
];

const AI_PICKUPS = [
  "🤖 Right boss, checking AI Overviews and what ChatGPT's saying…",
  "🤖 On it chief, scanning AI search for you…",
  "🤖 Got it boss, checking the AI engines now…",
];

const COMPETITOR_PICKUPS = [
  "🔎 On it boss, checking who's in your patch…",
  "🔎 Right-o chief, sizing up the competition…",
  "🔎 Got it boss, pulling the competitive picture…",
];

function pickThinkingStatus(message) {
  const m = String(message).toLowerCase();
  // Action intents (add/remove/improve) come first — they don't query data,
  // they queue or write. Don't say "checking" for those.
  if (/(\b(add|track|watch|follow)\b.*\b(competitor|painter|business)\b|track\s+\w+\.(com|com\.au)|watch\s+\w+\.(com|com\.au))/.test(m)) {
    return "✏️ Queuing that with Nick now boss…";
  }
  if (/(\b(drop|remove|stop tracking)\b.*\b(competitor|painter)\b|stop\s+tracking)/.test(m)) {
    return "✏️ Queuing that removal for Nick chief…";
  }
  if (/^(yes|yep|yeah|go ahead|do it|please|sure|use those)\b/i.test(message.trim())) {
    return pickRandom(["🫡 On it boss…", "👍 Right-o chief…", "🫡 Got it boss…"]);
  }
  if (/improve report|change about the report|feedback on the report/.test(m)) {
    return "📝 Got it boss — let me ask a couple of quick questions about the report…";
  }

  // Data lookups — pick by topic, then rotate within category.
  if (/(rank|position|page\s*1|where am i|am i ranking|do i rank|live serp|google\s+result)/.test(m)) {
    return pickRandom(RANK_PICKUPS);
  }
  if (/(click|impression|gsc|search console|traffic|ctr|query|queries|landing page)/.test(m)) {
    return pickRandom(GSC_PICKUPS);
  }
  if (/(ai overview|aio|chatgpt|gemini|perplexity|claude|ai search|llm)/.test(m)) {
    return pickRandom(AI_PICKUPS);
  }
  if (/(competitor|beating|losing|against|who.s in front|share.*voice|sov)/.test(m)) {
    return pickRandom(COMPETITOR_PICKUPS);
  }
  if (/(review|rating|google review|gbp|business profile)/.test(m)) {
    return "📚 Right chief, checking the local-SEO playbook…";
  }
  if (/(remind|follow up|nudge)/.test(m)) {
    return "📝 Got it boss, setting that up…";
  }
  if (/(job|just (did|finished)|painted|customer)/.test(m)) {
    return "📝 Logging that one boss…";
  }
  return pickRandom(GENERIC_PICKUPS);
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

  await sendMessage(fromWa, `👍 On it chief — finding the right spot to change, give me ~15 secs…`);

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

  await sendMessage(fromWa, `✏️ On it boss — drafting "${truncate(title, 60)}" for you now, give me a min…`);

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

// ─── combined photo+job handler (entry point for image media) ────────────
//
// One handler, one preview, one approval. Adrian sends a photo with a
// caption — we classify whether the caption describes a job (not just a
// gallery item) and commit accordingly:
//   - gallery only: image + gallery.json (same as legacy flow)
//   - job:          image + gallery.json + locations.json (new recent_jobs
//                   entry with the photo path) + Supabase job row with
//                   pending_publish metadata. handleApprove fires GBP
//                   Slack ping on YES.

const PHOTO_JOB_CLASSIFIER_SYSTEM = `Extract fields from a caption that accompanies a paint-job photo. The caption may describe a job Adrian just completed (work piece, specific location) OR be a generic gallery upload. Reply with valid JSON only:

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
- is_job=TRUE when the caption describes a completed work piece in a specific location. Markers: "just finished", "just did", "completed", "done", "wrapped up", "finished today", or a clear suburb + work type ("Edge Hill exterior repaint").
- is_job=FALSE when the caption is generic ("team photo", "site overview", "warehouse interior shot").
- When in doubt AND a Cairns suburb is named: lean is_job=TRUE.

Suburb postcodes for gallery.postcode: Trinity Beach=4879, Holloways Beach=4878, Palm Cove=4879, Edge Hill=4870, Edmonton=4869, Cairns CBD=4870, Smithfield=4878, Portsmith=4870, Port Douglas=4877.

Infer gallery.category from clues if not explicit (interior/exterior/house/door = residential; shop/office/cafe/strata = commercial; warehouse/factory = industrial; roof = roof).`;

// Pick a sensible file extension from a Twilio mediaContentType.
function pickExt(contentType) {
  const ct = String(contentType || "").toLowerCase();
  // images
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  // video
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("quicktime") || ct.includes("mov")) return "mov";
  if (ct.includes("3gpp") || ct.includes("3gp")) return "3gp";
  if (ct.includes("webm")) return "webm";
  // default: jpg for image, mp4 for video
  if (ct.startsWith("video/")) return "mp4";
  return "jpg";
}

// ─── Capture-flow helpers ────────────────────────────────────────────────
//
// publishCairnsHubJob: shared pipeline used both for the direct caption-with-
//   media flow and for finalising a capture once Adrian has sent his
//   description. Writes the entry to _data/cairns_recent_jobs.json (the
//   /painter-cairns/ hub page). Multi-media: each item in mediaItems becomes
//   one entry in the post's `media: [...]` array.
// finaliseCapture: called when the description arrives for a capture in
//   awaiting_description state. Triggers the publish pipeline + draft preview.
// handleSameOrNew: called when more media arrived after the preview (capture
//   in awaiting_same_or_new). Detects SAME vs NEW from the reply and either
//   rebuilds the current preview with the new media folded in, or starts a
//   fresh capture seeded with the pending media.

async function publishCairnsHubJob({ fromWa, phone, mediaItems, description, captureId, replaceBranch }) {
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) {
    throw new Error("publishCairnsHubJob: no media");
  }
  if (!description || !String(description).trim()) {
    throw new Error("publishCairnsHubJob: no description");
  }

  await sendMessage(fromWa,
    `👍 On it boss — writing this up now, give me a min…`
  );

  // 1. Classify description for suburb + structured facts.
  const meta = await callAnthropic({
    model: "claude-haiku-4-5",
    max_tokens: 700,
    system: PHOTO_JOB_CLASSIFIER_SYSTEM,
    user: description,
    parseJson: true,
  });

  // 2. Decide which page this post belongs on.
  //    Registry: _data/suburb_pages.json — each entry maps a suburb to its
  //    dedicated page + data file. If the classifier-detected suburb has a
  //    dedicated page, route there. Otherwise fall back to the Cairns hub.
  const locFile = await ghGetContents("_data/locations.json", "main");
  const locations = JSON.parse(Buffer.from(locFile.content, "base64").toString("utf-8"));
  const norm = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "-");

  let suburbRegistry = [];
  try {
    const reg = await ghGetContents("_data/suburb_pages.json", "main");
    suburbRegistry = JSON.parse(Buffer.from(reg.content, "base64").toString("utf-8"));
    if (!Array.isArray(suburbRegistry)) suburbRegistry = [];
  } catch { suburbRegistry = []; }

  const detectedSlug = norm(meta.job?.suburb);
  const dedicated = detectedSlug
    ? suburbRegistry.find((s) => norm(s.slug) === detectedSlug || norm(s.name) === detectedSlug)
    : null;

  let targetPageUrl, targetDataFile, writingLocation, suburbCtx;
  if (dedicated) {
    // Detected suburb has its own page. Write the post there.
    targetPageUrl = dedicated.page_url;
    targetDataFile = dedicated.data_file;
    writingLocation = meta.job.suburb;
    // Build a minimal suburb context — use locations.json entry if it exists,
    // otherwise synthesise one from the registry.
    const locIdx = locations.findIndex((l) => norm(l.slug) === detectedSlug || norm(l.name) === detectedSlug);
    suburbCtx = locIdx !== -1
      ? locations[locIdx]
      : { name: dedicated.name, slug: dedicated.slug, postcode: dedicated.postcode || "", intro: "", common_jobs: "" };
  } else {
    // No dedicated page → Cairns hub. Keep sub-suburb in the writing.
    const cairnsIdx = locations.findIndex((l) => norm(l.slug) === "cairns-cbd" || norm(l.name) === "cairns-cbd");
    if (cairnsIdx === -1) throw new Error("publishCairnsHubJob: Cairns CBD suburb not found in locations.json");
    const cairns = locations[cairnsIdx];
    targetPageUrl = "/painter-cairns/";
    targetDataFile = "_data/cairns_recent_jobs.json";
    suburbCtx = cairns;
    const detectedDifferent = meta.job?.suburb && norm(meta.job.suburb) !== norm(cairns.name);
    writingLocation = detectedDifferent ? `${meta.job.suburb}, Cairns` : cairns.name;
  }

  // 3. Generate suburb-page entry + GBP draft.
  const { generateJobContent } = require("../lib/job-publisher.js");
  const jobContent = await generateJobContent({
    job: {
      suburb: writingLocation,
      summary: meta.job?.summary || `paint job in ${writingLocation}`,
      raw_transcript: description,
      structured_facts: {
        job_type: meta.job?.job_type,
        brands_used: meta.job?.brands_used,
        architectural_style: meta.job?.architectural_style,
      },
    },
    suburbCtx,
  });

  // 4. Fetch each Twilio media URL, allocate paths, build media array.
  const ts = Date.now();
  const fileSlug = slug(meta.job?.summary || jobContent.title || "job");
  const commitFiles = [];
  const mediaForEntry = [];
  for (let i = 0; i < mediaItems.length; i++) {
    const m = mediaItems[i];
    const ct = String(m.contentType || "").toLowerCase();
    const isVideo = ct.startsWith("video/");
    const ext = pickExt(ct);
    const dir = isVideo ? "assets/videos" : "assets/images";
    const suffix = mediaItems.length > 1 ? `-${i + 1}` : "";
    const path = `${dir}/work-${fileSlug}-${ts}${suffix}.${ext}`;
    const buf = await downloadTwilioMedia(m.url);
    commitFiles.push({ path, content: buf.toString("base64"), encoding: "base64" });
    mediaForEntry.push({
      type: isVideo ? "video" : "image",
      src: `/${path}`,
      alt: m.alt || (i === 0 ? jobContent.photo_alt : `${jobContent.title} (${i + 1})`),
    });
  }
  const primary = mediaForEntry[0];

  // 5. Read the target data file from main, prepend the entry, commit back.
  let existing;
  try {
    const f = await ghGetContents(targetDataFile, "main");
    existing = JSON.parse(Buffer.from(f.content, "base64").toString("utf-8"));
  } catch { existing = []; }
  if (!Array.isArray(existing)) existing = [];
  const today = new Date().toISOString().slice(0, 10);
  const recentJobEntry = {
    date: today,
    title: jobContent.title,
    body: jobContent.body,
    photo_alt: jobContent.photo_alt,
    media: mediaForEntry,
    ...(primary.type === "video" ? { video: primary.src } : { image: primary.src }),
  };
  const updated = [recentJobEntry, ...existing].slice(0, 30);
  commitFiles.push({
    path: targetDataFile,
    content: JSON.stringify(updated, null, 2) + "\n",
    encoding: "utf-8",
  });

  // 6. Atomic commit. If we're replacing an earlier draft (SAME flow), clean
  //    up the old branch after the new one is up.
  const branchTag = dedicated ? `suburb-${dedicated.slug}` : "cairnshub";
  const branch = `bot/${ts}-${branchTag}-${fileSlug}`.slice(0, 200);
  const sha = await ghCommitMulti({
    branch, baseRef: "main",
    message: `Bot: add job to ${targetPageUrl} — ${truncate(jobContent.title, 80)}`,
    files: commitFiles,
  });
  if (replaceBranch && replaceBranch !== branch) {
    try { await ghDeleteBranch(replaceBranch); } catch (err) {
      console.warn("[publishCairnsHubJob] couldn't delete replaceBranch:", err.message);
    }
  }

  // 7. Insert Supabase pending_publish row so handleApprove fires the GBP
  //    Slack ping on YES.
  try {
    const { client: supa } = require("../lib/supabase.js");
    const { data: client } = await supa()
      .from("clients").select("id, display_name").contains("allowed_phones", [phone]).maybeSingle();
    if (client?.id) {
      const liveMediaUrl = `${SITE_BASE}${primary.src}`;
      const livePageUrl = `${SITE_BASE}${targetPageUrl}`;
      await supa()
        .from("jobs").insert({
          client_id: client.id,
          captured_at: new Date().toISOString(),
          suburb: suburbCtx.name,
          summary: meta.job?.summary,
          raw_transcript: description,
          structured_facts: {
            job_type: meta.job?.job_type,
            brands_used: meta.job?.brands_used,
            architectural_style: meta.job?.architectural_style,
            media: mediaForEntry,
            pending_publish: {
              branch, sha,
              suburb_slug: suburbCtx.slug,
              suburb_name: suburbCtx.name,
              page_url: livePageUrl,
              gbp_text: jobContent.gbp_text,
              job_title: jobContent.title,
              photo_alt: jobContent.photo_alt,
              created_at: new Date().toISOString(),
              media_type: primary.type,
              primary_media_url: liveMediaUrl,
              media: mediaForEntry,
            },
          },
          status: "pending_approval",
        });
    }
  } catch (err) {
    console.warn("[publishCairnsHubJob] Supabase write failed:", err.message);
  }

  // 8. Preview message — keep it short + human. Mention the destination
  //    page so Adrian can see where it's going to land; if the detected
  //    suburb doesn't have a dedicated page yet, offer to build one.
  const targetLabel = dedicated
    ? `*${dedicated.name}* page (${targetPageUrl})`
    : `*Cairns* hub (${targetPageUrl})`;
  const detectedSuburb = meta.job?.suburb;
  const isCairnsCore = detectedSlug === "cairns-cbd" || detectedSlug === "cairns";
  const offerBuild = detectedSuburb && !dedicated && !isCairnsCore;
  const summary = `✅ Drafted boss — *${truncate(jobContent.title, 80)}*\n📍 Going on the ${targetLabel}`;
  await sendPreviewMessage(fromWa, {
    summary,
    buildOffer: offerBuild ? detectedSuburb : null,
  });

  return { branch, sha, entry: recentJobEntry, jobContent, meta };
}

async function finaliseCapture(fromWa, capture, description) {
  const captures = require("../lib/captures.js");
  await captures.setDescription(capture.id, description);
  try {
    const result = await publishCairnsHubJob({
      fromWa,
      phone: capture.phone,
      mediaItems: capture.media_items,
      description,
      captureId: capture.id,
    });
    await captures.setDraft(capture.id, {
      draft_branch: result.branch,
      draft_sha: result.sha,
      draft_target_page: "/painter-cairns/",
      draft_payload: result.entry,
    });
  } catch (err) {
    console.error("finaliseCapture failed:", err);
    await captures.markStatus(capture.id, "abandoned").catch(() => {});
    await sendMessage(fromWa, `⚠️ Couldn't draft the post: ${truncate(String(err.message || err), 200)}`);
  }
}

async function handleSameOrNew(fromWa, capture, reply) {
  const captures = require("../lib/captures.js");
  const r = String(reply || "").trim().toLowerCase();

  // Quick keyword pass.
  let decision = null;
  if (/\b(same|same job|continue|append|add to|together|with that|with the last|same one|previous)\b/.test(r)) decision = "same";
  else if (/\b(new|new post|different|separate|other|fresh|new job|different job)\b/.test(r)) decision = "new";

  // Ambiguous → quick Haiku classify.
  if (!decision) {
    try {
      const out = await callAnthropic({
        model: "claude-haiku-4-5",
        max_tokens: 30,
        system: `Did the user mean "same job" (extend the previous photo upload) or "new post" (different job)? Reply with EXACTLY one word: same | new | unclear`,
        user: reply,
      });
      const t = String(out || "").trim().toLowerCase();
      if (t.startsWith("same")) decision = "same";
      else if (t.startsWith("new")) decision = "new";
    } catch {}
  }

  if (!decision) {
    return sendMessage(fromWa,
      `🤔 Should I add these to the *same job* as the last preview, or treat them as a *new post*?\n\nReply SAME or NEW.`
    );
  }

  if (decision === "same") {
    await sendMessage(fromWa, "👍 Got it boss — pulling them all together now, give me a min…");
    const merged = await captures.moveSameJobMedia(capture.id);
    try {
      const result = await publishCairnsHubJob({
        fromWa,
        phone: capture.phone,
        mediaItems: merged.media_items,
        description: merged.description,
        captureId: capture.id,
        replaceBranch: capture.draft_branch,
      });
      await captures.setDraft(capture.id, {
        draft_branch: result.branch,
        draft_sha: result.sha,
        draft_target_page: "/painter-cairns/",
        draft_payload: result.entry,
      });
    } catch (err) {
      console.error("SAME rebuild failed:", err);
      await sendMessage(fromWa, `⚠️ Couldn't rebuild the preview: ${truncate(String(err.message || err), 200)}`);
    }
    return;
  }

  // NEW — fold the prior preview to "preview_pending" (Adrian can still YES it),
  // pull the pending media off, and start a brand-new capture seeded with them.
  await captures.markStatus(capture.id, "preview_pending");
  const newMedia = await captures.takePendingMediaForNewCapture(capture.id);
  const created = await captures.createCapture({
    phone: capture.phone,
    mediaItem: newMedia[0],
  });
  for (const m of newMedia.slice(1)) {
    await captures.appendMediaToCapture(created.id, m);
  }
  return sendMessage(fromWa,
    `🆕 Starting a fresh post with the new photos.\n\n` +
    `_(The earlier draft is still waiting — reply YES to publish it or NO to discard.)_\n\n` +
    `What was the job for these new photos?`
  );
}

// ─── Area-page builder ───────────────────────────────────────────────────
//
// Trigger: "build me a page for {suburb}", "/new-area {suburb}", or the
// intent classifier picking it up. Two-step flow:
//   1. executeNewAreaPage — creates pending_area_pages row + prompts Adrian
//      for a single discovery voice note.
//   2. finaliseAreaPage — runs Whisper transcript through Sonnet
//      (lib/area-generator.js), commits the .njk file to a bot/* branch,
//      stores preview_html_body for /api/preview, sends the preview link.
// YES merges the .njk to main; Vercel rebuild publishes /painter-{slug}/.

async function executeNewAreaPage(fromWa, phone, suburbInput) {
  const suburb = String(suburbInput || "").trim().replace(/[",.!?]+$/, "");
  if (!suburb) {
    return sendMessage(fromWa, `👍 Tell me which suburb boss — e.g. *"build me a page for Bungalow"*.`);
  }
  const suburbSlug = slug(suburb);
  const areaPages = require("../lib/area-pages.js");

  // Close any active area-page build first (one per phone).
  const existing = await areaPages.getActiveAreaPage(phone).catch(() => null);
  if (existing) await areaPages.markStatus(existing.id, "abandoned").catch(() => {});

  await areaPages.createAreaPage({ phone, suburb, suburbSlug });

  return sendMessage(fromWa,
    `👍 On it boss — I'll build the *${suburb}* page. Send me one voice note covering these bits (take your time, one note is fine):\n\n` +
    `• *What houses dominate ${suburb}?* Queenslander, fibro cottage, modern brick, mix?\n` +
    `• *Paint problems specific there?* Salt, mould, sun fade, render cracks…\n` +
    `• *Jobs you've done in ${suburb}* — quick rundown (or "none yet").\n` +
    `• *Anything tricky working there?* Parking, council rules, narrow lanes, hill access…\n` +
    `• *Nearby landmarks or features locals would recognise.*\n` +
    `• *Typical customer there* — homeowner, landlord, commercial, holiday rental?\n\n` +
    `Once you send the voice note I'll draft the page and ping you a preview.`
  );
}

async function finaliseAreaPage(fromWa, areaPage, transcript) {
  const areaPages = require("../lib/area-pages.js");
  await sendMessage(fromWa, `✍️ On it boss — drafting the *${areaPage.suburb}* page now, give me a min…`);

  try {
    await areaPages.setAreaPageTranscript(areaPage.id, transcript);
  } catch (err) {
    console.error("setAreaPageTranscript failed:", err);
  }

  let drafted;
  try {
    const { generateAreaPage } = require("../lib/area-generator.js");
    drafted = await generateAreaPage({ suburb: areaPage.suburb, transcript });
  } catch (err) {
    console.error("generateAreaPage failed:", err);
    await areaPages.markStatus(areaPage.id, "abandoned").catch(() => {});
    return sendMessage(fromWa,
      `⚠️ Couldn't draft the ${areaPage.suburb} page boss — give me a sec and try sending the voice note again.`
    );
  }

  // Commit the new .njk file to a bot/* branch.
  const ts = Date.now();
  const branch = `bot/${ts}-areapage-${drafted.suburb_slug}`.slice(0, 200);
  let sha;
  try {
    sha = await ghCommitMulti({
      branch, baseRef: "main",
      message: `Bot: add area page for ${areaPage.suburb}`,
      files: [
        { path: drafted.njk_filename, content: drafted.njk_content, encoding: "utf-8" },
      ],
    });
  } catch (err) {
    console.error("ghCommitMulti area page failed:", err);
    await areaPages.markStatus(areaPage.id, "abandoned").catch(() => {});
    return sendMessage(fromWa,
      `⚠️ Couldn't save the ${areaPage.suburb} draft boss — try again in a sec.`
    );
  }

  await areaPages.setAreaPageDraft(areaPage.id, {
    njk_filename: drafted.njk_filename,
    njk_content: drafted.njk_content,
    preview_html_body: drafted.preview_html_body,
    draft_branch: branch,
    draft_sha: sha,
  }).catch((err) => console.warn("setAreaPageDraft warn:", err.message));

  await sendMessage(fromWa,
    `✅ Drafted boss — *${drafted.title}*\n\n` +
    `🌐 Preview: ${SITE_BASE}/preview\n\n` +
    `Reply YES to publish, NO to bin it.`
  );
}

async function executeAddPhotoJob(fromWa, caption, media) {
  const ct = String(media?.contentType || "").toLowerCase();
  const isVideo = ct.startsWith("video/");
  const mediaWord = isVideo ? "video" : "photo";

  if (!caption) {
    return sendMessage(fromWa,
      `🤖 Got the ${mediaWord} but no caption. Tap the ${mediaWord} before sending and add a caption like:\n\n` +
      "• \"Just finished a Queenslander exterior in Edge Hill — Dulux Weathershield deep navy\"\n" +
      "• \"Commercial fit-out, Cairns CBD\"\n\n" +
      `Then send again. If you mention the suburb I'll add it to that area page automatically.${isVideo ? "\n\nVideos need a job context (suburb + work description) — they go on the suburb page, not the gallery." : ""}`
    );
  }
  if (!media?.url) throw new Error("executeAddPhotoJob: missing media URL");

  await sendMessage(fromWa, `🤖 Got the ${mediaWord}. Reading the caption…`);

  // 1. Single classifier+extractor call.
  const meta = await callAnthropic({
    model: "claude-haiku-4-5",
    max_tokens: 700,
    system: PHOTO_JOB_CLASSIFIER_SYSTEM,
    user: caption,
    parseJson: true,
  });

  // ── Video gating: video MUST be a job with a known suburb. There is no
  //    gallery flow for video.
  if (isVideo) {
    if (!meta.is_job || !meta.job?.suburb) {
      return sendMessage(fromWa,
        `🎥 I can only post videos to a suburb page right now — I need a caption that names the suburb and what the job was.\n\n` +
        "Example: *\"Just wrapped Trinity Beach exterior — Dulux Weathershield deep navy on the weatherboards\"*\n\n" +
        "Resend the video with that kind of caption and I'll handle it from there."
      );
    }
  }

  // 2. Download the media once.
  const mediaBuf = await downloadTwilioMedia(media.url);
  const ext = pickExt(ct);
  const ts = Date.now();
  const fileSlug = slug(meta.gallery?.title || meta.job?.summary || mediaWord);
  const assetDir = isVideo ? "assets/videos" : "assets/images";
  const mediaPath = `${assetDir}/work-${fileSlug}-${ts}.${ext}`;

  // 3. Gallery entry — only for images. Video skips the gallery.
  let gallery, galleryItem;
  if (!isVideo) {
    const galleryFile = await ghGetContents("_data/gallery.json", "main");
    gallery = JSON.parse(Buffer.from(galleryFile.content, "base64").toString("utf-8"));
    galleryItem = {
      image: `/${mediaPath}`,
      alt: meta.gallery?.title || meta.job?.summary || "Paint job",
      title: meta.gallery?.title || meta.job?.summary || "Paint job",
      category: meta.gallery?.category || (meta.job?.job_type?.includes("commercial") ? "commercial" : "residential"),
      location: meta.gallery?.location || meta.job?.suburb || "",
      postcode: meta.gallery?.postcode || "",
      note: meta.gallery?.note || "",
    };
    gallery.unshift(galleryItem);
  }

  // 4. If job — match suburb, generate suburb-page entry, update locations.
  let locations, suburb, jobContent;
  if (meta.is_job && meta.job?.suburb) {
    const locFile = await ghGetContents("_data/locations.json", "main");
    locations = JSON.parse(Buffer.from(locFile.content, "base64").toString("utf-8"));
    const norm = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "-");
    const wantedSlug = norm(meta.job.suburb);
    const suburbIdx = locations.findIndex(
      (l) => norm(l.name) === wantedSlug || norm(l.slug) === wantedSlug
    );
    if (suburbIdx !== -1) {
      suburb = locations[suburbIdx];
      const { generateJobContent } = require("../lib/job-publisher.js");
      try {
        jobContent = await generateJobContent({
          job: {
            suburb: suburb.name,
            summary: meta.job.summary,
            raw_transcript: caption,
            structured_facts: {
              job_type: meta.job.job_type,
              brands_used: meta.job.brands_used,
              architectural_style: meta.job.architectural_style,
            },
          },
          suburbCtx: suburb,
        });
        const today = new Date().toISOString().slice(0, 10);
        const recentJobEntry = {
          date: today,
          title: jobContent.title,
          body: jobContent.body,
          photo_alt: jobContent.photo_alt,
        };
        if (isVideo) recentJobEntry.video = `/${mediaPath}`;
        else        recentJobEntry.image = `/${mediaPath}`;
        const current = Array.isArray(suburb.recent_jobs) ? suburb.recent_jobs : [];
        suburb.recent_jobs = [recentJobEntry, ...current].slice(0, 6);
        locations[suburbIdx] = suburb;
      } catch (err) {
        console.warn("[photojob] generateJobContent failed:", err.message);
        if (isVideo) {
          // Without job content there's nothing to put on the suburb page
          // and video has no gallery fallback. Bail out cleanly.
          return sendMessage(fromWa, `⚠️ Couldn't draft the suburb page entry for that video: ${truncate(String(err.message || err), 120)}. Nothing has been committed.`);
        }
        suburb = null; // fall back to gallery-only commit (image only)
      }
    } else if (isVideo) {
      // Video + unknown suburb → bail out cleanly. Nothing committed.
      return sendMessage(fromWa,
        `📍 Caption mentioned "${meta.job.suburb}" but that doesn't match a known suburb on the site. Resend with one of the existing suburbs (Edge Hill, Trinity Beach, Palm Cove, Holloways Beach, Cairns CBD, Edmonton, Port Douglas) or ask Nick to add the new one.`
      );
    } else {
      // Image + unknown suburb → fall back to gallery-only.
      await sendMessage(fromWa,
        `📍 Caption mentioned "${meta.job.suburb}" but that doesn't match a known suburb on the site. Saving to the gallery only — Nick can add the suburb to /_data/locations.json if you want a page for it.`
      ).catch(() => {});
    }
  } else if (isVideo) {
    // Defensive — already gated above, but guard against a Sonnet flip.
    return sendMessage(fromWa, "🎥 Videos need a job caption with a suburb. Resend with that and I'll handle it.");
  }

  // 5. Atomic commit — media binary + (image only) gallery.json + (if job)
  //    locations.json.
  const branch = `bot/${ts}-${suburb ? `${isVideo ? "videojob" : "job"}-${suburb.slug}` : `gallery-${fileSlug}`}`.slice(0, 200);
  const files = [
    { path: mediaPath, content: mediaBuf.toString("base64"), encoding: "base64" },
  ];
  if (!isVideo && gallery) {
    files.push({ path: "_data/gallery.json", content: JSON.stringify(gallery, null, 2) + "\n", encoding: "utf-8" });
  }
  if (suburb) {
    files.push({ path: "_data/locations.json", content: JSON.stringify(locations, null, 2) + "\n", encoding: "utf-8" });
  }
  const commitMsg = suburb
    ? `Bot: add ${isVideo ? "video" : "photo"} job in ${suburb.name}${galleryItem ? ` + gallery photo "${truncate(galleryItem.title, 60)}"` : ""}`
    : `Bot: add gallery photo "${truncate(galleryItem.title, 60)}"`;
  const sha = await ghCommitMulti({
    branch, baseRef: "main", message: commitMsg, files,
  });

  // 6. If job — insert Supabase row with pending_publish metadata so
  //    handleApprove fires the GBP Slack ping on YES.
  if (suburb && jobContent) {
    try {
      const { client: supa } = require("../lib/supabase.js");
      const phone = fromWa.replace(/^whatsapp:/, "");
      const { data: client } = await supa()
        .from("clients").select("id").contains("allowed_phones", [phone]).maybeSingle();
      if (client?.id) {
        const liveMediaUrl = `${SITE_BASE}/${mediaPath}`;
        const pending_publish = {
          branch,
          sha,
          suburb_slug: suburb.slug,
          suburb_name: suburb.name,
          gbp_text: jobContent.gbp_text,
          job_title: jobContent.title,
          photo_alt: jobContent.photo_alt,
          created_at: new Date().toISOString(),
          media_type: isVideo ? "video" : "image",
        };
        if (isVideo) pending_publish.video_url = liveMediaUrl;
        else         pending_publish.image_url = liveMediaUrl;

        await supa()
          .from("jobs")
          .insert({
            client_id: client.id,
            captured_at: new Date().toISOString(),
            suburb: suburb.name,
            summary: meta.job.summary,
            raw_transcript: caption,
            structured_facts: {
              job_type: meta.job.job_type,
              brands_used: meta.job.brands_used,
              architectural_style: meta.job.architectural_style,
              ...(isVideo ? { video_url: `/${mediaPath}` } : { image_url: `/${mediaPath}` }),
              pending_publish,
            },
            status: "pending_approval",
          });
      }
    } catch (err) {
      console.warn("[photojob] Supabase write failed:", err.message);
    }
  }

  // 7. Send preview message.
  const summary = suburb
    ? `✅ Drafted boss — *${truncate(jobContent.title, 80)}*`
    : `✅ Added to the gallery boss — *${truncate(galleryItem.title, 70)}*`;
  await sendPreviewMessage(fromWa, { summary });
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
  // Branch name suffix encodes Date.now() — drop anything older than 24h so a
  // stale draft from days ago can't get accidentally merged when the user
  // says YES to a more recent conversational context.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = bot.filter((b) => {
    const m = b.name.match(/^bot\/(\d{10,})-/);
    return m ? Number(m[1]) >= cutoff : true;
  });
  if (!recent.length) return null;
  recent.sort((a, b) => b.name.localeCompare(a.name));
  return recent[0].name;
}

// Look up the job (if any) whose pending_publish.branch matches the given
// branch. Used by handleApprove/handleDiscard to fire the GBP Slack ping
// after a job-publish branch merges.
async function findJobByPendingBranch(branch) {
  try {
    const { client: supa, getClientByPhone } = require("../lib/supabase.js");
    const { data } = await supa()
      .from("jobs")
      .select("id, suburb, summary, structured_facts, client_id")
      .eq("status", "pending_approval")
      .limit(50);
    if (!data?.length) return null;
    return data.find((j) => j.structured_facts?.pending_publish?.branch === branch) || null;
  } catch (err) {
    console.warn("findJobByPendingBranch error:", err.message || err);
    return null;
  }
}

async function clearJobPendingPublish(jobId, finalStatus) {
  try {
    const { client: supa } = require("../lib/supabase.js");
    const { data: row } = await supa()
      .from("jobs")
      .select("structured_facts")
      .eq("id", jobId)
      .maybeSingle();
    const facts = { ...(row?.structured_facts || {}) };
    delete facts.pending_publish;
    await supa().from("jobs").update({ status: finalStatus, structured_facts: facts }).eq("id", jobId);
  } catch (err) {
    console.warn("clearJobPendingPublish error:", err.message || err);
  }
}

// Direct body edit — updates _data/cairns_recent_jobs.json on the draft
// branch in-place without re-running the AI. Called when the user sends
// "EDIT: <new body>" while a capture is in preview_pending status.
async function executeEditDraft(fromWa, capture, newBody) {
  const captures = require("../lib/captures.js");
  const branch = capture.draft_branch;
  if (!branch) {
    return sendMessage(fromWa, "⚠️ No draft branch found — try sending the photo again.");
  }
  await sendMessage(fromWa, "✏️ Updating the post now…");
  try {
    // Read the current data file from the draft branch.
    const file = await ghGetContents("_data/cairns_recent_jobs.json", branch);
    const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf-8"));
    if (!Array.isArray(data) || !data[0]) throw new Error("Entry not found in draft");

    // Swap the body, leave everything else untouched.
    data[0].body = newBody;
    const updatedContent = Buffer.from(JSON.stringify(data, null, 2), "utf-8").toString("base64");

    // Commit the updated file back onto the same branch.
    await ghJson("PUT", `/repos/${GITHUB_REPO}/contents/${encodeURIComponent("_data/cairns_recent_jobs.json")}`, {
      message: "edit: update post body",
      content: updatedContent,
      branch,
      sha: file.sha,
    });

    // Keep draft_payload in sync so the GET /chat-web?draft=1 endpoint stays fresh.
    const payload = { ...(capture.draft_payload || {}), body: newBody };
    await captures.setDraft(capture.id, {
      draft_branch: capture.draft_branch,
      draft_sha: capture.draft_sha,
      draft_target_page: capture.draft_target_page,
      draft_payload: payload,
    });

    return sendMessage(fromWa,
      `✅ Done boss — post updated.\n\n` +
      `🌐 Preview: ${SITE_BASE}/preview\n\n` +
      `Reply YES to publish, NO to bin it.`
    );
  } catch (err) {
    console.error("executeEditDraft failed:", err);
    return sendMessage(fromWa, `⚠️ Couldn't update the draft: ${err.message?.slice(0, 120)}`);
  }
}

async function handleApprove(fromWa, originalMessage) {
  const phone = fromWa.replace(/^whatsapp:/, "");
  const captures = require("../lib/captures.js");
  const branch = await findLatestBotBranch();
  if (!branch) {
    // Also clean up any orphan captures sitting in preview_pending for this
    // phone — they'd just confuse the next interaction.
    const orphan = await captures.getActiveCapture(phone).catch(() => null);
    if (orphan) await captures.markStatus(orphan.id, "abandoned").catch(() => {});
    // Nothing to publish — likely the user said "yes" in answer to a
    // strategist question. Hand off to chat so the conversation context
    // carries through. Strategist will gracefully ask "yes to what?" if
    // there's no thread to pick up.
    if (originalMessage) return executeChat(fromWa, originalMessage);
    return sendMessage(fromWa, "🤔 Nothing waiting to publish boss — send me a photo or change first.");
  }

  await sendMessage(fromWa, `🚀 On it boss — pushing that live now…`);
  try {
    await ghMergeToMain(branch);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/409|merge conflict/i.test(msg)) {
      try { await ghDeleteBranch(branch); } catch {}
      const job = await findJobByPendingBranch(branch);
      if (job) await clearJobPendingPublish(job.id, "discarded");
      const cap = await captures.getActiveCapture(phone).catch(() => null);
      if (cap) await captures.markStatus(cap.id, "abandoned").catch(() => {});
      return sendMessage(fromWa,
        "🤔 Couldn't push that one through boss — the site's moved on since the draft was made, so it doesn't slot in cleanly anymore. " +
        "I've scrapped that draft. Send the photo again and I'll start a fresh one."
      );
    }
    console.error("ghMergeToMain failed:", err);
    return sendMessage(fromWa,
      "⚠️ Hit a snag pushing that live boss — I've left the draft alone, give me a sec and try YES again. If it keeps failing, message me what happened."
    );
  }
  await ghDeleteBranch(branch);
  // Merge succeeded — clean up the active capture + area-page rows.
  const cap = await captures.getActiveCapture(phone).catch(() => null);
  if (cap) await captures.markStatus(cap.id, "completed").catch(() => {});
  const areaPages = require("../lib/area-pages.js");
  const ap = await areaPages.getActiveAreaPage(phone).catch(() => null);
  if (ap && ap.draft_branch === branch) {
    await areaPages.markStatus(ap.id, "completed").catch(() => {});
    const liveUrl = `${SITE_BASE}/painter-${ap.suburb_slug}/`;
    return sendMessage(fromWa,
      `🎉 ${ap.suburb} page is live in about a minute boss — that's done.\n\n` +
      `If you want to see the live version it's here — ${liveUrl}`
    );
  }

  // If this branch was a job publish, fire the GBP Slack ping for Nick.
  const job = await findJobByPendingBranch(branch);
  if (job) {
    const pp = job.structured_facts.pending_publish;
    try {
      const { client: supa } = require("../lib/supabase.js");
      const { data: client } = await supa()
        .from("clients").select("display_name")
        .eq("id", job.client_id).maybeSingle();
      const { notifyGbpPost } = require("../lib/slack.js");
      const previewUrl = pp.page_url
        || `${SITE_BASE}/areas/${pp.suburb_slug}/`;
      await notifyGbpPost({
        clientName: client?.display_name || "client",
        suburb: pp.suburb_name || pp.suburb_slug,
        jobTitle: pp.job_title,
        gbpText: pp.gbp_text,
        previewUrl,
        imageUrl: pp.image_url,
        videoUrl: pp.video_url,
        photoAlt: pp.photo_alt,
        mediaType: pp.media_type || (pp.video_url ? "video" : "image"),
      });
      await clearJobPendingPublish(job.id, "published");
      // Record the publish as a behaviour event for the bot's KB.
      try {
        const { recordJobPublished } = require("../lib/behaviour-kb.js");
        recordJobPublished({
          clientId: job.client_id,
          jobId: job.id,
          jobTitle: pp.job_title,
          suburb: pp.suburb_name || pp.suburb_slug,
          jobType: job.structured_facts?.job_type,
          products: job.structured_facts?.brands_used,
          pagePath: pp.page_url,
          mediaType: pp.media_type || (pp.video_url ? "video" : "image"),
        }).catch(() => {});
      } catch {}
      const liveUrl = pp.page_url || `${SITE_BASE}/painter-cairns/`;
      return sendMessage(fromWa,
        `🎉 Live in about a minute boss — that's done.\n\n` +
        `If you want to see the live version it's here — ${liveUrl}`
      );
    } catch (err) {
      console.error("GBP Slack post failed:", err);
      await clearJobPendingPublish(job.id, "published");
      const liveUrl = pp.page_url || `${SITE_BASE}/painter-cairns/`;
      return sendMessage(fromWa,
        `🎉 Live in about a minute boss — that's done.\n\n` +
        `If you want to see the live version it's here — ${liveUrl}`
      );
    }
  }

  return sendMessage(fromWa,
    `🎉 Live in about a minute boss — that's done.\n\n` +
    `If you want to see the live version it's here — ${SITE_BASE}/painter-cairns/`
  );
}

async function handleDiscard(fromWa, originalMessage) {
  const phone = fromWa.replace(/^whatsapp:/, "");
  const captures = require("../lib/captures.js");
  const branch = await findLatestBotBranch();
  if (!branch) {
    // Clean up any orphan captures even if no branch exists.
    const orphan = await captures.getActiveCapture(phone).catch(() => null);
    if (orphan) await captures.markStatus(orphan.id, "abandoned").catch(() => {});
    // Nothing to discard — likely "no" was the answer to a strategist
    // question. Route to chat so the context is preserved.
    if (originalMessage) return executeChat(fromWa, originalMessage);
    return sendMessage(fromWa, "🤔 Nothing waiting to discard boss.");
  }
  await ghDeleteBranch(branch);

  // Clear the legacy job row, the capture row, and any area-page row all.
  const job = await findJobByPendingBranch(branch);
  if (job) {
    await clearJobPendingPublish(job.id, "discarded");
    // Record the rejection as a behaviour event for the bot's KB.
    try {
      const pp = job.structured_facts?.pending_publish || {};
      const { recordJobRejected } = require("../lib/behaviour-kb.js");
      recordJobRejected({
        clientId: job.client_id,
        jobId: job.id,
        jobTitle: pp.job_title,
        suburb: pp.suburb_name || pp.suburb_slug,
        jobType: job.structured_facts?.job_type,
        products: job.structured_facts?.brands_used,
      }).catch(() => {});
    } catch {}
  }
  const cap = await captures.getActiveCapture(phone).catch(() => null);
  if (cap) await captures.markStatus(cap.id, "abandoned").catch(() => {});
  const areaPages = require("../lib/area-pages.js");
  const ap = await areaPages.getActiveAreaPage(phone).catch(() => null);
  if (ap) await areaPages.markStatus(ap.id, "abandoned").catch(() => {});

  await sendMessage(fromWa, `🗑 Binned that draft boss.`);
}

async function sendPreviewMessage(fromWa, { summary, buildOffer }) {
  // Single, clean message — no commit URLs, no build-wait, no jargon.
  // Preview is rendered on-demand by /api/preview from the latest bot/*
  // branch, so the URL is stable and works the instant the commit lands.
  let msg = `${summary}\n\n` +
    `🌐 Preview: ${SITE_BASE}/preview\n\n` +
    `Reply YES to publish, NO to bin it.`;
  if (buildOffer) {
    msg += `\n\n_${buildOffer} doesn't have its own page yet — reply *BUILD ${buildOffer.toUpperCase()}* if you want me to make one (takes a few mins, I'll ask you a quick voice note about the suburb)._`;
  }
  await sendMessage(fromWa, msg);
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
  const ctx = channelCtx.getStore();
  if (ctx?.sendMessage) return ctx.sendMessage(toWa, text);

  // Log outbound — fire-and-forget
  require("../lib/message-log.js").logOutbound(toWa, text).catch(() => {});

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const isWhatsApp = TWILIO_FROM.startsWith("whatsapp:");
  const To = isWhatsApp
    ? (toWa.startsWith("whatsapp:") ? toWa : `whatsapp:${toWa}`)
    : toWa.replace(/^whatsapp:/, "");
  const body = new URLSearchParams({
    From: TWILIO_FROM,
    To,
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
// Also handles data: URIs (web chat uploads stored inline in pending_captures).
async function downloadTwilioMedia(url) {
  // Data URIs are self-contained — decode directly without any network call.
  if (url && url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) throw new Error("Invalid data URI");
    return Buffer.from(url.slice(comma + 1), "base64");
  }

  const ctx = channelCtx.getStore();
  if (ctx?.downloadMedia) return ctx.downloadMedia(url);

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

// Allows other channel handlers (e.g. api/slack.js) to run handleMessage
// with their own sendMessage/downloadMedia implementations injected via
// AsyncLocalStorage, without modifying any execute* functions.
module.exports.runWithContext = function runWithContext(fromId, message, media, ctx) {
  return channelCtx.run(ctx, () => handleMessage(fromId, message, media));
};
