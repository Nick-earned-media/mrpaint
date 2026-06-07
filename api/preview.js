// Public, no-login preview page for the latest draft.
//
// How it works: finds the latest bot/* branch (recent only, <24h), fetches
// _data/cairns_recent_jobs.json from that branch, renders the first entry as
// HTML. Media URLs point at raw.githubusercontent.com so they load without
// the repo being publicly cloned to Vercel.
//
// Adrian sees a stable URL: /preview. Each new draft rewrites it. No login,
// no Vercel auth, no GitHub commit link in his WhatsApp. Just the post.
//
// Crawl-protection: X-Robots-Tag header + meta tag.
// Cache-control: no-store so Adrian sees the latest draft on every refresh.

const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!GITHUB_REPO || !GITHUB_TOKEN) {
    return res.status(200).send(renderEmpty("Setup not finished."));
  }

  let branchName;
  try {
    const branches = await ghJson(`/repos/${GITHUB_REPO}/branches?per_page=100`);
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const recent = branches
      .map((b) => b.name)
      .filter((n) => n.startsWith("bot/"))
      .filter((n) => {
        const m = n.match(/^bot\/(\d{10,})-/);
        return m ? Number(m[1]) >= cutoff : false;
      })
      .sort((a, b) => b.localeCompare(a));
    if (!recent.length) {
      return res.status(200).send(renderEmpty());
    }
    branchName = recent[0];
  } catch (err) {
    console.error("preview list branches failed:", err);
    return res.status(200).send(renderEmpty("Couldn't load the preview right now — try again in a sec."));
  }

  let entry;
  try {
    const f = await ghJson(
      `/repos/${GITHUB_REPO}/contents/${encodeURIComponent("_data/cairns_recent_jobs.json")}?ref=${encodeURIComponent(branchName)}`
    );
    const data = JSON.parse(Buffer.from(f.content, "base64").toString("utf-8"));
    entry = Array.isArray(data) ? data[0] : null;
  } catch (err) {
    // Branch exists but no cairns_recent_jobs.json on it — probably a
    // different kind of draft (text edit, business info). Show empty.
    console.warn("preview fetch entry failed:", err?.message || err);
    return res.status(200).send(renderEmpty());
  }

  if (!entry) {
    return res.status(200).send(renderEmpty());
  }

  return res.status(200).send(renderPreview(entry, branchName));
};

async function ghJson(path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mrpaint-preview",
    },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GitHub ${path} → ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

function rawUrl(branch, src) {
  // src like "/assets/images/work-xxx.jpg" → raw.githubusercontent URL
  const path = String(src || "").replace(/^\//, "");
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(branch).replace(/%2F/g, "/")}/${path}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderBodyParas(body) {
  const paras = String(body || "").split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
}

function renderMediaGrid(entry, branch) {
  const media = Array.isArray(entry.media) && entry.media.length
    ? entry.media
    : (entry.video ? [{ type: "video", src: entry.video, alt: entry.photo_alt }]
      : entry.image ? [{ type: "image", src: entry.image, alt: entry.photo_alt }]
      : []);
  if (!media.length) return "";
  const items = media.map((m, i) => {
    const src = rawUrl(branch, m.src);
    const alt = escapeHtml(m.alt || entry.photo_alt || entry.title || "Job photo");
    if (m.type === "video") {
      return `<video src="${escapeHtml(src)}" controls muted playsinline preload="metadata" aria-label="${alt}"></video>`;
    }
    return `<img src="${escapeHtml(src)}" alt="${alt}" loading="${i === 0 ? 'eager' : 'lazy'}" />`;
  }).join("\n");
  return `<div class="gallery">${items}</div>`;
}

function pageShell(innerHtml) {
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>Preview — Mr Paint</title>
  <link rel="icon" href="data:," />
  <style>
    :root {
      --ink: #1a1a1a; --ink-2: #555; --rule: #e7e7e7;
      --bg: #fafafa; --bg-soft: #f4f4f0; --accent: #ffd400;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background: var(--bg); color: var(--ink); line-height: 1.55;
    }
    .banner {
      background: var(--accent); color: #1a1a1a;
      padding: 14px 20px; text-align: center;
      font-weight: 600; font-size: 14px;
      position: sticky; top: 0; z-index: 10;
      border-bottom: 1px solid rgba(0,0,0,.08);
    }
    .banner strong { font-weight: 700; }
    main {
      max-width: 720px; margin: 0 auto; padding: 28px 20px 60px;
    }
    .eyebrow { font-size: 12px; color: var(--ink-2); letter-spacing: .04em; text-transform: uppercase; }
    h1.title { margin: 8px 0 18px; font-size: 26px; line-height: 1.25; }
    article.card {
      background: #fff; border: 1px solid var(--rule); border-radius: 14px;
      padding: 22px; box-shadow: 0 2px 14px rgba(0,0,0,.04);
    }
    article.card p { margin: 14px 0; color: var(--ink); }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 22px; }
    .gallery img, .gallery video {
      width: 100%; aspect-ratio: 4/3; object-fit: cover;
      border-radius: 10px; display: block; background: #f4f4f0;
    }
    .empty { text-align: center; padding: 60px 20px; color: var(--ink-2); }
    .empty h1 { color: var(--ink); margin-bottom: 8px; font-size: 22px; }
    .footnote { margin-top: 28px; text-align: center; color: var(--ink-2); font-size: 13px; }
    @media (max-width: 480px) {
      h1.title { font-size: 22px; }
      article.card { padding: 18px; }
    }
  </style>
</head>
<body>
  ${innerHtml}
</body>
</html>`;
}

function renderPreview(entry, branch) {
  const title = escapeHtml(entry.title || "Untitled draft");
  const date = escapeHtml(entry.date || "");
  const body = renderBodyParas(entry.body);
  const gallery = renderMediaGrid(entry, branch);
  const inner = `
<div class="banner">
  <strong>Preview</strong> — reply <strong>YES</strong> on WhatsApp to publish, <strong>NO</strong> to discard.
</div>
<main>
  <article class="card">
    <span class="eyebrow">${date}</span>
    <h1 class="title">${title}</h1>
    ${body}
    ${gallery}
  </article>
  <p class="footnote">This is a draft. It's not live on the website yet.</p>
</main>`;
  return pageShell(inner);
}

function renderEmpty(msg) {
  const message = escapeHtml(msg || "Nothing waiting to review right now. Send a photo on WhatsApp and a fresh draft will land here.");
  const inner = `
<main>
  <div class="empty">
    <h1>No draft to preview</h1>
    <p>${message}</p>
  </div>
</main>`;
  return pageShell(inner);
}
