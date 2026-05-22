// Ahrefs Rank Tracker — fetches current positions and 7d/30d deltas for
// the keywords tracked in the user's mrpaint.com.au Ahrefs project.
//
// Auto-discovers the project ID from the user's Ahrefs account by listing
// projects and matching on hostname. Override with AHREFS_PROJECT_ID env
// var if you have multiple projects on the same domain.
//
// Env vars:
//   AHREFS_API_TOKEN  — same token as the audit module.
//   AHREFS_PROJECT_ID — optional; skips the auto-discovery list call.
//   AHREFS_PROJECT_DOMAIN — domain to match when discovering; defaults to
//     "mrpaint.com.au".

const AHREFS_BASE = "https://api.ahrefs.com/v3";

async function fetchRankings() {
  const token = process.env.AHREFS_API_TOKEN;
  if (!token) return { skipped: "AHREFS_API_TOKEN not set" };

  const targetDomain = process.env.AHREFS_PROJECT_DOMAIN || "mrpaint.com.au";
  let projectId = process.env.AHREFS_PROJECT_ID || "";
  let projectName = "";

  if (!projectId) {
    const projects = await listProjects(token);
    const match = projects.find((p) =>
      (p.domain || p.target || p.url || "").toLowerCase().includes(targetDomain.toLowerCase())
    );
    if (!match) {
      return {
        error: `No Ahrefs project found matching "${targetDomain}". ` +
          `Found projects: ${projects.map((p) => p.domain || p.target || p.url || p.name).join(", ") || "none"}. ` +
          `Set AHREFS_PROJECT_ID to override.`,
      };
    }
    projectId = match.id || match.project_id;
    projectName = match.name || match.domain || targetDomain;
  }

  // Pull rank tracker overview + per-keyword data.
  const [overview, keywords] = await Promise.all([
    rankTrackerOverview(token, projectId),
    rankTrackerKeywords(token, projectId),
  ]);

  // Compute movers (≥3 position change over 7d).
  const movers = keywords
    .filter((k) => k.position7dAgo != null && k.position != null)
    .map((k) => ({
      ...k,
      delta7d: k.position7dAgo - k.position, // positive = improved (lower rank number is better)
    }))
    .filter((k) => Math.abs(k.delta7d) >= 3)
    .sort((a, b) => Math.abs(b.delta7d) - Math.abs(a.delta7d));

  const top = [...keywords]
    .filter((k) => k.position != null && k.position <= 100)
    .sort((a, b) => (b.volume || 0) - (a.volume || 0))
    .slice(0, 10);

  return {
    projectId,
    projectName,
    summary: {
      tracked: keywords.length,
      ranking: keywords.filter((k) => k.position != null && k.position <= 100).length,
      averagePosition: avg(keywords.map((k) => k.position).filter(Boolean)),
      visibility: overview.visibility,
      sumTraffic: overview.sumTraffic,
    },
    movers,
    top,
    keywords,
  };
}

async function listProjects(token) {
  const url = `${AHREFS_BASE}/management/projects?output=json&select=id,name,domain,url,target`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Ahrefs projects ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.projects || data.data || data.rows || [];
}

async function rankTrackerOverview(token, projectId) {
  const today = new Date().toISOString().slice(0, 10);
  const url = new URL(`${AHREFS_BASE}/rank-tracker-overview`);
  url.searchParams.set("project_id", projectId);
  url.searchParams.set("date", today);
  url.searchParams.set("output", "json");
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Ahrefs rank-tracker-overview ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  // Try a few possible shapes
  const o = data.overview || data.summary || data;
  return {
    visibility: o.visibility || o.share_of_voice || null,
    sumTraffic: o.sum_traffic || o.traffic || null,
  };
}

async function rankTrackerKeywords(token, projectId) {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

  // Pull current snapshot and 7-day-ago snapshot in parallel.
  const [now, past] = await Promise.all([
    rankTrackerSnapshot(token, projectId, today),
    rankTrackerSnapshot(token, projectId, sevenDaysAgo),
  ]);

  // Merge: keyword → { position, position7dAgo, volume, ... }
  const pastMap = new Map(past.map((k) => [k.keyword.toLowerCase(), k]));
  return now.map((k) => {
    const p = pastMap.get(k.keyword.toLowerCase());
    return {
      keyword: k.keyword,
      position: k.position,
      position7dAgo: p ? p.position : null,
      volume: k.volume,
      traffic: k.traffic,
      difficulty: k.difficulty,
      url: k.url,
    };
  });
}

async function rankTrackerSnapshot(token, projectId, date) {
  const url = new URL(`${AHREFS_BASE}/rank-tracker-serp-overview`);
  url.searchParams.set("project_id", projectId);
  url.searchParams.set("date", date);
  url.searchParams.set("limit", "200");
  url.searchParams.set("output", "json");
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Ahrefs rank-tracker-serp-overview ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const rows = data.keywords || data.serp_overview || data.data || data.rows || [];
  return rows.map((row) => ({
    keyword: row.keyword || row.kw || "",
    position: row.best_position || row.position || row.pos || null,
    volume: row.volume || row.search_volume || null,
    traffic: row.traffic || null,
    difficulty: row.kd || row.difficulty || null,
    url: row.best_position_url || row.url || row.landing_url || null,
  })).filter((k) => k.keyword);
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

// ─── WhatsApp formatting ─────────────────────────────────────────────────

function formatRankingsMessages(r) {
  if (r.skipped) {
    return [`📊 *Rank Tracker* — skipped\n${r.skipped}`];
  }
  if (r.error) {
    return [`📊 *Rank Tracker* — failed\n${r.error}`];
  }

  const m = [];
  const s = r.summary;
  m.push(`📊 *Rank Tracker — mrpaint.com.au*`);
  m.push(`Project: ${r.projectName || r.projectId}`);
  m.push(`${s.ranking}/${s.tracked} keywords ranking · avg position ${s.averagePosition ?? "—"}`);

  // Movers
  if (r.movers.length === 0) {
    m.push(``);
    m.push(`No keywords moved ≥3 positions in the last 7 days.`);
  } else {
    const wins = r.movers.filter((k) => k.delta7d > 0).slice(0, 5);
    const losses = r.movers.filter((k) => k.delta7d < 0).slice(0, 5);
    if (wins.length) {
      m.push(``);
      m.push(`🟢 *Wins (last 7d):*`);
      for (const k of wins) {
        m.push(`• "${k.keyword}" — #${k.position} (+${k.delta7d})`);
      }
    }
    if (losses.length) {
      m.push(``);
      m.push(`🔴 *Drops (last 7d):*`);
      for (const k of losses) {
        m.push(`• "${k.keyword}" — #${k.position} (${k.delta7d})`);
      }
    }
  }

  // Top tracked
  if (r.top.length > 0) {
    m.push(``);
    m.push(`*Top tracked (by search volume):*`);
    for (const k of r.top.slice(0, 5)) {
      m.push(`• "${k.keyword}" — #${k.position} (vol ${k.volume || "—"})`);
    }
  }

  return [m.join("\n")];
}

module.exports = { fetchRankings, formatRankingsMessages };
