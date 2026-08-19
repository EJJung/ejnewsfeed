-- ============================================================
-- EJ Newsfeed — pipeline_runs RLS Fix (authenticated role)
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- supabase/pipeline_logs.sql granted SELECT on pipeline_runs to the
-- `anon` Postgres role only. rls.sql (the dashboard's original policy
-- file) predates pipeline_runs and never added an `authenticated`
-- grant for it — unlike every other dashboard-facing table (articles,
-- categories, daily_summaries, trend_summaries, saved_articles, etc.),
-- which all grant TO authenticated there.
--
-- Same bug class as the knowledge-layer tables (see
-- supabase/knowledge_layer_rls_authenticated_fix.sql): this dashboard
-- requires Google sign-in before any view loads, so real requests
-- carry the `authenticated` role, not `anon`. AdminView.jsx reads
-- pipeline_runs directly and silently discards fetch errors, so this
-- likely renders as an empty runs list for a signed-in admin with no
-- visible error.
--
-- Additive — does not touch the existing anon_read_pipeline_runs policy.
-- ============================================================

CREATE POLICY "auth_read_pipeline_runs"
  ON pipeline_runs FOR SELECT TO authenticated USING (true);

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT tablename, policyname, roles
FROM pg_policies
WHERE tablename = 'pipeline_runs'
ORDER BY policyname;
