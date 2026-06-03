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
  const verb = action === "add" ? "added" : action === "remove" ? "removed" : "requested";
  const text = `*${clientName}*: Adrian ${verb} a competitor — *${name}* (${domain}). Whitelist now ${currentCount}/${cap}.`;
  return postToSlack({ text });
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
  notifyCompetitorChange,
  notifyReportFeedback,
};
