-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║  Migration 001 — Initial schema                                        ║
-- ║                                                                        ║
-- ║  V1 minimal schema for the MrPaint conversational marketing bot.       ║
-- ║  Multi-tenant ready (one client now, more later).                       ║
-- ║                                                                        ║
-- ║  Run against Supabase via:                                              ║
-- ║    npm run migrate                                                     ║
-- ║  or copy-paste into Supabase SQL Editor.                                ║
-- ║                                                                        ║
-- ║  Deferred to later migrations:                                          ║
-- ║   - referrals + credit ledger      (pre-launch)                         ║
-- ║   - PIN + WebAuthn auth fields     (pre-launch with reports gate)       ║
-- ║   - onboarding interview state     (when interview implementation lands)║
-- ╚════════════════════════════════════════════════════════════════════════╝

-- pgvector — required for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- ───────────────────────────────────────────────────────────────────────────
-- Core multi-tenant
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  display_name text NOT NULL,
  legal_name text,
  github_repo text,
  vercel_project_slug text,
  primary_phone text,                       -- E.164 — the allow-listed sender
  allowed_phones text[] DEFAULT '{}',
  semrush_project_id text,
  semrush_database text DEFAULT 'au',
  semrush_domain text,
  style_metadata jsonb DEFAULT '{}',        -- stylometric profile lives here
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_clients_slug ON clients(slug);
CREATE INDEX idx_clients_phone ON clients(primary_phone) WHERE primary_phone IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- Layer 1 — Structured facts (client_profile)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE client_profile (
  client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  services jsonb DEFAULT '[]',              -- array of service descriptions
  suburbs_served text[] DEFAULT '{}',
  paint_brands_used jsonb DEFAULT '[]',     -- [{brand, products[], confidence, use_case}]
  tool_brands_used jsonb DEFAULT '[]',
  preferred_products jsonb DEFAULT '{}',    -- {use_case: product_name}
  staff jsonb DEFAULT '[]',                 -- [{name, role, specialties}]
  warranty text,
  hours jsonb DEFAULT '{}',
  service_radius_km int,
  business_values text[] DEFAULT '{}',
  do_say text[] DEFAULT '{}',
  dont_say text[] DEFAULT '{}',
  founded_year int,
  notable_jobs jsonb DEFAULT '[]',
  goals jsonb DEFAULT '{}',                 -- {success_definition, growth_signals, stuck_areas, ideal_customer, avoid_segments}
  competitive_position jsonb DEFAULT '{}',  -- {gaps, strengths}
  updated_at timestamptz DEFAULT now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- Layer 2 — Voice library
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE voice_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel text NOT NULL,                    -- gbp | ig | fb | email | review_reply | sms | other
  content text NOT NULL,
  source_url text,
  captured_at timestamptz DEFAULT now(),
  pinned bool DEFAULT false,                -- always-on samples vs retrievable
  type text DEFAULT 'written',              -- written | spoken
  notes text
);

CREATE INDEX idx_voice_samples_client ON voice_samples(client_id);
CREATE INDEX idx_voice_samples_pinned ON voice_samples(client_id, pinned) WHERE pinned;
CREATE INDEX idx_voice_samples_type ON voice_samples(client_id, type);

-- ───────────────────────────────────────────────────────────────────────────
-- Layer 3 — Semantic memory (client KB)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE kb_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_type text NOT NULL,                -- job | blog | gbp_post | social_caption | brand_doc | interview_response | onboarding | seed | voice_note
  source_id text,                           -- e.g. job_id, file basename
  source_date timestamptz,
  chunk_text text NOT NULL,
  chunk_index int DEFAULT 0,
  embedding vector(1536),
  metadata jsonb DEFAULT '{}',              -- {suburb, service, season, tags...}
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_kb_chunks_client ON kb_chunks(client_id);
CREATE INDEX idx_kb_chunks_source ON kb_chunks(client_id, source_type);
CREATE INDEX idx_kb_chunks_date ON kb_chunks(client_id, source_date DESC);
CREATE INDEX idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops);

-- ───────────────────────────────────────────────────────────────────────────
-- Platform KB (shared across all clients)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE platform_kb (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,                     -- semrush | backlinko | searchengineland | earnedmedia | square | internal
  source_url text NOT NULL,
  topic text NOT NULL,                      -- local-seo | gbp | reviews | geo | content | links
  audience text DEFAULT 'both',             -- tradies | enterprise | both
  chunk_text text NOT NULL,
  chunk_index int DEFAULT 0,
  embedding vector(1536),
  quality text DEFAULT 'high',
  fetched_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'
);

