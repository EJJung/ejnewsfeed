-- ============================================================
-- EJ Newsfeed — pg_cron Schedule for Podcast Generation
-- Run in Supabase SQL Editor → New Query
-- (Requires pg_cron and pg_net already enabled from pg_cron.sql)
-- ============================================================
--
-- Daily brief fires 5 minutes after distill-insights' daily run (22:30
-- UTC). Weekly deep dive fires 15 minutes after distill-insights' weekly
-- run (Mondays 13:00 UTC), so it reflects that run's freshly-applied
-- promote/merge/contest/reject decisions. All times UTC.
-- ============================================================

SELECT cron.schedule(
  'podcast-daily-brief',
  '35 22 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/generate-podcast',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'podcast-weekly-deep-dive',
  '15 13 * * 1',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/generate-podcast',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"weekly"}'::jsonb
    );
  $$
);

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname IN ('podcast-daily-brief', 'podcast-weekly-deep-dive')
ORDER BY jobname;
