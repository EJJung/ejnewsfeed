-- ============================================================
-- EJ Newsfeed — Install All Supplemental pg_cron Jobs
-- ============================================================
--
-- Run this in Supabase SQL Editor → New Query to install the
-- retry and summary-guarantee jobs that clear the backlog and
-- ensure summaries always generate.
--
-- SAFE TO RE-RUN: uses unschedule() first so duplicate jobs
-- are never created.
--
-- SCHEDULE OVERVIEW (EDT = UTC-4, summer):
--
--   Morning window:
--     10:00 AM → fetch-emails-daily          (pg_cron.sql — already installed)
--     10:10 AM → process-emails-daily        (pg_cron.sql — already installed)
--     10:13 AM → process-emails-morning-retry1   ← this file
--     10:16 AM → process-emails-morning-retry2   ← this file
--     10:35 AM → process-emails-summary-guarantee ← this file
--
--   Afternoon window:
--     06:00 PM → fetch-emails-afternoon      (pg_cron_afternoon_run.sql)
--     06:10 PM → process-emails-afternoon    (pg_cron_afternoon_run.sql)
--     06:13 PM → process-emails-afternoon-retry1  ← this file
--     06:16 PM → process-emails-afternoon-retry2  ← this file
--     06:25 PM → process-emails-afternoon-guarantee (pg_cron_afternoon_run.sql)
--
-- Why retries: LIMIT 2 per invocation means 3 invocations × 2 = 6 emails
-- cleared per window. The newest-first ordering (fixed 2026-05-27) means
-- today's newsletters are always processed in the first invocation.
-- ============================================================

-- ── Drop existing supplemental jobs (idempotent) ─────────────────────────

SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN (
  'process-emails-morning-retry1',
  'process-emails-morning-retry2',
  'process-emails-summary-guarantee',
  'process-emails-afternoon-retry1',
  'process-emails-afternoon-retry2'
);

-- ── Morning retry 1: 10:13 AM EDT (14:13 UTC) ─────────────────────────────

SELECT cron.schedule(
  'process-emails-morning-retry1',
  '13 14 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/process-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- ── Morning retry 2: 10:16 AM EDT (14:16 UTC) ─────────────────────────────

SELECT cron.schedule(
  'process-emails-morning-retry2',
  '16 14 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/process-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- ── Morning summary guarantee: 10:35 AM EDT (14:35 UTC) ───────────────────
-- Runs after articles are extracted, ensures summaries generate even if
-- the first runs exhausted their EdgeRuntime budget on article extraction.

SELECT cron.schedule(
  'process-emails-summary-guarantee',
  '35 14 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/process-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- ── Afternoon retry 1: 06:13 PM EDT (22:13 UTC) ───────────────────────────

SELECT cron.schedule(
  'process-emails-afternoon-retry1',
  '13 22 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/process-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- ── Afternoon retry 2: 06:16 PM EDT (22:16 UTC) ───────────────────────────

SELECT cron.schedule(
  'process-emails-afternoon-retry2',
  '16 22 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/process-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- ── Verify all active jobs ────────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobname;
