-- ============================================================
-- EJ Newsfeed — pg_cron Schedule for Insight Distillation
-- Run in Supabase SQL Editor → New Query
-- (Requires pg_cron and pg_net already enabled from pg_cron.sql)
-- ============================================================
--
-- Daily:  22:30 UTC — 5 min after process-emails-afternoon-guarantee (22:25),
--         so impact_score/daily_summaries are settled before extraction runs.
-- Weekly: Monday 13:00 UTC — 30 min after generate-trends' weekly run (12:30),
--         no hard dependency, just avoids overlapping Claude call bursts.
-- ============================================================

SELECT cron.schedule(
  'daily-distill-insights',
  '30 22 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/distill-insights',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"daily"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'weekly-distill-insights',
  '0 13 * * 1',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/distill-insights',
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
WHERE jobname IN ('daily-distill-insights', 'weekly-distill-insights')
ORDER BY jobname;
