-- ============================================================
-- EJ Newsfeed — Knowledge Layer RLS Fix (authenticated role)
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- supabase/knowledge_layer_schema.sql granted SELECT to the `anon`
-- Postgres role on all 6 knowledge-layer tables, copying the pattern
-- from trend_summaries.sql/pipeline_logs.sql. But this dashboard
-- requires Google sign-in before any view loads (see App.jsx's auth
-- gate), so by the time a page queries data, requests carry the
-- `authenticated` role, not `anon` — matching every other
-- dashboard-facing table's actual convention in rls.sql (articles,
-- categories, daily_summaries, etc. all grant TO authenticated).
--
-- Confirmed live: querying `insights` with a real logged-in user's
-- session token returned [] (RLS silently filtering everything),
-- while the same query as plain `anon` returned real rows.
--
-- This is additive — it does not touch or remove the existing
-- `anon` policies, just adds the missing `authenticated` grant.
-- ============================================================

CREATE POLICY "auth_read_insights"
  ON insights FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_insight_sources"
  ON insight_sources FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_decisions"
  ON decisions FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_hypotheses"
  ON hypotheses FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_hypothesis_evidence"
  ON hypothesis_evidence FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_open_questions"
  ON open_questions FOR SELECT TO authenticated USING (true);

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT tablename, policyname, roles
FROM pg_policies
WHERE tablename IN ('insights','insight_sources','decisions','hypotheses','hypothesis_evidence','open_questions')
ORDER BY tablename, policyname;
