// CRUD for pending_area_pages — the WhatsApp suburb-page builder flow.
// Schema in db/migrations/004_pending_area_pages.sql.

const { client } = require("./supabase.js");

const ACTIVE = ["awaiting_voice_note", "generating", "preview_pending"];

async function getActiveAreaPage(phone) {
  if (!phone) return null;
  const { data, error } = await client()
    .from("pending_area_pages")
    .select("*")
    .eq("phone", phone)
    .in("status", ACTIVE)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[area-pages] getActiveAreaPage error:", error.message);
    return null;
  }
  return data;
}

async function createAreaPage({ phone, suburb, suburbSlug }) {
  const { data, error } = await client()
    .from("pending_area_pages")
    .insert({ phone, suburb, suburb_slug: suburbSlug })
    .select("*").single();
  if (error) throw new Error(`createAreaPage: ${error.message}`);
  return data;
}

async function setAreaPageTranscript(id, transcript) {
  const { data, error } = await client()
    .from("pending_area_pages")
    .update({ transcript, status: "generating", last_activity_at: new Date().toISOString() })
    .eq("id", id).select("*").single();
  if (error) throw new Error(`setAreaPageTranscript: ${error.message}`);
  return data;
}

async function setAreaPageDraft(id, { njk_filename, njk_content, preview_html_body, draft_branch, draft_sha }) {
  const { data, error } = await client()
    .from("pending_area_pages")
    .update({
      njk_filename, njk_content, preview_html_body,
      draft_branch, draft_sha,
      status: "preview_pending",
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", id).select("*").single();
  if (error) throw new Error(`setAreaPageDraft: ${error.message}`);
  return data;
}

async function markStatus(id, status) {
  const { error } = await client()
    .from("pending_area_pages")
    .update({ status, last_activity_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`area-pages markStatus: ${error.message}`);
}

async function getPreviewPendingAreaPage() {
  // Used by /api/preview when there's no job draft — surface any active
  // area-page draft regardless of phone (single-tenant for now).
  const { data, error } = await client()
    .from("pending_area_pages")
    .select("id, suburb, suburb_slug, preview_html_body, draft_branch, last_activity_at")
    .eq("status", "preview_pending")
    .order("last_activity_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[area-pages] getPreviewPendingAreaPage error:", error.message);
    return null;
  }
  return data;
}

module.exports = {
  ACTIVE,
  getActiveAreaPage,
  createAreaPage,
  setAreaPageTranscript,
  setAreaPageDraft,
  markStatus,
  getPreviewPendingAreaPage,
};
