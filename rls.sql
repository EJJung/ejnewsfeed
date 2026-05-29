-- ============================================================
-- EJ Newsfeed — Row Level Security (consolidated)
-- Run this in Supabase SQL Editor → New Query
-- Safe to re-run: uses DROP IF EXISTS before each CREATE
-- ============================================================
--
-- Access model:
--   authenticated = dashboard users (login required — all read/write policies use this role)
--   service_role  = Edge Functions (bypasses RLS entirely — no policies needed)
-- ============================================================

-- ── Enable RLS on all tables ───────────────────────────────────────────────

ALTER TABLE categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources           ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_analyses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE trend_summaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_articles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_emails        ENABLE ROW LEVEL SECURITY;
ALTER TABLE _pipeline_config  ENABLE ROW LEVEL SECURITY;

-- ── Drop existing policies (makes this script idempotent) ─────────────────

DROP POLICY IF EXISTS "anon can read categories"         ON categories;
DROP POLICY IF EXISTS "anon can read sources"            ON sources;
DROP POLICY IF EXISTS "anon can read articles"           ON articles;
DROP POLICY IF EXISTS "anon can read article_analyses"   ON article_analyses;
DROP POLICY IF EXISTS "anon can insert article_analyses" ON article_analyses;
DROP POLICY IF EXISTS "anon can read daily_summaries"    ON daily_summaries;
DROP POLICY IF EXISTS "anon_read_trend_summaries"        ON trend_summaries;
DROP POLICY IF EXISTS "service_all_trend_summaries"      ON trend_summaries;
DROP POLICY IF EXISTS "anon can log interactions"        ON user_interactions;
DROP POLICY IF EXISTS "anon can read saved_articles"     ON saved_articles;
DROP POLICY IF EXISTS "anon can save articles"           ON saved_articles;
DROP POLICY IF EXISTS "anon can unsave articles"         ON saved_articles;
DROP POLICY IF EXISTS "anon_read_categories"             ON categories;
DROP POLICY IF EXISTS "anon_read_sources"                ON sources;
DROP POLICY IF EXISTS "anon_read_articles"               ON articles;
DROP POLICY IF EXISTS "anon_read_article_analyses"       ON article_analyses;
DROP POLICY IF EXISTS "anon_read_daily_summaries"        ON daily_summaries;
DROP POLICY IF EXISTS "anon_read_trend_summaries"        ON trend_summaries;
DROP POLICY IF EXISTS "anon_insert_interactions"         ON user_interactions;
DROP POLICY IF EXISTS "anon_read_saved_articles"         ON saved_articles;
DROP POLICY IF EXISTS "anon_insert_saved_articles"       ON saved_articles;
DROP POLICY IF EXISTS "anon_delete_saved_articles"       ON saved_articles;

-- ── categories — read only ─────────────────────────────────────────────────

CREATE POLICY "auth_read_categories"
  ON categories FOR SELECT TO authenticated USING (true);

-- ── sources — read only ────────────────────────────────────────────────────

CREATE POLICY "auth_read_sources"
  ON sources FOR SELECT TO authenticated USING (true);

-- ── articles — read only ───────────────────────────────────────────────────

CREATE POLICY "auth_read_articles"
  ON articles FOR SELECT TO authenticated USING (true);

-- ── article_analyses — read only ───────────────────────────────────────────
-- INSERT is handled by generate-analysis Edge Function via service_role.

CREATE POLICY "auth_read_article_analyses"
  ON article_analyses FOR SELECT TO authenticated USING (true);

-- ── daily_summaries — read only ────────────────────────────────────────────

CREATE POLICY "auth_read_daily_summaries"
  ON daily_summaries FOR SELECT TO authenticated USING (true);

-- ── trend_summaries — read only ────────────────────────────────────────────

CREATE POLICY "auth_read_trend_summaries"
  ON trend_summaries FOR SELECT TO authenticated USING (true);

-- ── user_interactions — insert only (no read — protects usage privacy) ─────

CREATE POLICY "auth_insert_interactions"
  ON user_interactions FOR INSERT TO authenticated WITH CHECK (true);

-- ── saved_articles — read, save, unsave ───────────────────────────────────

CREATE POLICY "auth_read_saved_articles"
  ON saved_articles FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_insert_saved_articles"
  ON saved_articles FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "auth_delete_saved_articles"
  ON saved_articles FOR DELETE TO authenticated USING (true);

-- ── raw_emails — fully blocked (pipeline only, via service_role) ───────────
-- No policies added. RLS enabled = all authenticated access denied.

-- ── _pipeline_config — fully blocked (internal cron config) ───────────────
-- Contains Supabase URL + anon key used by pg_cron jobs.
-- No authenticated access needed — only pg_cron (service_role) reads this.

-- ── Verify final state ─────────────────────────────────────────────────────

SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
