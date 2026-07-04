// CRUD helpers for pending_captures — short-lived state for the WhatsApp
// "send media first, describe later" flow.
//
// Schema lives in db/migrations/002_pending_captures.sql. Lifecycle states:
//   awaiting_description → preview_pending → (awaiting_same_or_new) → completed/abandoned
//
// All writes update last_activity_at so the reminder cron only nudges captures
// that have actually gone quiet.

const { client } = require("./supabase.js");

const ACTIVE = ["awaiting_description", "preview_pending", "awaiting_same_or_new"];

async function getActiveCapture(phone) {
  if (!phone) return null;
  // Captures older than 4 hours are considered stale — auto-abandon them
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client()
    .from("pending_captures")
    .select("*")
    .eq("phone", phone)
    .in("status", ACTIVE)
    .gte("last_activity_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[captures] getActiveCapture error:", error.message);
    return null;
  }
  return data;
}

async function createCapture({ phone, mediaItem }) {
  const row = {
    phone,
    status: "awaiting_description",
    media_items: mediaItem ? [mediaItem] : [],
    last_activity_at: new Date().toISOString(),
  };
  const { data, error } = await client()
    .from("pending_captures").insert(row).select("*").single();
  if (!error) return data;

  // Unique constraint hit — a stale active row exists for this phone but was
  // filtered out by the 4-hour cutoff in getActiveCapture. Abandon it and retry.
  if (error.code === "23505") {
    await client()
      .from("pending_captures")
      .update({ status: "abandoned", last_activity_at: new Date().toISOString() })
      .eq("phone", phone)
      .in("status", ACTIVE);
    const { data: data2, error: error2 } = await client()
      .from("pending_captures").insert(row).select("*").single();
    if (error2) throw new Error(`createCapture: ${error2.message}`);
    return data2;
  }

  throw new Error(`createCapture: ${error.message}`);
}

async function appendMediaToCapture(id, mediaItem) {
  // Prefer the atomic RPC (migration 003) — falls back to JS read-modify-write
  // if the RPC isn't in the schema cache yet (e.g. after a fresh deploy or
  // a Supabase incident). The race condition the RPC prevents only matters for
  // rapid multi-photo Twilio batches, not web/Slack single uploads.
  const { error } = await client().rpc("append_capture_media", {
    p_id: id, p_item: mediaItem,
  });
  if (!error) return;
  if (!error.message.includes("schema cache")) throw new Error(`appendMedia rpc: ${error.message}`);
  // Fallback: read-modify-write
  const { data: row, error: readErr } = await client()
    .from("pending_captures").select("media_items").eq("id", id).single();
  if (readErr) throw new Error(`appendMedia fallback read: ${readErr.message}`);
  const items = [...(row.media_items || []), mediaItem];
  const { error: writeErr } = await client()
    .from("pending_captures")
    .update({ media_items: items, last_activity_at: new Date().toISOString(), reminded_15m: false, reminded_60m: false })
    .eq("id", id);
  if (writeErr) throw new Error(`appendMedia fallback write: ${writeErr.message}`);
}

async function appendPendingMedia(id, mediaItem) {
  // Prefer atomic RPC — same fallback strategy as appendMediaToCapture.
  const { error } = await client().rpc("append_capture_pending_media", {
    p_id: id, p_item: mediaItem,
  });
  if (!error) return;
  if (!error.message.includes("schema cache")) throw new Error(`appendPendingMedia rpc: ${error.message}`);
  // Fallback: read-modify-write
  const { data: row, error: readErr } = await client()
    .from("pending_captures").select("pending_media").eq("id", id).single();
  if (readErr) throw new Error(`appendPendingMedia fallback read: ${readErr.message}`);
  const items = [...(row.pending_media || []), mediaItem];
  const { error: writeErr } = await client()
    .from("pending_captures")
    .update({ pending_media: items, status: "awaiting_same_or_new", last_activity_at: new Date().toISOString(), reminded_15m: false, reminded_60m: false })
    .eq("id", id);
  if (writeErr) throw new Error(`appendPendingMedia fallback write: ${writeErr.message}`);
}

