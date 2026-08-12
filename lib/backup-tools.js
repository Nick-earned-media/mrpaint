// Shared helpers for the daily backup cron (api/cron-daily-backup.js).
//
// Two things get backed up, since neither is safely recoverable from the
// other:
//   1. The Supabase database — real stateful data (jobs, conversations,
//      client intelligence) that only exists there, dumped table-by-table
//      via the Supabase client and stored as JSON.
//   2. The git repo at `main` — cheap extra insurance against a force-push
//      or branch-deletion mistake, fetched as a tarball straight from
//      GitHub's API rather than shelling out to `git` (not guaranteed to
//      be present in the serverless runtime).
//
// Both land in the mrpaint-backups Blob store (private access) under
// backups/<YYYY-MM-DD>/, and pruneOldBackups() keeps only the most recent
// N dated folders.

const { put, list, del } = require("@vercel/blob");
const { client: supabaseClient } = require("./supabase.js");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "Nick-earned-media/mrpaint";

// Every table defined across db/migrations/*.sql as of 2026-08-12.
const TABLES = [
  "clients", "client_profile", "voice_samples", "kb_chunks", "platform_kb",
  "jobs", "job_assets", "job_events", "client_intelligence", "style_feedback",
  "conversation_threads", "conversation_messages", "tracked_keywords",
  "keyword_history", "competitors", "reports", "report_snapshots",
  "rules", "rule_evaluations", "reminders",
];

async function dumpTable(table) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabaseClient()
      .from(table)
      .select("*")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function dumpAllTables() {
  const dump = {};
  const errors = [];
  for (const table of TABLES) {
    try {
      dump[table] = await dumpTable(table);
    } catch (err) {
      errors.push({ table, error: String(err?.message || err) });
      dump[table] = null;
    }
  }
  return { dump, errors };
}

async function fetchRepoTarball(ref = "main") {
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tarball/${ref}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "mrpaint-backup",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`GitHub tarball ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadBackup(dateStr, { dump, errors }, tarballBuffer) {
  const dbJson = JSON.stringify({ generatedAt: new Date().toISOString(), errors, tables: dump });

  const dbBlob = await put(`backups/${dateStr}/database.json`, dbJson, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  const repoBlob = await put(`backups/${dateStr}/repo.tar.gz`, tarballBuffer, {
    access: "private",
    contentType: "application/gzip",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return {
    database: { url: dbBlob.url, bytes: dbJson.length },
    repo: { url: repoBlob.url, bytes: tarballBuffer.length },
  };
}

async function pruneOldBackups(keepDays = 5) {
  const { blobs } = await list({ prefix: "backups/" });
  const dateFolders = new Set();
  for (const b of blobs) {
    const m = b.pathname.match(/^backups\/(\d{4}-\d{2}-\d{2})\//);
    if (m) dateFolders.add(m[1]);
  }
  const sorted = Array.from(dateFolders).sort(); // ascending, oldest first
  const toDelete = sorted.length > keepDays ? sorted.slice(0, sorted.length - keepDays) : [];

  let deletedFiles = 0;
  for (const date of toDelete) {
    const urls = blobs.filter((b) => b.pathname.startsWith(`backups/${date}/`)).map((b) => b.url);
    if (urls.length) {
      await del(urls);
      deletedFiles += urls.length;
    }
  }
  return { deletedDates: toDelete, deletedFiles };
}

module.exports = { TABLES, dumpAllTables, fetchRepoTarball, uploadBackup, pruneOldBackups };
