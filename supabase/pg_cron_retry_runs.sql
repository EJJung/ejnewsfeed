-- ============================================================
-- EJ Newsfeed — process-emails retry invocations
-- ============================================================
--
-- WHY: process-emails processes at most 2 emails per invocation
-- (hardcoded limit to avoid the 150s EdgeRuntime timeout).
-- On a typical weekday with 5–10 newsletters, a single invocation
-- clears only 2 emails. These retry jobs fire 3 and 6 minutes after
-- the main run so up to 6 emails are cleared per morning/afternoon
-- window rather than 2.
--
-- SCHEDULE OVERVIEW (EDT, UTC-4) — runs every day including weekends:
--   Morning window:
--     10:10 AM — process-emails-daily          (main, pg_cron.sql)
--     10:13 AM — process-emails-morning-retry1 (this file)
--     10:16 AM — process-emails-morning-retry2 (this file)
--
--   Afternoon window:
--     06:10 PM — process-emails-afternoon       (main, pg_cron_afternoon_run.sql)
--     06:13 PM — process-emails-afternoon-retry1 (this file)
--     06:16 PM — process-emails-afternoon-retry2 (this file)
--
-- TIMEZONE NOTE: Times below use UTC.
--   EDT (summer, UTC-4): 14:xx UTC = 10:xx AM, 22:xx UTC = 06:xx PM
--   EST (winter, UTC-5): bump all hours +1 (15:xx and 23:xx)
--
-- HOW TO RUN: paste into Supabase SQL Editor → New Query
-- Requires pg_cron, pg_net, and _pipeline_config from pg_cron.sql
-- ============================================================

-- ── Morning retries ───────────────────────────────────────────────────────────

SELECT cron.schedule(
  'process-emails-morning-retry1',
  '13 14 * * *',   -- 14:13 UTC = 10:13 AM EDT Mon–Fri
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

SELECT cron.schedule(
  'process-emails-morning-retry2',
  '16 14 * * *',   -- 14:16 UTC = 10:16 AM EDT Mon–Fri
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

-- ── Afternoon retries ─────────────────────────────────────────────────────────

SELECT cron.schedule(
  'process-emails-afternoon-retry1',
  '13 22 * * *',   -- 22:13 UTC = 06:13 PM EDT Mon–Fri
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

SELECT cron.schedule(
  'process-emails-afternoon-retry2',
  '16 22 * * *',   -- 22:16 UTC = 06:16 PM EDT Mon–Fri
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

-- ── Verify all jobs ───────────────────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobname;
