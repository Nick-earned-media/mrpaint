-- Pending captures: short-lived state for the WhatsApp "send media, then
-- describe it" flow. One row per active capture per phone. Lifecycle:
--   awaiting_description  → media in, asking for description
--   preview_pending       → description received, preview committed
--   awaiting_same_or_new  → more media arrived after preview, asking same-or-new
--   completed             → terminal (Adrian replied YES, branch merged)
--   abandoned             → terminal (idle >2h or NO reply, branch discarded)
--
-- Reminder schedule: 15 min idle → ping #1, 60 min idle → ping #2,
-- 120 min idle → abandon. Run from /api/cron-capture-reminders every 5 min.

create table if not exists pending_captures (
  id                  uuid primary key default gen_random_uuid(),
  phone               text not null,
  status              text not null default 'awaiting_description'
                        check (status in ('awaiting_description', 'preview_pending',
                                          'awaiting_same_or_new', 'completed', 'abandoned')),
  -- [{ url, contentType, alt? }] — Twilio media URLs. Fetched at finalise time.
  media_items         jsonb not null default '[]'::jsonb,
  -- Media that arrived while status='awaiting_same_or_new' — pending the
  -- "same job or new post?" decision. Moved into media_items if SAME.
  pending_media       jsonb not null default '[]'::jsonb,
  description         text,
  -- Branch + sha of the draft commit (created when description arrives).
  draft_branch        text,
  draft_sha           text,
  -- Slot for the page url the draft targets (e.g. /painter-cairns/).
  draft_target_page   text,
  -- Bookkeeping for reminder cron.
  started_at          timestamptz not null default now(),
  last_activity_at    timestamptz not null default now(),
  reminded_15m        boolean not null default false,
  reminded_60m        boolean not null default false,
  -- For inspection only — drafted entry + GBP text we'll need post-merge.
  draft_payload       jsonb
);

create index if not exists pending_captures_phone_active_idx
  on pending_captures(phone)
  where status not in ('completed', 'abandoned');

create index if not exists pending_captures_idle_idx
  on pending_captures(last_activity_at)
  where status not in ('completed', 'abandoned');

-- A phone should only have one active capture at a time. If a new media
-- message arrives without an active capture, create a new row. If one
-- exists, append to it.
create unique index if not exists pending_captures_one_active_per_phone
  on pending_captures(phone)
  where status not in ('completed', 'abandoned');
