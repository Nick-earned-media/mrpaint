// Shared GitHub + Vercel-preview helpers.
//
// Extracted from api/whatsapp.js so other modules (lib/tools.js, future tools)
// can reuse the branch-commit-preview-merge pattern without duplicating logic.

const GH_BASE = "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO || "Nick-earned-media/mrpaint";

const VERCEL_TOKEN        = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID      = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT_SLUG = process.env.VERCEL_PROJECT_SLUG || "mrpaint";

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

// Poll Vercel's Deployments API until the branch preview is READY (or null on timeout).
async function findVercelPreviewUrl({ commitSha, timeoutMs = 90000, intervalMs = 5000 }) {
  if (!VERCEL_TOKEN) return null;
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

module.exports = {
  GITHUB_REPO,
  ghJson,
  ghGetContents,
  ghCommitMulti,
  findVercelPreviewUrl,
};
