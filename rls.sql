-- ============================================================
-- EJ Newsfeed — Row Level Security (consolidated)
-- Run this in Supabase SQL Editor → New Query
-- Safe to re-run: uses DROP IF EXISTS before each CREATE
-- ============================================================
--
-- Access model:
--   anon key  = dashboard (read-only on most tables, write on interactions/saves)
--   service_role = Edge Functions (bypasses RLS entirely — no policies needed)
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

-- ── categories — read only ─────────────────────────────────────────────────

CREATE POLICY "anon_read_categories"
  ON categories FOR SELECT TO anon USING (true);

-- ── sources — read only ────────────────────────────────────────────────────

CREATE POLICY "anon_read_sources"
  ON sources FOR SELECT TO anon USING (true);

-- ── articles — read only ───────────────────────────────────────────────────

CREATE POLICY "anon_read_articles"
  ON articles FOR SELECT TO anon USING (true);

-- ── article_analyses — read only ───────────────────────────────────────────
-- INSERT is handled by generate-analysis Edge Function via service_role.
-- No anon write access needed.

CREATE POLICY "anon_read_article_analyses"
  ON article_analyses FOR SELECT TO anon USING (true);

-- ── daily_summaries — read only ────────────────────────────────────────────

CREATE POLICY "anon_read_daily_summaries"
  ON daily_summaries FOR SELECT TO anon USING (true);

-- ── trend_summaries — read only ────────────────────────────────────────────

CREATE POLICY "anon_read_trend_summaries"
  ON trend_summaries FOR SELECT TO anon USING (true);

-- ── user_interactions — insert only (no read — protects usage privacy) ─────

CREATE POLICY "anon_insert_interactions"
  ON user_interactions FOR INSERT TO anon WITH CHECK (true);

-- ── saved_articles — read, save, unsave ───────────────────────────────────

CREATE POLICY "anon_read_saved_articles"
  ON saved_articles FOR SELECT TO anon USING (true);

CREATE POLICY "anon_insert_saved_articles"
  ON saved_articles FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_delete_saved_articles"
  ON saved_articles FOR DELETE TO anon USING (true);

-- ── raw_emails — fully blocked (pipeline only, via service_role) ───────────
-- No policies added. RLS enabled = all anon access denied.

-- ── _pipeline_config — fully blocked (internal cron config) ───────────────
-- Contains Supabase URL + anon key used by pg_cron jobs.
-- No anon access needed — only pg_cron (service_role) reads this.

-- ── Verify final state ─────────────────────────────────────────────────────

SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
