// Peec.ai API client — LLM visibility tracking.
//
// Tracks how MrPaint (and competitors) appear in AI-generated responses
// across ChatGPT, Gemini, Perplexity, Claude, etc.
//
// API base: https://api.peec.ai/customer/v1/
// Auth: X-API-Key header. Project-scoped key doesn't need project_id.
//
// Env vars:
//   PEEC_API_KEY     — project-scoped API key (skp-...)
//   PEEC_PROJECT_ID  — optional; only needed for company-scoped keys

const PEEC_BASE = "https://api.peec.ai/customer/v1";

function peecAuth() {
  return process.env.PEEC_API_KEY || null;
}

function defaultDateRange(days = 30) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86400_000);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date:   end.toISOString().slice(0, 10),
  };
}

async function peecPost(path, body) {
  const key = peecAuth();
  if (!key) return { ok: false, error: "PEEC_API_KEY not set" };
  const projectId = process.env.PEEC_PROJECT_ID;
  if (projectId) body.project_id = projectId;

  try {
    const resp = await fetch(`${PEEC_BASE}${path}`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, error: `Peec ${resp.status}: ${t.slice(0, 200)}` };
    }
    const data = await resp.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ─── Brand visibility report ───────────────────────────────────────────────
// Returns mention_count, avg_position, sentiment, share_of_voice per brand.

async function getBrandVisibility({ days = 30, dimensions = [] } = {}) {
  const range = defaultDateRange(days);
  const body = {
    ...range,
    limit: 50,
    order_by: [{ field: "mention_count", direction: "desc" }],
  };
  if (dimensions.length) body.dimensions = dimensions;
  return peecPost("/reports/brands", body);
}

// ─── Source domains report ─────────────────────────────────────────────────
// Returns which domains (pages) AI models are citing — useful to see if
// mrpaint.com.au is being cited and what competitors are being used as sources.

async function getSourceDomains({ days = 30, limit = 20 } = {}) {
  const range = defaultDateRange(days);
  return peecPost("/reports/domains", {
    ...range,
    limit,
    order_by: [{ field: "mention_count", direction: "desc" }],
  });
}

// ─── AI model channel breakdown ────────────────────────────────────────────
// Shows visibility split by model (ChatGPT, Gemini, Perplexity, etc.)

async function getBrandsByModel({ days = 30 } = {}) {
  const range = defaultDateRange(days);
  return peecPost("/reports/brands", {
    ...range,
    limit: 100,
    dimensions: ["model_channel_id"],
    order_by: [{ field: "mention_count", direction: "desc" }],
  });
}

module.exports = {
  getBrandVisibility,
  getSourceDomains,
  getBrandsByModel,
};