CREATE INDEX idx_platform_kb_topic ON platform_kb(topic);
CREATE INDEX idx_platform_kb_audience ON platform_kb(audience);
CREATE INDEX idx_platform_kb_embedding ON platform_kb USING hnsw (embedding vector_cosine_ops);

-- ───────────────────────────────────────────────────────────────────────────
-- Layer 4 — Job-capture timeline
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  captured_at timestamptz DEFAULT now(),
  suburb text,
  summary text,
  worker_handle text,                       -- which staff member captured this
  customer_consent bool DEFAULT false,
  customer_first_name text,
  customer_phone text,
  raw_transcript text,
  structured_facts jsonb DEFAULT '{}',
  media_originals text[] DEFAULT '{}',
  media_public text[] DEFAULT '{}',
  status text DEFAULT 'capturing',          -- capturing | generating | awaiting_approval | published | discarded
  workflow_run_id text
);

CREATE INDEX idx_jobs_client ON jobs(client_id, captured_at DESC);
CREATE INDEX idx_jobs_suburb ON jobs(client_id, suburb);
CREATE INDEX idx_jobs_status ON jobs(client_id, status);

CREATE TABLE job_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  channel text NOT NULL,                    -- gbp | suburb_page | ig | fb | li
  draft_content text,
  draft_meta jsonb DEFAULT '{}',
  status text DEFAULT 'draft',              -- draft | editing | queued | published | failed
  published_url text,
  published_at timestamptz,
  generated_at timestamptz DEFAULT now(),
  regenerated_count int DEFAULT 0
);

CREATE INDEX idx_job_assets_job ON job_assets(job_id);
CREATE INDEX idx_job_assets_status ON job_assets(status);

CREATE TABLE job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type text NOT NULL,                       -- inbound_message | interview_turn | draft_generated | edit_requested | published | discarded | error
  payload jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_job_events_client ON job_events(client_id, created_at DESC);
CREATE INDEX idx_job_events_job ON job_events(job_id, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- Layer 5 — Derived intelligence (weekly synthesis)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE client_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type text NOT NULL,                       -- voice_summary | seasonal_pattern | top_performing | style_evolution
  content text NOT NULL,
  source_period tstzrange,
  generated_at timestamptz DEFAULT now(),
  superseded_at timestamptz,                -- soft-deprecation when newer version exists
  embedding vector(1536),
  metadata jsonb DEFAULT '{}'
);

CREATE INDEX idx_client_intelligence_lookup
  ON client_intelligence(client_id, type, generated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Style feedback (learning signal from edits)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE style_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  feedback_type text NOT NULL,              -- edit_instruction | discard_reason | explicit_rating
  payload jsonb DEFAULT '{}',
  applied_to_profile bool DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_style_feedback_client ON style_feedback(client_id, applied_to_profile);

-- ───────────────────────────────────────────────────────────────────────────
-- Conversation state
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE conversation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  phone_number text NOT NULL,               -- E.164, the sender
  started_at timestamptz DEFAULT now(),
  last_active_at timestamptz DEFAULT now(),
  summary text,                             -- Haiku-generated rolling summary after ~10 turns
  state jsonb DEFAULT '{}'                  -- flow state (onboarding step, current job, etc)
);

CREATE INDEX idx_threads_phone ON conversation_threads(client_id, phone_number, last_active_at DESC);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  role text NOT NULL,                       -- user | assistant | tool
  content text NOT NULL,
  tool_calls jsonb,
  tool_name text,
  tool_payload jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_messages_thread ON conversation_messages(thread_id, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- Tracked keywords + competitors (Semrush sync)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE tracked_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  suburb text,                              -- if suburb-specific
  target_url text,
  current_position int,
  previous_position int,
  search_volume int,
  cpc numeric,
  last_synced_at timestamptz DEFAULT now(),
  semrush_project_id text,
  UNIQUE(client_id, keyword)
);

CREATE INDEX idx_tracked_keywords_client ON tracked_keywords(client_id, suburb);

CREATE TABLE keyword_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_keyword_id uuid NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  position int,
  search_volume int,
  semrush_data jsonb DEFAULT '{}',
  UNIQUE(tracked_keyword_id, snapshot_date)
);

CREATE INDEX idx_keyword_history ON keyword_history(tracked_keyword_id, snapshot_date DESC);

CREATE TABLE competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name text NOT NULL,                       -- "Cairns Painting Contractors"
  domain text NOT NULL,                     -- "cairnspaintingcontractors.com"
  logo_path text,                           -- optional uploaded asset
  notes text,
  active bool DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_competitors_active ON competitors(client_id) WHERE active;

