-- ============================================================
-- EJ Newsfeed — Supabase Schema
-- Run this in your Supabase project: SQL Editor > New Query
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- Categories (IT, Entrepreneurship, UX Design, Business, AI)
-- ------------------------------------------------------------
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Newsletter Sources (auto-populated from incoming emails)
-- ------------------------------------------------------------
CREATE TABLE sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email_address TEXT UNIQUE,
  website_url   TEXT,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Raw Emails (ingestion layer — stored before processing)
-- ------------------------------------------------------------
CREATE TABLE raw_emails (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id TEXT UNIQUE,
  source_id        UUID REFERENCES sources(id),
  subject          TEXT,
  sender           TEXT,
  received_at      TIMESTAMPTZ,
  raw_html         TEXT,
  raw_text         TEXT,
  processed        BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Articles (extracted & categorized from raw emails)
-- ------------------------------------------------------------
CREATE TABLE articles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_email_id    UUID REFERENCES raw_emails(id),
  source_id       UUID REFERENCES sources(id),
  title           TEXT NOT NULL,
  url             TEXT,
  snippet         TEXT,
  full_content    TEXT,           -- fetched on-demand for Dive view
  primary_category_id UUID REFERENCES categories(id),
  category_tags   TEXT[],         -- multiple categories can apply
  relevance_score FLOAT,          -- 0.0–1.0, used for recommendations
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Article Analyses (generated on-demand when user Dives)
-- ------------------------------------------------------------
CREATE TABLE article_analyses (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id           UUID REFERENCES articles(id) UNIQUE,
  key_points           JSONB,   -- string[]
  so_what              TEXT,
  implications         TEXT,
  interest_connections JSONB,   -- { category: string, connection: string }[]
  generated_at         TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Daily Summaries (synthesized per category, generated each morning)
-- ------------------------------------------------------------
CREATE TABLE daily_summaries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date           DATE NOT NULL,
  category_id    UUID REFERENCES categories(id),
  summary        TEXT,
  article_count  INT,
  generated_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(date, category_id)
);

-- ------------------------------------------------------------
-- User Interactions (tracks EJ's reading behavior — feeds recommendations)
-- ------------------------------------------------------------
CREATE TABLE user_interactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id          UUID REFERENCES articles(id),
  action              TEXT NOT NULL CHECK (action IN ('opened','read_full','saved','dismissed','chat_started','chat_message')),
  time_spent_seconds  INT,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Saved Articles
-- ------------------------------------------------------------
CREATE TABLE saved_articles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID REFERENCES articles(id) UNIQUE,
  notes      TEXT,
  saved_at   TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Indexes for common query patterns
-- ------------------------------------------------------------
CREATE INDEX idx_articles_category    ON articles(primary_category_id);
CREATE INDEX idx_articles_published   ON articles(published_at DESC);
CREATE INDEX idx_interactions_article ON user_interactions(article_id);
CREATE INDEX idx_summaries_date       ON daily_summaries(date DESC);
CREATE INDEX idx_raw_emails_processed ON raw_emails(processed) WHERE processed = false;
