// Diagnostic for the post → preview → YES → Slack chain. Hit with the same
// INGEST_TOKEN bearer auth as the other admin endpoints.
//
// GET /api/admin/diagnose-capture?phone=614xxxxxxxx
//
// Returns: which env vars are set, whether the phone resolves to a client row,
// whether the last pending_publish job exists, whether Slack is reachable.

const crypto = require("crypto");

module.exports = async function handler(req, res) {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return res.status(503).json({ error: "INGEST_TOKEN not set" });
  const auth = req.headers["authorization"] || "";
  const presented = auth.replace(/^Bearer\s+/i, "").trim();
  if (!presented || presented.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const phone = String(req.query?.phone || "").trim();
  const cleanup = String(req.query?.cleanup || "").toLowerCase() === "true";
  const out = {
    env: {
      SLACK_WEBHOOK_URL: !!process.env.SLACK_WEBHOOK_URL,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      VERCEL_TOKEN: !!process.env.VERCEL_TOKEN,
      INGEST_TOKEN: !!process.env.INGEST_TOKEN,
      ALLOWED_PHONES: (process.env.ALLOWED_PHONES || "").split(",").filter(Boolean).length,
    },
  };

  const { client: supa } = require("../../lib/supabase.js");

  // All clients (so Nick can see the row layout)
  try {
    const { data, error } = await supa()
      .from("clients").select("id, display_name, primary_phone, allowed_phones");
    out.clients = error ? { error: error.message } : data;
  } catch (err) {
    out.clients = { error: String(err.message || err) };
  }

  // Does the given phone resolve?
  if (phone) {
    try {
      const { data, error } = await supa()
        .from("clients").select("id, display_name, allowed_phones")
        .contains("allowed_phones", [phone]).maybeSingle();
      out.phone_lookup = { phone, result: error ? { error: error.message } : data };
    } catch (err) {
      out.phone_lookup = { phone, error: String(err.message || err) };
    }
  }

  // Most recent job + pending_publish
  try {
    const { data, error } = await supa()
      .from("jobs")
      .select("id, suburb, summary, status, captured_at, structured_facts")
      .order("captured_at", { ascending: false }).limit(3);
    out.recent_jobs = error
      ? { error: error.message }
      : (data || []).map((j) => ({
          id: j.id,
          suburb: j.suburb,
          status: j.status,
          captured_at: j.captured_at,
          summary: (j.summary || "").slice(0, 80),
          has_pending_publish: !!j.structured_facts?.pending_publish,
          pending_branch: j.structured_facts?.pending_publish?.branch,
        }));
  } catch (err) {
    out.recent_jobs = { error: String(err.message || err) };
  }

  // Active pending_captures (so we can see what's wedged)
  try {
    let q = supa().from("pending_captures")
      .select("id, phone, status, started_at, last_activity_at, media_items, draft_branch")
      .in("status", ["awaiting_description", "preview_pending", "awaiting_same_or_new"])
      .order("started_at", { ascending: false });
    if (phone) q = q.eq("phone", phone);
    const { data, error } = await q.limit(20);
    out.active_captures = error ? { error: error.message } : data;
  } catch (err) {
    out.active_captures = { error: String(err.message || err) };
  }

  // Cleanup — mark any active captures for the phone (or all if no phone) as
  // abandoned. Useful when a previous test left a stuck row.
  if (cleanup) {
    try {
      let q = supa().from("pending_captures")
        .update({ status: "abandoned", last_activity_at: new Date().toISOString() })
        .in("status", ["awaiting_description", "preview_pending", "awaiting_same_or_new"]);
      if (phone) q = q.eq("phone", phone);
      const { data, error } = await q.select("id, phone, status");
      out.cleanup = error ? { error: error.message } : { abandoned: data };
    } catch (err) {
      out.cleanup = { error: String(err.message || err) };
    }
  }

  // Slack reachability
  out.slack_ready = !!process.env.SLACK_WEBHOOK_URL;

  return res.status(200).json(out);
};