async function moveSameJobMedia(id) {
  // User said SAME → fold pending_media into media_items, clear pending_media.
  const { data: row, error: readErr } = await client()
    .from("pending_captures").select("media_items, pending_media")
    .eq("id", id).single();
  if (readErr) throw new Error(`moveSameJobMedia read: ${readErr.message}`);
  const media = [...(row.media_items || []), ...(row.pending_media || [])];
  const { data, error } = await client()
    .from("pending_captures")
    .update({
      media_items: media,
      pending_media: [],
      status: "preview_pending",
      last_activity_at: new Date().toISOString(),
      reminded_15m: false,
      reminded_60m: false,
    })
    .eq("id", id).select("*").single();
  if (error) throw new Error(`moveSameJobMedia update: ${error.message}`);
  return data;
}

async function takePendingMediaForNewCapture(id) {
  // User said NEW → return pending_media (to seed a new capture) and clear it.
  const { data: row, error: readErr } = await client()
    .from("pending_captures").select("pending_media")
    .eq("id", id).single();
  if (readErr) throw new Error(`takePendingMedia read: ${readErr.message}`);
  const taken = Array.isArray(row.pending_media) ? row.pending_media : [];
  await client()
    .from("pending_captures")
    .update({ pending_media: [], status: "preview_pending", last_activity_at: new Date().toISOString() })
    .eq("id", id);
  return taken;
}

async function setDescription(id, description) {
  const { data, error } = await client()
    .from("pending_captures")
    .update({
      description,
      last_activity_at: new Date().toISOString(),
      reminded_15m: false,
      reminded_60m: false,
    })
    .eq("id", id).select("*").single();
  if (error) throw new Error(`setDescription: ${error.message}`);
  return data;
}

async function setDraft(id, { draft_branch, draft_sha, draft_target_page, draft_payload }) {
  const { data, error } = await client()
    .from("pending_captures")
    .update({
      draft_branch, draft_sha, draft_target_page, draft_payload,
      status: "preview_pending",
      last_activity_at: new Date().toISOString(),
      reminded_15m: false,
      reminded_60m: false,
    })
    .eq("id", id).select("*").single();
  if (error) throw new Error(`setDraft: ${error.message}`);
  return data;
}

async function markStatus(id, status) {
  const { error } = await client()
    .from("pending_captures")
    .update({ status, last_activity_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`markStatus: ${error.message}`);
}

async function markReminded(id, which) {
  const update = which === "15m"
    ? { reminded_15m: true }
    : which === "60m" ? { reminded_60m: true } : null;
  if (!update) throw new Error(`markReminded: unknown ${which}`);
  const { error } = await client().from("pending_captures").update(update).eq("id", id);
  if (error) throw new Error(`markReminded: ${error.message}`);
}

async function listForReminder({ idleMinutes, kind }) {
  // kind = "15m" | "60m" | "abandon"
  const cutoff = new Date(Date.now() - idleMinutes * 60 * 1000).toISOString();
  let q = client()
    .from("pending_captures").select("*")
    .in("status", ACTIVE)
    .lt("last_activity_at", cutoff);
  if (kind === "15m") q = q.eq("reminded_15m", false);
  if (kind === "60m") q = q.eq("reminded_60m", false);
  const { data, error } = await q.limit(50);
  if (error) {
    console.warn(`[captures] listForReminder(${kind}) error:`, error.message);
    return [];
  }
  return data || [];
}

module.exports = {
  ACTIVE,
  getActiveCapture,
  createCapture,
  appendMediaToCapture,
  appendPendingMedia,
  moveSameJobMedia,
  takePendingMediaForNewCapture,
  setDescription,
  setDraft,
  markStatus,
  markReminded,
  listForReminder,
};
