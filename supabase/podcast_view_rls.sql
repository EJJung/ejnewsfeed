-- ============================================================
-- EJ Newsfeed — Podcast View RLS
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- episodes previously had only a service_role policy (see
-- podcast_schema.sql), so authenticated dashboard reads returned zero
-- rows. This grants the signed-in dashboard read access, scoped to
-- status='ready' so half-finished (generating/error) rows never reach
-- the UI — matching what the RSS feed serves.
-- ============================================================

CREATE POLICY "authenticated_read_ready_episodes" ON episodes
  FOR SELECT TO authenticated
  USING (status = 'ready');

-- ── Verify ────────────────────────────────────────────────────────────────
SELECT policyname, roles, cmd FROM pg_policies WHERE tablename = 'episodes';
