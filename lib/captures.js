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
  const { data, error } = await client()
    .from("pending_captures")
    .select("*")
    .eq("phone", phone)
    .in("status", ACTIVE)
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
  if (error) throw new Error(`createCapture: ${error.message}`);
  return data;
}

async function appendMediaToCapture(id, mediaItem) {
  // Read-modify-write since jsonb append via supabase-js needs a raw rpc call.
  const { data: row, error: readErr } = await client()
    .from("pending_captures").select("media_items, pending_media, status")
    .eq("id", id).single();
  if (readErr) throw new Error(`appendMedia read: ${readErr.message}`);
  const media = Array.isArray(row.media_items) ? row.media_items : [];
  media.push(mediaItem);
  const { data, error } = await client()
    .from("pending_captures")
    .update({ media_items: media, last_activity_at: new Date().toISOString() })
    .eq("id", id).select("*").single();
  if (error) throw new Error(`appendMedia update: ${error.message}`);
  return data;
}

async function appendPendingMedia(id, mediaItem) {
  // Used after the preview is shown: new media goes into pending_media until
  // the user answers "same job?" vs "new post?". If SAME, we move them into
  // media_items and rebuild the preview. If NEW, we discard them and start a
  // fresh capture with these media items.
  const { data: row, error: readErr } = await client()
    .from("pending_captures").select("pending_media, status")
    .eq("id", id).single();
  if (readErr) throw new Error(`appendPendingMedia read: ${readErr.message}`);
  const pending = Array.isArray(row.pending_media) ? row.pending_media : [];
  pending.push(mediaItem);
  const { data, error } = await client()
    .from("pending_captures")
    .update({
      pending_media: pending,
      status: "awaiting_same_or_new",
      last_activity_at: new Date().toISOString(),
      reminded_15m: false,
      reminded_60m: false,
    })
    .eq("id", id).select("*").single();
  if (error) throw new Error(`appendPendingMedia update: ${error.message}`);
  return data;
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
