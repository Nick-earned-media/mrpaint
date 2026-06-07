-- Atomic JSONB appenders for pending_captures.
--
-- Why: when Adrian batch-uploads photos via WhatsApp, Twilio fires a webhook
-- per media item within ~100ms of each other. Each invocation was doing a
-- read-modify-write on media_items in the lib/captures.js helpers — last
-- writer wins, earlier writes get clobbered, so a 3-photo batch landed as 2.
--
-- The "||" jsonb concatenation operator runs inside the UPDATE so each call
-- is atomic at the row level. Run this once in the Supabase SQL editor.

create or replace function append_capture_media(p_id uuid, p_item jsonb)
returns void
language sql
as $$
  update pending_captures
  set media_items     = coalesce(media_items, '[]'::jsonb) || jsonb_build_array(p_item),
      last_activity_at = now(),
      reminded_15m     = false,
      reminded_60m     = false
  where id = p_id;
$$;

create or replace function append_capture_pending_media(p_id uuid, p_item jsonb)
returns void
language sql
as $$
  update pending_captures
  set pending_media   = coalesce(pending_media, '[]'::jsonb) || jsonb_build_array(p_item),
      status          = 'awaiting_same_or_new',
      last_activity_at = now(),
      reminded_15m     = false,
      reminded_60m     = false
  where id = p_id;
$$;
