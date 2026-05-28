-- ============================================================
-- EJ Newsfeed — Switch all cron jobs from weekdays to daily
-- ============================================================
--
-- Run this ONCE in Supabase SQL Editor → New Query.
-- It drops every existing pipeline job and recreates them
-- with * (every day) instead of 1-5 (Mon–Fri).
--
-- Safe to re-run: DROP is wrapped in a SELECT so missing jobs
-- are silently skipped.
-- ============================================================

-- ── Drop all existing pipeline jobs ──────────────────────────────────────

SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN (
  'fetch-emails-daily',
  'fetch-emails-afternoon',
  'process-emails-daily',
  'process-emails-afternoon',
  'process-emails-afternoon-guarantee',
  'process-emails-morning-retry1',
  'process-emails-morning-retry2',
  'process-emails-summary-guarantee',
  'process-emails-afternoon-retry1',
  'process-emails-afternoon-retry2'
);

-- ── Recreate all jobs on a daily schedule ────────────────────────────────
-- Times are UTC (EDT = UTC-4 in summer, EST = UTC-5 in winter).
-- Current schedule assumes EDT (summer). Update hour +1 in winter.

-- fetch-emails: 10:00 AM EDT daily
SELECT cron.schedule(
  'fetch-emails-daily',
  '0 14 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- process-emails: 10:10 AM EDT daily
SELECT cron.schedule(
  'process-emails-daily',
  '10 14 * * *',
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

-- process-emails retry 1: 10:13 AM EDT daily
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

-- process-emails retry 2: 10:16 AM EDT daily
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

-- summary guarantee: 10:35 AM EDT daily
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

-- fetch-emails afternoon: 6:00 PM EDT daily
SELECT cron.schedule(
  'fetch-emails-afternoon',
  '0 22 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- process-emails afternoon: 6:10 PM EDT daily
SELECT cron.schedule(
  'process-emails-afternoon',
  '10 22 * * *',
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

-- process-emails afternoon retry 1: 6:13 PM EDT daily
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

-- process-emails afternoon retry 2: 6:16 PM EDT daily
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

-- afternoon summary guarantee: 6:25 PM EDT daily
SELECT cron.schedule(
  'process-emails-afternoon-guarantee',
  '25 22 * * *',
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

-- ── Verify all jobs ───────────────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobname;
