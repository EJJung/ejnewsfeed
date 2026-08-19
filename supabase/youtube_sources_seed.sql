-- ============================================================
-- EJ Newsfeed — YouTube Channel Sources Seed
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- The 8 channels from the design spec §2 (Lex Fridman excluded —
-- off-domain, 3-5hr episodes). ON CONFLICT makes this safe to re-run.
-- ============================================================

INSERT INTO sources (name, source_type, youtube_channel_id, website_url, min_duration_seconds, active)
VALUES
  ('Lenny''s Podcast',   'youtube', 'UC6t1O76G0jYXOAoYCm153dA', 'https://www.youtube.com/channel/UC6t1O76G0jYXOAoYCm153dA', 300, true),
  ('Dwarkesh Patel',     'youtube', 'UCXl4i9dYBrFOabk0xGmbkRA', 'https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA', 300, true),
  ('Matt Wolfe',         'youtube', 'UChpleBmo18P08aKCIgti38g', 'https://www.youtube.com/channel/UChpleBmo18P08aKCIgti38g', 300, true),
  ('Riley Brown',        'youtube', 'UCMcoud_ZW7cfxeIugBflSBw', 'https://www.youtube.com/channel/UCMcoud_ZW7cfxeIugBflSBw', 300, true),
  ('Matt Pocock',        'youtube', 'UCswG6FSbgZjbWtdf_hMLaow', 'https://www.youtube.com/channel/UCswG6FSbgZjbWtdf_hMLaow', 300, true),
  ('Two Minute Papers',  'youtube', 'UCbfYPyITQ-7l4upoX8nvctg', 'https://www.youtube.com/channel/UCbfYPyITQ-7l4upoX8nvctg', 300, true),
  ('Hamel Husain',       'youtube', 'UC__dUuqF5w4OnbW221JxmKg', 'https://www.youtube.com/channel/UC__dUuqF5w4OnbW221JxmKg', 300, true),
  ('AI Engineer',        'youtube', 'UCLKPca3kwwd-B59HNr-_lvA', 'https://www.youtube.com/channel/UCLKPca3kwwd-B59HNr-_lvA', 300, true)
ON CONFLICT (youtube_channel_id) DO NOTHING;

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT name, youtube_channel_id, min_duration_seconds, active
FROM sources WHERE source_type = 'youtube' ORDER BY name;
