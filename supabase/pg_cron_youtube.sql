-- ============================================================
-- EJ Newsfeed — pg_cron Schedule for YouTube Ingestion
-- Run in Supabase SQL Editor → New Query
-- (Requires pg_cron and pg_net already enabled from pg_cron.sql)
-- ============================================================
--
-- Every 4 hours, staggered 15 minutes apart per stage — tighter than
-- the newsletter lane's 2x/day because AI Engineer's RSS window is
-- only ~1 day deep during conference dumps. All times UTC.
-- ============================================================

SELECT cron.schedule(
  'youtube-poll',
  '0 */4 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-videos',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"poll"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'youtube-enrich',
  '10 */4 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-videos',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"enrich"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'youtube-transcribe',
  '25 */4 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-videos',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"transcribe"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'youtube-process',
  '45 */4 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/process-videos',
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
WHERE jobname IN ('youtube-poll', 'youtube-enrich', 'youtube-transcribe', 'youtube-process')
ORDER BY jobname;
