// Supabase client wrapper + convenience helpers for the bot.
//
// Env vars:
//   SUPABASE_URL              — https://nisblrrjgnjcjxxmenjk.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — service_role key (NOT anon). Bot needs write access.
//   OPENAI_API_KEY            — for embeddings (text-embedding-3-small, 1536d)

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

let _client = null;
function client() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env vars missing — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

// ─── Embeddings (OpenAI text-embedding-3-small, 1536d) ─────────────────────

async function embed(text) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`OpenAI embeddings ${r.status}: ${err.slice(0, 300)}`);
  }
  const data = await r.json();
  return data.data[0].embedding;
}

async function embedBatch(texts) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`OpenAI embeddings batch ${r.status}: ${err.slice(0, 300)}`);
  }
  const data = await r.json();
  return data.data.map((d) => d.embedding);
}

// ─── Client lookup ─────────────────────────────────────────────────────────

async function getClientBySlug(slug) {
  const { data, error } = await client()
    .from("clients").select("*").eq("slug", slug).single();
  if (error && error.code !== "PGRST116") throw error;
  return data;
}

async function getClientByPhone(phone) {
  const { data, error } = await client()
    .from("clients").select("*")
    .or(`primary_phone.eq.${phone},allowed_phones.cs.{${phone}}`)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getClientById(id) {
  const { data, error } = await client()
    .from("clients").select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ─── KB retrieval (the two retrieval functions the orchestrator calls) ─────

async function searchPlatformKb(query, { topic = null, audience = null, count = 5 } = {}) {
  const embedding = await embed(query);
  const { data, error } = await client().rpc("match_platform_kb", {
    query_embedding: embedding,
    match_count: count,
    filter_topic: topic,
    filter_audience: audience,
  });
  if (error) throw error;
  return data || [];
}

async function searchClientKb(clientId, query, { sourceType = null, recencyDays = null, count = 5 } = {}) {
  const embedding = await embed(query);
  const { data, error } = await client().rpc("match_client_kb", {
    target_client_id: clientId,
    query_embedding: embedding,
    match_count: count,
    filter_source_type: sourceType,
    recency_days: recencyDays,
  });
  if (error) throw error;
  return data || [];
}

// ─── Conversation thread management ────────────────────────────────────────

async function getOrCreateThread(clientId, phoneNumber) {
  // Look for an active thread (last_active within 24h) for this phone
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: existing } = await client()
    .from("conversation_threads")
    .select("*")
    .eq("client_id", clientId)
    .eq("phone_number", phoneNumber)
    .gte("last_active_at", cutoff)
    .order("last_active_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    await client()
      .from("conversation_threads")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", existing.id);
    return existing;
  }

  const { data: created, error } = await client()
    .from("conversation_threads")
    .insert({ client_id: clientId, phone_number: phoneNumber })
    .select()
    .single();
  if (error) throw error;
  return created;
}

async function appendMessage(threadId, { role, content, toolName = null, toolCalls = null, toolPayload = null }) {
  const { data, error } = await client()
    .from("conversation_messages")
    .insert({ thread_id: threadId, role, content, tool_name: toolName, tool_calls: toolCalls, tool_payload: toolPayload })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getRecentMessages(threadId, limit = 20) {
  const { data, error } = await client()
    .from("conversation_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// ─── Profile / voice samples ───────────────────────────────────────────────

async function getClientProfile(clientId) {
  const { data, error } = await client()
    .from("client_profile").select("*").eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getPinnedVoiceSamples(clientId, limit = 3) {
  const { data, error } = await client()
    .from("voice_samples")
    .select("*")
    .eq("client_id", clientId)
    .eq("pinned", true)
    .order("captured_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  client,
  embed,
  embedBatch,
  getClientBySlug,
  getClientByPhone,
  getClientById,
  searchPlatformKb,
  searchClientKb,
  getOrCreateThread,
  appendMessage,
  getRecentMessages,
  getClientProfile,
  getPinnedVoiceSamples,
};
