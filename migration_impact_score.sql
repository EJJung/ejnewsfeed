-- ============================================================
-- EJ Newsfeed — Impact Score Migration
-- Run this in Supabase: SQL Editor > New Query
-- Safe to run on an existing database (uses IF NOT EXISTS / DO blocks)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Add impact_score to articles
-- ------------------------------------------------------------
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS impact_score FLOAT DEFAULT 0.5;

-- Index for sorting by impact on the dashboard
CREATE INDEX IF NOT EXISTS idx_articles_impact
  ON articles(impact_score DESC);

-- ------------------------------------------------------------
-- 2. Add tier to sources
--    A = highest-signal, editorial, expert-authored
--    B = good, broad-audience newsletters
--    C = unknown / auto-created from incoming email
-- ------------------------------------------------------------
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'C'
  CHECK (tier IN ('A', 'B', 'C'));

-- ------------------------------------------------------------
-- 3. Set tiers on existing seed sources
-- ------------------------------------------------------------

-- Tier A — deep signal, expert-authored, low noise
UPDATE sources SET tier = 'A' WHERE email_address IN (
  'ben@stratechery.com',              -- Stratechery
  'ben@ben-evans.com',                -- Benedict Evans
  'newsletters@technologyreview.com'  -- MIT Tech Review
);

-- Tier B — quality, broad-audience newsletters
UPDATE sources SET tier = 'B' WHERE email_address IN (
  'crew@morningbrew.com',             -- Morning Brew
  'team@thehustle.co',                -- The Hustle
  'dan@tldrnewsletter.com',           -- TLDR Newsletter
  'hello@uxdesign.cc',                -- UX Collective
  'noreply@producthunt.com'           -- Product Hunt Daily
);

-- All other sources stay at tier = 'C' (the column default)
