// Vercel cron — merges any pending bot/* branches into main daily, so
// content the WhatsApp bot writes to its own branch actually goes live
// instead of sitting unmerged. Pushing to main triggers Vercel's existing
// GitHub integration to redeploy production automatically, no separate
// deploy call needed here.
//
// Schedule: vercel.json crons → "10 17 * * *" (17:10 UTC = 3:10am AEST,
// ahead of the daily backup so a same-day merge is captured in that backup).
//
// Env vars:
//   GITHUB_TOKEN, GITHUB_REPO — merge via the GitHub REST API
//   SLACK_WEBHOOK_URL         — merge/conflict/error summary
//   CRON_SECRET               — Vercel auto-sets for cron auth

const { ghJson, GITHUB_REPO } = require("../lib/github-bot.js");
const { postToSlack } = require("../lib/slack.js");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

async function listBotBranches() {
  const branches = await ghJson("GET", `/repos/${GITHUB_REPO}/branches?per_page=100`);
  return branches.filter((b) => b.name.startsWith("bot/")).map((b) => b.name);
}

async function mergeBranch(branch) {
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/merges`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mrpaint-bot",
    },
    body: JSON.stringify({
      base: "main",
      head: branch,
      commit_message: `Auto-merge ${branch} into main (daily cron)`,
    }),
  });

  if (r.status === 204) return { branch, status: "already-merged" };

  if (r.status === 201) {
    const result = await r.json();
    // Tidy up — delete the now-merged branch. Best-effort, not fatal if it fails.
    await ghJson("DELETE", `/repos/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`).catch(() => {});
    return { branch, status: "merged", sha: result.sha };
  }

  if (r.status === 409) return { branch, status: "conflict" };

  const text = await r.text().catch(() => "");
  return { branch, status: "error", error: `${r.status}: ${text.slice(0, 200)}` };
}

module.exports = async function handler(req, res) {
  const auth = req.headers["authorization"] || "";
  const isVercelCron = req.headers["x-vercel-cron"];
  if (!isVercelCron && CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  try {
    const branches = await listBotBranches();
    if (!branches.length) {
      return res.status(200).json({ ok: true, results: [] });
    }

    const results = [];
    for (const branch of branches) {
      results.push(await mergeBranch(branch));
    }

    const merged = results.filter((r) => r.status === "merged");
    const conflicts = results.filter((r) => r.status === "conflict");
    const errors = results.filter((r) => r.status === "error");

    const lines = [`🔀 *mrpaint branch sync* — ${branches.length} pending bot branch(es)`];
    if (merged.length) lines.push(`✅ Merged: ${merged.map((m) => m.branch).join(", ")}`);
    if (conflicts.length) lines.push(`⚠️ Conflicts, needs a manual merge: ${conflicts.map((c) => c.branch).join(", ")}`);
    if (errors.length) lines.push(`🚨 Errors: ${errors.map((e) => `${e.branch} (${e.error.slice(0, 100)})`).join("; ")}`);
    await postToSlack({ text: lines.join("\n") });

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    await postToSlack({ text: `🚨 *mrpaint branch sync FAILED*: ${String(err?.message || err)}` });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
