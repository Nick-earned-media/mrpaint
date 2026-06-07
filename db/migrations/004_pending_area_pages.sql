-- Pending area pages: state for the WhatsApp "build me a suburb page" flow.
-- One row per active page-build per phone. Lifecycle:
--   awaiting_voice_note → Adrian needs to send the discovery voice note
--   generating          → transient, Sonnet is drafting the .njk
--   preview_pending     → draft committed, awaiting YES/NO
--   completed           → merged + live
--   abandoned           → discarded / timed out

create table if not exists pending_area_pages (
  id                  uuid primary key default gen_random_uuid(),
  phone               text not null,
  suburb              text not null,
  suburb_slug         text not null,
  status              text not null default 'awaiting_voice_note'
                        check (status in ('awaiting_voice_note', 'generating',
                                          'preview_pending', 'completed', 'abandoned')),
  transcript          text,
  -- Sonnet output, kept so /api/preview can render without re-asking Sonnet.
  preview_html_body   text,
  njk_filename        text,
  njk_content         text,
  draft_branch        text,
  draft_sha           text,
  started_at          timestamptz not null default now(),
  last_activity_at    timestamptz not null default now()
);

create index if not exists pending_area_pages_phone_active_idx
  on pending_area_pages(phone)
  where status not in ('completed', 'abandoned');

create unique index if not exists pending_area_pages_one_active_per_phone
  on pending_area_pages(phone)
  where status not in ('completed', 'abandoned');
