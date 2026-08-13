// Vercel cron — daily backup of the mrpaint Supabase database + a repo
// tarball, uploaded to the private mrpaint-backups Blob store. Keeps a
// rolling 5-day history (older dated folders get pruned each run).
//
// Schedule: vercel.json crons → "20 17 * * *" (17:20 UTC = 3:20am AEST).
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — read every table
//   GITHUB_TOKEN, GITHUB_REPO               — fetch the repo tarball
//   BLOB_READ_WRITE_TOKEN                   — mrpaint-backups store (private)
//   SLACK_WEBHOOK_URL                       — pass/fail summary
//   CRON_SECRET                             — Vercel auto-sets for cron auth

const { postToSlack } = require("../lib/slack.js");
const { dumpAllTables, fetchRepoTarball, uploadBackup, pruneOldBackups } = require("../lib/backup-tools.js");

const CRON_SECRET = process.env.CRON_SECRET || "";

module.exports = async function handler(req, res) {
  const auth = req.headers["authorization"] || "";
  const isVercelCron = req.headers["x-vercel-cron"];
  if (!isVercelCron && CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  const dateStr = new Date().toISOString().slice(0, 10);

  if (req.query && req.query.debug === "1") {
    const steps = {};
    try {
      const { dump, errors } = await dumpAllTables();
      steps.dumpAllTables = { ok: true, errors, tableCounts: Object.fromEntries(Object.entries(dump).map(([t, r]) => [t, r ? r.length : null])) };

      const tarball = await fetchRepoTarball("main");
      steps.fetchRepoTarball = { ok: true, bytes: tarball.length };

      const { put } = require("@vercel/blob");
      const putResult = await put(`backups/debug-manual-test.json`, JSON.stringify({ t: Date.now() }), {
        access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
      });
      steps.manualPut = { ok: true, result: putResult };

      const { list } = require("@vercel/blob");
      const listResult = await list({ prefix: "backups/" });
      steps.manualList = { ok: true, count: listResult.blobs.length, paths: listResult.blobs.map((b) => b.pathname) };
    } catch (err) {
      steps.error = String(err?.stack || err?.message || err);
    }
    return res.status(200).json(steps);
  }

  try {
    const { dump, errors } = await dumpAllTables();
    const tarball = await fetchRepoTarball("main");
    const uploadResult = await uploadBackup(dateStr, { dump, errors }, tarball);
    const prune = await pruneOldBackups(5);

    const lines = [
      `🗄️ *mrpaint daily backup* — ${dateStr}`,
      `DB dump: ${(uploadResult.database.bytes / 1024).toFixed(0)}KB · repo tarball: ${(uploadResult.repo.bytes / 1024).toFixed(0)}KB`,
      errors.length ? `⚠️ Table errors: ${errors.map((e) => e.table).join(", ")}` : "All tables dumped OK",
      prune.deletedDates.length ? `Pruned: ${prune.deletedDates.join(", ")} (${prune.deletedFiles} files)` : "Nothing to prune yet",
    ];
    await postToSlack({ text: lines.join("\n") });

    return res.status(200).json({ ok: true, date: dateStr, errors, prune });
  } catch (err) {
    await postToSlack({ text: `🚨 *mrpaint daily backup FAILED* (${dateStr}): ${String(err?.message || err)}` });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
