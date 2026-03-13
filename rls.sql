-- ============================================================
-- EJ Newsfeed — Row Level Security
-- Run this in Supabase SQL Editor to fix all security lints.
-- The pipeline uses the service_role key which bypasses RLS,
-- so these policies only govern dashboard (anon key) access.
-- ============================================================

-- ------------------------------------------------------------
-- Enable RLS on all tables
-- ------------------------------------------------------------
ALTER TABLE categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources           ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_analyses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_articles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_emails        ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- categories — dashboard reads only
-- ------------------------------------------------------------
CREATE POLICY "anon can read categories"
  ON categories FOR SELECT TO anon USING (true);

-- ------------------------------------------------------------
-- sources — dashboard reads only
-- ------------------------------------------------------------
CREATE POLICY "anon can read sources"
  ON sources FOR SELECT TO anon USING (true);

-- ------------------------------------------------------------
-- articles — dashboard reads only
-- ------------------------------------------------------------
CREATE POLICY "anon can read articles"
  ON articles FOR SELECT TO anon USING (true);

-- ------------------------------------------------------------
-- article_analyses — dashboard reads; also inserts when
-- triggering on-demand analysis generation
-- ------------------------------------------------------------
CREATE POLICY "anon can read article_analyses"
  ON article_analyses FOR SELECT TO anon USING (true);

CREATE POLICY "anon can insert article_analyses"
  ON article_analyses FOR INSERT TO anon WITH CHECK (true);

-- ------------------------------------------------------------
-- daily_summaries — dashboard reads only
-- ------------------------------------------------------------
CREATE POLICY "anon can read daily_summaries"
  ON daily_summaries FOR SELECT TO anon USING (true);

-- ------------------------------------------------------------
-- user_interactions — dashboard inserts only (interaction logging)
-- ------------------------------------------------------------
CREATE POLICY "anon can log interactions"
  ON user_interactions FOR INSERT TO anon WITH CHECK (true);

-- ------------------------------------------------------------
-- saved_articles — dashboard reads, saves, and unsaves
-- ------------------------------------------------------------
CREATE POLICY "anon can read saved_articles"
  ON saved_articles FOR SELECT TO anon USING (true);

CREATE POLICY "anon can save articles"
  ON saved_articles FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon can unsave articles"
  ON saved_articles FOR DELETE TO anon USING (true);

-- ------------------------------------------------------------
-- raw_emails — no public access (pipeline only, via service_role)
-- ------------------------------------------------------------
-- No policies added. RLS enabled = all anon access blocked.
