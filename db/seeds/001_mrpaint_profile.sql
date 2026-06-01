-- Seed MrPaint as client #1 with everything we already know.
-- Pulls from _data/site.json, _data/locations.json, and the Adrian-derived
-- signals in platform-kb/seed-from-adrian/extracted-structured.yaml.

INSERT INTO clients (
  slug, display_name, legal_name,
  github_repo, vercel_project_slug,
  primary_phone, allowed_phones,
  semrush_project_id, semrush_database, semrush_domain,
  style_metadata
) VALUES (
  'mrpaint',
  'MrPaint',
  'MrPaint Pty Ltd',
  'Nick-earned-media/mrpaint',
  'mrpaint',
  NULL,                                        -- set via ALLOWED_PHONES env var (Adrian's WhatsApp)
  '{}',
  '29844457',                                  -- the Semrush Position Tracking project id we wired earlier
  'au',
  'mrpaint.com.au',
  '{
    "avg_sentence_length": null,
    "emoji_usage": "unknown — needs L2 written samples",
    "signature_phrases_observed_so_far": [
      "here we are",
      "here we used",
      "here is my",
      "from here we applied",
      "in conjunction with",
      "nooks and crannies"
    ],
    "speech_register": "matter-of-fact, technical, walks-you-through narrator style",
    "technical_specificity": "high (names grit numbers, product tints, tool model numbers, paint decades)",
    "needs_written_samples": true
  }'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- Profile
INSERT INTO client_profile (
  client_id,
  services,
  suburbs_served,
  paint_brands_used,
  tool_brands_used,
  preferred_products,
  do_say,
  dont_say,
  business_values,
  goals,
  competitive_position
)
SELECT
  c.id,
  '[
    {"name": "Exterior repaint (residential)", "evidenced": true},
    {"name": "Interior repaint (residential)", "evidenced": false},
    {"name": "Weatherboard restoration + full strip", "evidenced": true},
    {"name": "Eaves + rafter painting", "evidenced": true},
    {"name": "Pressure washing (prep)", "evidenced": true},
    {"name": "Commercial painting service", "evidenced": false},
    {"name": "Industrial painting", "evidenced": false},
    {"name": "Roof painting", "evidenced": false}
  ]'::jsonb,
  ARRAY['Cairns CBD', 'Trinity Beach', 'Palm Cove', 'Edge Hill', 'Holloways Beach', 'Edmonton', 'Port Douglas', 'Brinsmead', 'Bungalow'],
  '[
    {"brand": "Sikkens", "product": "Cetol Filter 7 Plus", "tints_used": ["709"], "confidence": "high", "use_case": "exterior hardwood refresher / oil-based tint"},
    {"brand": "Dulux", "product": "1Step PSU (Prep Sealer Undercoat)", "confidence": "high", "use_case": "prime + seal + undercoat in one step before top coats"}
  ]'::jsonb,
  '[
    {"brand": "Festool", "products": ["Rotex 125 sander"], "confidence": "high"},
    {"brand": "Makita", "products": ["battery-powered carpenter planer"], "confidence": "high"},
    {"brand": "pressure washer (Spitwater | Gerni | Karcher — confirm)", "products": ["with lance extension"], "confidence": "low", "follow_up": "ask Adrian"}
  ]'::jsonb,
  '{
    "exterior_refresher_seal": "Sikkens Cetol Filter 7",
    "weatherboard_prep_sealer": "Dulux 1Step PSU",
    "heavy_strip_grit": "40",
    "refresher_sand_grit": "120"
  }'::jsonb,
  ARRAY['weatherboard','Queenslander','Cairns','tropical','wet season','high-set','strip back','top coat','undercoat'],
  ARRAY['luxury','premium','elevated','transform','bespoke','revolutionise','game-changer'],
  ARRAY['quality finishes','site cleanliness','direct communication','no surprise pricing'],
  '{
    "success_definition": "not yet captured — schedule onboarding interview batch 2",
    "growth_signals": "not yet captured",
    "stuck_areas": "not yet captured",
    "ideal_pipeline_mix": "not yet captured",
    "ideal_customer": "not yet captured",
    "avoid_segments": "not yet captured"
  }'::jsonb,
  '{
    "named_competitors": [],
    "gaps": "not yet captured",
    "strengths": "not yet captured"
  }'::jsonb
FROM clients c
WHERE c.slug = 'mrpaint'
ON CONFLICT (client_id) DO NOTHING;

-- Competitors we already know from the Semrush project
INSERT INTO competitors (client_id, name, domain, active)
SELECT c.id, comp.name, comp.domain, true
FROM clients c
CROSS JOIN (VALUES
  ('Cairns Painting Contractors', 'cairnspaintingcontractors.com'),
  ('Pete''s Painting',             'petespainting.com.au'),
  ('McLeod''s Painting',           'mcleodspainting.com.au')
) AS comp(name, domain)
WHERE c.slug = 'mrpaint'
ON CONFLICT DO NOTHING;
