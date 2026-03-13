-- ============================================================
-- EJ Newsfeed — pg_cron Schedules for Trend Summaries
-- Run in Supabase SQL Editor → New Query
-- (Requires pg_cron and pg_net already enabled from pg_cron.sql)
-- ============================================================
--
-- All times in UTC. ET (UTC-5 winter / UTC-4 summer).
-- 7:30am ET = 12:30 UTC (winter) / 11:30 UTC (summer)
-- Using 12:30 UTC (EST). Update to 11:30 in summer.
-- ============================================================

-- ── Weekly: every Monday at 7:30am ET (summarizes previous week) ──────────

SELECT cron.schedule(
  'weekly-trends',
  '30 12 * * 1',   -- 12:30 UTC Monday
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/generate-trends',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"periodType":"weekly"}'::jsonb
    );
  $$
);

-- ── Monthly: 1st of every month at 7:30am ET (summarizes previous month) ──

SELECT cron.schedule(
  'monthly-trends',
  '30 12 1 * *',   -- 12:30 UTC on 1st of month
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/generate-trends',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"periodType":"monthly"}'::jsonb
    );
  $$
);

-- ── Quarterly: Jan 1 / Apr 1 / Jul 1 / Oct 1 at 7:30am ET ───────────────

SELECT cron.schedule(
  'quarterly-trends',
  '30 12 1 1,4,7,10 *',   -- 12:30 UTC on 1st of Jan/Apr/Jul/Oct
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/generate-trends',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"periodType":"quarterly"}'::jsonb
    );
  $$
);

-- ── Yearly: Jan 1 at 8:00am ET (after quarterly runs) ────────────────────

SELECT cron.schedule(
  'yearly-trends',
  '0 13 1 1 *',   -- 13:00 UTC on Jan 1 (after quarterly at 12:30)
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/generate-trends',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"periodType":"yearly"}'::jsonb
    );
  $$
);

-- ── Verify all jobs ───────────────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobname;
