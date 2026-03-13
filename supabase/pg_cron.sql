-- ============================================================
-- EJ Newsfeed — Supabase Scheduled Jobs via pg_cron + pg_net
-- ============================================================
--
-- BEFORE RUNNING THIS FILE:
-- 1. Go to Supabase Dashboard → Settings → Extensions
-- 2. Enable:  pg_cron   (under "Postgres Extensions")
--             pg_net    (under "Postgres Extensions")
-- 3. Then run this entire file in SQL Editor → New Query
--
-- SCHEDULE (adjust UTC times for your timezone):
--   ET (UTC-5 winter / UTC-4 summer)
--   7:00 AM ET = 12:00 UTC (winter)  or 11:00 UTC (summer)
--   7:10 AM ET = 12:10 UTC (winter)  or 11:10 UTC (summer)
--
--   The jobs below use 12:00 / 12:10 UTC (Eastern Standard Time).
--   In summer (EDT), update to 11:00 / 11:10 UTC.
-- ============================================================

-- ── Step 1: Enable extensions ─────────────────────────────────────────────
-- (You may have already done this in the dashboard; safe to run anyway)

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Step 2: Store your Supabase project URL and anon key ──────────────────
-- Replace the placeholders below with your actual values from:
-- Supabase Dashboard → Project Settings → API

-- We store these in a simple config table so the cron jobs can read them
-- without hardcoding secrets in the schedule definition.

CREATE TABLE IF NOT EXISTS _pipeline_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Insert your project details (update these values!)
INSERT INTO _pipeline_config (key, value)
VALUES
  ('supabase_url',      'https://oqxxmdyyfjgigfjtposv.supabase.co'),
  ('supabase_anon_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xeHhtZHl5ZmpnaWdmanRwb3N2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMTIxOTksImV4cCI6MjA4ODU4ODE5OX0.oTrh2F2s6WHUBPaJ57wWtrDxbNH2C36RMXkvf2cwfCA')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ── Step 3: Schedule fetch-emails (7:00 AM ET = 12:00 UTC, Mon–Fri) ───────

SELECT cron.schedule(
  'fetch-emails-daily',        -- job name (unique)
  '0 12 * * 1-5',              -- cron: 12:00 UTC Mon–Fri
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── Step 4: Schedule process-emails (7:10 AM ET = 12:10 UTC, Mon–Fri) ─────
-- 10-minute gap gives fetch-emails time to finish before processing starts

SELECT cron.schedule(
  'process-emails-daily',      -- job name (unique)
  '10 12 * * 1-5',             -- cron: 12:10 UTC Mon–Fri
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/process-emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── Verify jobs were created ───────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobname;

-- ── Useful management commands ─────────────────────────────────────────────

-- View recent job run history:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Disable a job (stops auto-runs, keeps definition):
-- SELECT cron.unschedule('fetch-emails-daily');

-- Re-enable / update schedule (delete and recreate):
-- SELECT cron.unschedule('fetch-emails-daily');
-- Then re-run the cron.schedule() call above with new timing.

-- ── Summer time adjustment (EDT = UTC-4) ──────────────────────────────────
-- When clocks spring forward, update both jobs to run an hour earlier:
--
-- SELECT cron.unschedule('fetch-emails-daily');
-- SELECT cron.unschedule('process-emails-daily');
-- Then re-run Step 3 & 4 above replacing '0 12' → '0 11' and '10 12' → '10 11'
