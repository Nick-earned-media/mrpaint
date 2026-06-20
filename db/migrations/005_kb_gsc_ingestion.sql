-- Sprint 1 of the intelligence layer: GSC weekly snapshots embedded into kb_chunks.
--
-- Adds a gsc_property column to clients so the ingestion cron knows which GSC
-- property to query per tenant (URL form, e.g. https://mrpaint.com.au/).
--
-- New kb_chunks source_types introduced (no schema change needed — column is
-- already text):
--   gsc_summary         — one row per week, overall traffic + delta narrative
--   gsc_query_movement  — one row per significantly-moving query that week
--   gsc_page_movement   — one row per significantly-moving page that week
--   gsc_top_queries     — one row per week, snapshot of top 10 queries
--
-- Re-running the same week's ingestion replaces prior rows by source_id
-- (which encodes the period, e.g. gsc:summary:2026-06-13_2026-06-19).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS gsc_property text;

-- Seed MrPaint's value. (Other tenants will set their own at onboarding.)
UPDATE clients
   SET gsc_property = 'https://mrpaint.com.au/'
 WHERE slug = 'mrpaint'
   AND gsc_property IS NULL;
