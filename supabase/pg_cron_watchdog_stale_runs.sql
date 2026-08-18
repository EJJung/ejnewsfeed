-- ============================================================
-- EJ Newsfeed — Stale pipeline_runs watchdog
-- ============================================================
--
-- WHY: process-emails uses EdgeRuntime.waitUntil() for background
-- processing. Confirmed 2026-08-17/18: even with proper try/catch and
-- fetch() timeouts in the function code, invocations can still get
-- hard-killed by the platform's background-execution ceiling before
-- ever reaching the code that writes completed_at/status. When that
-- happens, no JS in the function ever runs again — nothing in-process
-- can catch it — and the pipeline_runs row is stuck at status='running'
-- forever, with no error_message. That silently under-reports failures:
-- the daily audit only reads counts for "today", not orphaned rows.
--
-- This job runs every 10 minutes and marks any run still 'running'
-- more than 5 minutes after it started as 'error'. Real completed runs
-- take 60-90s, so 5 minutes is a safe margin with no false positives.
-- If an alert_webhook_url is configured (see pipeline_logs.sql), it
-- also fires a notification when it finds stale rows.
--
-- HOW TO RUN: paste into Supabase SQL Editor -> New Query
-- Requires pg_cron, pg_net, and _pipeline_config from pg_cron.sql
-- ============================================================

SELECT cron.schedule(
  'pipeline-runs-watchdog',
  '*/10 * * * *',   -- every 10 minutes
  $$
    DO $do$
    DECLARE
      stale_count INT;
      webhook_url TEXT;
    BEGIN
      WITH stale AS (
        UPDATE pipeline_runs
        SET completed_at = now(),
            status = 'error',
            error_message = 'Marked stale by watchdog — run never completed within 5 minutes (likely killed by EdgeRuntime background execution limit)'
        WHERE status = 'running'
          AND started_at < now() - INTERVAL '5 minutes'
        RETURNING id
      )
      SELECT count(*) INTO stale_count FROM stale;

      IF stale_count > 0 THEN
        SELECT value INTO webhook_url FROM _pipeline_config WHERE key = 'alert_webhook_url';
        IF webhook_url IS NOT NULL AND webhook_url <> '' THEN
          PERFORM net.http_post(
            url     := webhook_url,
            headers := jsonb_build_object('Content-Type', 'application/json'),
            body    := jsonb_build_object(
              'title', '🚨 EJ Newsfeed Pipeline Watchdog',
              'message', stale_count || ' pipeline_runs row(s) marked stale (stuck in running > 5 min)',
              'job', 'watchdog',
              'timestamp', now()
            )
          );
        END IF;
      END IF;
    END
    $do$;
  $$
);

-- Verify the job was created
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'pipeline-runs-watchdog';

-- ── Useful management commands ─────────────────────────────────────────────

-- View recent watchdog activity:
-- SELECT * FROM pipeline_runs WHERE error_message LIKE 'Marked stale by watchdog%' ORDER BY started_at DESC;

-- Disable the watchdog:
-- SELECT cron.unschedule('pipeline-runs-watchdog');
