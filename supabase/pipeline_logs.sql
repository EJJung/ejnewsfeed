-- ============================================================
-- EJ Newsfeed — Pipeline Run Logging
-- ============================================================
--
-- Creates a pipeline_runs table so every fetch-emails and
-- process-emails invocation leaves a permanent audit trail.
-- Run this once in Supabase SQL Editor → New Query.
--
-- After running, insert your alert webhook URL (optional):
--
--   INSERT INTO _pipeline_config (key, value)
--   VALUES ('alert_webhook_url', 'https://YOUR_WEBHOOK_URL')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- Compatible webhook targets (free tiers):
--   ntfy.sh  — https://ntfy.sh/your-topic (POST, no signup)
--   Discord  — Server Settings → Integrations → Webhooks
--   Slack    — api.slack.com/messaging/webhooks
-- ============================================================

-- ── Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name             TEXT        NOT NULL,                  -- 'fetch-emails' | 'process-emails'
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  status               TEXT        CHECK (status IN ('running', 'success', 'error', 'partial')),
  emails_fetched       INT         DEFAULT 0,   -- fetch-emails: new emails saved
  emails_skipped       INT         DEFAULT 0,   -- fetch-emails: already-stored emails skipped
  emails_processed     INT         DEFAULT 0,   -- process-emails: emails marked processed
  articles_saved       INT         DEFAULT 0,   -- process-emails: articles inserted
  summaries_generated  INT         DEFAULT 0,   -- process-emails: daily summaries upserted
  error_message        TEXT,                    -- first error encountered, if any
  metadata             JSONB                    -- extra context (query used, date range, etc.)
);

-- Index for recent-run lookups
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started
  ON pipeline_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_job_status
  ON pipeline_runs(job_name, status, started_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;

-- Dashboard can read all run records (useful for a future status page)
DROP POLICY IF EXISTS "anon_read_pipeline_runs" ON pipeline_runs;
CREATE POLICY "anon_read_pipeline_runs"
  ON pipeline_runs FOR SELECT TO anon USING (true);

-- Only service_role can insert/update (Edge Functions run as service_role)
-- No anon write policy needed — service_role bypasses RLS entirely.

-- ── Alert webhook config ──────────────────────────────────────────────────
-- Add your webhook URL here so fetch-emails / process-emails can call it
-- when a critical error occurs (token failure, Claude API down, etc.).

INSERT INTO _pipeline_config (key, value)
VALUES ('alert_webhook_url', '')
ON CONFLICT (key) DO NOTHING;

-- ── Convenience view: last 7 days of runs ─────────────────────────────────

CREATE OR REPLACE VIEW pipeline_run_summary AS
SELECT
  job_name,
  date_trunc('day', started_at AT TIME ZONE 'America/New_York') AS run_date_et,
  status,
  emails_fetched,
  emails_processed,
  articles_saved,
  summaries_generated,
  ROUND(EXTRACT(EPOCH FROM (completed_at - started_at))::numeric, 1) AS duration_seconds,
  error_message,
  started_at
FROM pipeline_runs
WHERE started_at >= now() - INTERVAL '7 days'
ORDER BY started_at DESC;

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'pipeline_runs'
ORDER BY ordinal_position;
