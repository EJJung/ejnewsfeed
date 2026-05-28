-- ============================================================
-- EJ Newsfeed — Afternoon pipeline run (6 PM EDT)
-- ============================================================
--
-- WHY: The morning run (10:00 AM EDT) only fetches newsletters that
-- arrived in Gmail by that time. Many newsletters are delivered in
-- the afternoon. Without a second run, those articles are missed
-- until the following morning.
--
-- This adds fetch-emails at 6:00 PM EDT (22:00 UTC) and
-- process-emails at 6:10 PM EDT (22:10 UTC), every day.
-- A summary-guarantee pass runs at 6:25 PM EDT (22:25 UTC).
--
-- HOW TO RUN: paste this into Supabase SQL Editor → New Query
-- (Requires pg_cron, pg_net, and _pipeline_config from pg_cron.sql)
--
-- TIMEZONE NOTE: These use 22:xx UTC = 6:xx PM EDT (UTC-4, summer).
-- In winter (EST, UTC-5), update to 23:xx UTC.
-- ============================================================

-- ── fetch-emails: 6:00 PM EDT (22:00 UTC) ────────────────────────────────

SELECT cron.schedule(
  'fetch-emails-afternoon',       -- job name (unique)
  '0 22 * * *',                   -- cron: 22:00 UTC = 6:00 PM EDT every day
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

-- ── process-emails: 6:10 PM EDT (22:10 UTC) ──────────────────────────────

SELECT cron.schedule(
  'process-emails-afternoon',     -- job name (unique)
  '10 22 * * *',                  -- cron: 22:10 UTC = 6:10 PM EDT every day
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

-- ── summary guarantee: 6:25 PM EDT (22:25 UTC) ───────────────────────────
-- Mirrors the morning summary-guarantee pattern: if process-emails' background
-- work ran out of time, this pass skips already-processed emails and regenerates
-- any missing summaries for today.

SELECT cron.schedule(
  'process-emails-afternoon-guarantee',   -- job name (unique)
  '25 22 * * *',                          -- cron: 22:25 UTC = 6:25 PM EDT every day
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
