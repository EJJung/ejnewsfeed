-- ============================================================
-- EJ Newsfeed — YouTube Ingestion Schema
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- Adds YouTube as a source type alongside newsletters. raw_videos
-- mirrors raw_emails as the ingestion buffer; articles gains
-- content_type + video-specific columns so a video row looks just
-- like any other article to daily_summaries/distill-insights/the
-- Knowledge view.
-- ============================================================

-- ── sources: describe non-email sources ─────────────────────────────────────

ALTER TABLE sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'newsletter'
  CHECK (source_type IN ('newsletter','youtube','rss','podcast'));
ALTER TABLE sources ADD COLUMN youtube_channel_id   TEXT UNIQUE;
ALTER TABLE sources ADD COLUMN feed_url             TEXT;
ALTER TABLE sources ADD COLUMN min_duration_seconds INT NOT NULL DEFAULT 300;
ALTER TABLE sources ADD COLUMN last_polled_at       TIMESTAMPTZ;

-- ── raw_videos: ingestion buffer (mirrors raw_emails) ───────────────────────

CREATE TABLE raw_videos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_video_id  TEXT UNIQUE NOT NULL,
  source_id         UUID REFERENCES sources(id),
  title             TEXT NOT NULL,
  description       TEXT,
  url               TEXT,
  thumbnail_url     TEXT,
  published_at      TIMESTAMPTZ,
  duration_seconds  INT,
  transcript        TEXT,
  transcript_lang   TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','enriched','too_short','transcribed',
                                      'no_captions','error','processed')),
  attempts          INT NOT NULL DEFAULT 0,
  error_message     TEXT,
  processed         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_raw_videos_status    ON raw_videos(status) WHERE processed = false;
CREATE INDEX idx_raw_videos_published ON raw_videos(published_at DESC);

ALTER TABLE raw_videos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_raw_videos" ON raw_videos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── articles: mark content type ──────────────────────────────────────────────

ALTER TABLE articles ADD COLUMN content_type TEXT NOT NULL DEFAULT 'newsletter'
  CHECK (content_type IN ('newsletter','web_article','youtube','podcast'));
ALTER TABLE articles ADD COLUMN raw_video_id     UUID REFERENCES raw_videos(id);
ALTER TABLE articles ADD COLUMN duration_seconds INT;
ALTER TABLE articles ADD COLUMN thumbnail_url    TEXT;

CREATE INDEX idx_articles_content_type ON articles(content_type);

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'sources' AND column_name IN
  ('source_type','youtube_channel_id','feed_url','min_duration_seconds','last_polled_at')
ORDER BY column_name;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'raw_videos' ORDER BY ordinal_position;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'articles' AND column_name IN
  ('content_type','raw_video_id','duration_seconds','thumbnail_url')
ORDER BY column_name;
