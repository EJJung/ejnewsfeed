-- ============================================================
-- EJ Newsfeed — Podcast Daily Brief Schema
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- episodes is populated by the generate-podcast Edge Function and read
-- by podcast-feed to build the RSS feed. kind is included now so a
-- future weekly deep-dive spec reuses this table without a migration;
-- only 'daily' rows are produced today.
-- ============================================================

CREATE TABLE episodes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily','weekly')),
  title            TEXT NOT NULL,
  script           TEXT NOT NULL,
  audio_url        TEXT,
  duration_seconds INT,
  published_at     TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'generating'
                   CHECK (status IN ('generating','ready','error')),
  error_message    TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_episodes_published ON episodes(published_at DESC) WHERE status = 'ready';

ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_all_episodes" ON episodes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── Storage bucket for episode audio ─────────────────────────────────────
-- Public bucket: object paths are unguessable episode UUIDs, and the feed
-- itself is token-gated (see podcast-feed function) — same trust model as
-- the RSS feed, not real access control. Public buckets serve objects via
-- /storage/v1/object/public/... without going through RLS, so no
-- storage.objects policy is needed for read access.

INSERT INTO storage.buckets (id, name, public)
VALUES ('podcast-episodes', 'podcast-episodes', true)
ON CONFLICT (id) DO NOTHING;

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'episodes' ORDER BY ordinal_position;

SELECT id, name, public FROM storage.buckets WHERE id = 'podcast-episodes';
