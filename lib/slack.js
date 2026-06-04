// Minimal Slack-webhook poster for "owner-facing" notifications:
// changes Adrian requests, feedback on reports, anything Nick should know
// without Adrian having to chase him.
//
// Configuration: set SLACK_WEBHOOK_URL in Vercel env.
// Behaviour: graceful no-op if env is missing or the post fails — Slack
// notifications are best-effort, never block the bot's reply path.

async function postToSlack({ text, blocks, channel }) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.warn("[slack] SLACK_WEBHOOK_URL not set — skipping notification");
    return { skipped: true, reason: "no webhook configured" };
  }
  if (!text && !blocks) {
    return { skipped: true, reason: "no payload" };
  }
  try {
    const body = { text };
    if (blocks) body.blocks = blocks;
    if (channel) body.channel = channel;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.warn(`[slack] webhook ${r.status}: ${detail.slice(0, 200)}`);
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[slack] post failed: ${err?.message || err}`);
    return { ok: false, error: String(err?.message || err) };
  }
}

// Convenience wrappers for the two flows we use right now.

function notifyCompetitorChange({ clientName, action, name, domain, currentCount, cap }) {
  // Legacy auto-add path — kept in case anything calls it. Prefer
  // notifyCompetitorRequest for the new queue-and-notify flow.
  const verb = action === "add" ? "added" : action === "remove" ? "removed" : "requested";
  const text = `*${clientName}*: Adrian ${verb} a competitor — *${name}* (${domain}). Whitelist now ${currentCount}/${cap}.`;
  return postToSlack({ text });
}

// Queue-and-notify flow (preferred): bot tells Adrian the change is queued,
// Slack ping tells Nick to do it manually within 24 hours.
function notifyCompetitorRequest({ clientName, action, name, domain, requestedBy }) {
  const verb = action === "add" ? "wants ADDED" : "wants REMOVED";
  const lines = [
    `🛠️  *${clientName}* — competitor request (${action})`,
    `Adrian ${verb}: *${name}*`,
    domain && domain !== name ? `Domain: ${domain}` : null,
    requestedBy ? `_via WhatsApp from ${requestedBy}_` : null,
    `_Action needed: add/remove in Semrush Position Tracking + Supabase \`competitors\` table within 24h._`,
  ].filter(Boolean);
  return postToSlack({ text: lines.join("\n") });
}

// Queue a GBP post for Nick to publish manually (24h SLA). Google's API
// doesn't allow programmatic posting to Business Profile, so this is the
// pragmatic loop: bot drafts, Nick copy-pastes into the GBP UI.
function notifyGbpPost({ clientName, suburb, jobTitle, gbpText, previewUrl, imageUrl, videoUrl, photoAlt, mediaType }) {
  // GBP supports both photo and short-video posts. Slack's Block Kit can
  // inline-render images but not video — for video we provide the URL with
  // a clear "download → upload to GBP" instruction.
  const isVideo = mediaType === "video" || (!imageUrl && !!videoUrl);
  const mediaLabel = isVideo ? "Video" : "Photo";
  const summaryLines = [
    `📍 *${clientName}* — new GBP post ready to publish (${suburb})`,
    "",
    "*Draft text:*",
    "```",
    gbpText,
    "```",
    jobTitle ? `_Job: ${jobTitle}_` : null,
    previewUrl ? `_Web entry now live: ${previewUrl}_` : null,
    isVideo && videoUrl
      ? `*🎥 ${mediaLabel}*: ${videoUrl}\n_(GBP supports video posts up to 30 seconds. Download from the link above and upload to GBP manually.)_`
      : (imageUrl ? `_${mediaLabel}: ${imageUrl}_` : null),
    "",
    `_Action needed: paste into Google Business Profile within 24h. Attach the ${mediaLabel.toLowerCase()}${isVideo ? " (download from URL above)" : " below"}._`,
  ].filter(Boolean);
  const text = summaryLines.join("\n");

  // No media → text-only ping.
  if (!imageUrl && !videoUrl) return postToSlack({ text });

  // Video → text only (Slack can't inline-render video). The URL is in the
  // message text so Nick can click to download.
  if (isVideo) return postToSlack({ text });

  // Image → inline render via Block Kit image block.
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "image",
      image_url: imageUrl,
      alt_text: photoAlt || jobTitle || "Job photo",
    },
  ];
  return postToSlack({ text, blocks });
}

function notifyReportFeedback({ clientName, feedback }) {
  const lines = [`*${clientName}*: Adrian submitted feedback on the weekly report.`];
  if (feedback.wants_more_of)    lines.push(`*Wants more of:* ${feedback.wants_more_of}`);
  if (feedback.wants_less_of)    lines.push(`*Wants less of:* ${feedback.wants_less_of}`);
  if (feedback.other_changes)    lines.push(`*Other changes:* ${feedback.other_changes}`);
  if (feedback.raw_transcript)   lines.push(`> ${feedback.raw_transcript.slice(0, 400)}`);
  return postToSlack({ text: lines.join("\n") });
}

module.exports = {
  postToSlack,
  notifyCompetitorChange,    // legacy
  notifyCompetitorRequest,   // preferred (queue + 24h SLA)
  notifyReportFeedback,
  notifyGbpPost,
};
