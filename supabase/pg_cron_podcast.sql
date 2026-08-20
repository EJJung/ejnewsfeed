-- ============================================================
-- EJ Newsfeed — pg_cron Schedule for Podcast Daily Brief
-- Run in Supabase SQL Editor → New Query
-- (Requires pg_cron and pg_net already enabled from pg_cron.sql)
-- ============================================================
--
-- Fires 5 minutes after distill-insights' daily run (22:30 UTC), so the
-- brief reflects the full day including that run's freshly-extracted
-- insights context. All times UTC.
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

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'podcast-daily-brief';
