-- ============================================================
-- EJ Newsfeed — Trend Summaries Schema
-- Run in Supabase SQL Editor → New Query
-- ============================================================

-- ── Table ─────────────────────────────────────────────────────────────────

CREATE TABLE trend_summaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_type  TEXT NOT NULL CHECK (period_type IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  period_label TEXT NOT NULL,   -- '2026-W11', '2026-03', '2026-Q1', '2026'
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  category_id  UUID REFERENCES categories(id),
  summary      TEXT,            -- Claude-generated trend narrative
  article_count INT,            -- total articles in this period
  key_themes   JSONB,           -- string[] — recurring themes identified
  generated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(period_type, period_label, category_id)
);

CREATE INDEX idx_trend_summaries_category  ON trend_summaries(category_id);
CREATE INDEX idx_trend_summaries_period    ON trend_summaries(period_type, period_start DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE trend_summaries ENABLE ROW LEVEL SECURITY;

-- Anon (dashboard) can read trend summaries
CREATE POLICY "anon_read_trend_summaries"
  ON trend_summaries FOR SELECT
  TO anon
  USING (true);

-- Service role (Edge Functions) can do everything
CREATE POLICY "service_all_trend_summaries"
  ON trend_summaries FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
