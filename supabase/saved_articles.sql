-- saved_articles table
-- Run this in Supabase SQL Editor before deploying the dashboard update.

CREATE TABLE IF NOT EXISTS saved_articles (
  article_id UUID PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  saved_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE saved_articles ENABLE ROW LEVEL SECURITY;

-- Idempotent policies
DROP POLICY IF EXISTS "anon read saved_articles"   ON saved_articles;
DROP POLICY IF EXISTS "anon insert saved_articles" ON saved_articles;
DROP POLICY IF EXISTS "anon delete saved_articles" ON saved_articles;
DROP POLICY IF EXISTS "anon update saved_articles" ON saved_articles;

-- Anon can read, insert, update, and delete (personal single-user tool)
CREATE POLICY "anon read saved_articles"
  ON saved_articles FOR SELECT TO anon USING (true);

CREATE POLICY "anon insert saved_articles"
  ON saved_articles FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon update saved_articles"
  ON saved_articles FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon delete saved_articles"
  ON saved_articles FOR DELETE TO anon USING (true);
