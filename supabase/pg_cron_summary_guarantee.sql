-- ============================================================
-- Guarantee daily summary generation via a second process-emails run
-- ============================================================
--
-- WHY: process-emails uses EdgeRuntime.waitUntil() for background
-- processing. If article extraction uses up the time budget, summary
-- generation never runs. A second call 25 minutes later skips
-- already-processed emails (processed=true) and goes straight to
-- summary generation — cheaply and reliably.
--
-- SCHEDULE:
--   First run:  14:10 UTC = 10:10am EDT (existing job)
--   Second run: 14:35 UTC = 10:35am EDT (this job — new)
--
-- HOW TO RUN: paste this into Supabase SQL Editor → New Query
-- ============================================================

SELECT cron.schedule(
  'process-emails-summary-guarantee',   -- job name (unique)
  '35 14 * * *',                      -- cron: 14:35 UTC = 10:35am EDT Mon–Fri
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

-- Verify all three jobs are active:
SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobname;