-- ───────────────────────────────────────────────────────────────────────────
-- Reports + YoY snapshots
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  scope text NOT NULL,                      -- 'cairns' | suburb_slug | 'all'
  period_type text NOT NULL,                -- weekly | monthly | quarterly | on_demand
  period_start date NOT NULL,
  period_end date NOT NULL,
  html text,
  json_data jsonb DEFAULT '{}',
  url_slug text NOT NULL,                   -- /reports/cairns/2026-05-30
  generated_at timestamptz DEFAULT now(),
  UNIQUE(client_id, scope, period_type, period_end)
);

CREATE INDEX idx_reports_client ON reports(client_id, generated_at DESC);
CREATE INDEX idx_reports_url ON reports(url_slug);

-- Daily metric snapshots so we can compare any window against the same
-- window exactly a year prior (monthly + quarterly reports need this).
CREATE TABLE report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  metric_type text NOT NULL,                -- avg_position | sov | kw_ranked | ai_citations | gbp_views | gbp_calls
  scope text NOT NULL,                      -- 'cairns' | suburb_slug
  value numeric,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  UNIQUE(client_id, snapshot_date, metric_type, scope)
);

CREATE INDEX idx_snapshots_yoy
  ON report_snapshots(client_id, scope, metric_type, snapshot_date);

-- ───────────────────────────────────────────────────────────────────────────
-- Rule engine (proactive notifications)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,   -- NULL = applies to all clients
  name text NOT NULL,
  trigger_type text NOT NULL,               -- ranking_drop | scheduled_digest | industry_update | engagement_reactivation | product_update
  conditions jsonb DEFAULT '{}',            -- type-specific config
  message_template text,                    -- with placeholders e.g. {{keyword}} {{suburb}}
  active bool DEFAULT true,
  cooldown_hours int DEFAULT 24,            -- min hours between firings (per rule per client)
  last_fired_at timestamptz,
  fire_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_rules_active ON rules(active) WHERE active;
CREATE INDEX idx_rules_trigger ON rules(trigger_type) WHERE active;

CREATE TABLE rule_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  evaluated_at timestamptz DEFAULT now(),
  fired bool DEFAULT false,
  payload jsonb DEFAULT '{}',               -- context — which keyword, what position drop, etc
  sent_message text
);

CREATE INDEX idx_rule_evaluations_rule ON rule_evaluations(rule_id, evaluated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Reminders (from "Remind me" UI in reports)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  fire_at timestamptz NOT NULL,
  message text NOT NULL,
  status text DEFAULT 'pending',            -- pending | sent | cancelled
  sent_at timestamptz,
  source text,                              -- report_id, conversation_id, etc
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_reminders_due ON reminders(fire_at) WHERE status = 'pending';

-- ───────────────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER touch_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER touch_client_profile_updated_at
  BEFORE UPDATE ON client_profile
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- Helper functions: semantic search
-- ───────────────────────────────────────────────────────────────────────────

-- Search platform_kb with optional topic filter.
CREATE OR REPLACE FUNCTION match_platform_kb(
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  filter_topic text DEFAULT NULL,
  filter_audience text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  source text,
  source_url text,
  topic text,
  chunk_text text,
  similarity float
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
    SELECT
      pk.id, pk.source, pk.source_url, pk.topic, pk.chunk_text,
      1 - (pk.embedding <=> query_embedding) AS similarity
    FROM platform_kb pk
    WHERE pk.embedding IS NOT NULL
      AND (filter_topic IS NULL OR pk.topic = filter_topic)
      AND (filter_audience IS NULL OR pk.audience = filter_audience OR pk.audience = 'both')
    ORDER BY pk.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Search client kb_chunks for a specific client.
CREATE OR REPLACE FUNCTION match_client_kb(
  target_client_id uuid,
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  filter_source_type text DEFAULT NULL,
  recency_days int DEFAULT NULL              -- if set, only return chunks newer than N days
)
RETURNS TABLE (
  id uuid,
  source_type text,
  source_id text,
  source_date timestamptz,
  chunk_text text,
  metadata jsonb,
  similarity float
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
    SELECT
      kc.id, kc.source_type, kc.source_id, kc.source_date,
      kc.chunk_text, kc.metadata,
      1 - (kc.embedding <=> query_embedding) AS similarity
    FROM kb_chunks kc
    WHERE kc.client_id = target_client_id
      AND kc.embedding IS NOT NULL
      AND (filter_source_type IS NULL OR kc.source_type = filter_source_type)
      AND (recency_days IS NULL OR kc.source_date >= now() - (recency_days || ' days')::interval)
    ORDER BY kc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
