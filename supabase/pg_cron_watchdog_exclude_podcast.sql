-- ============================================================
-- EJ Newsfeed — Exempt generate-podcast from the stale-runs watchdog
-- ============================================================
--
-- WHY: pg_cron_watchdog_stale_runs.sql marks ANY pipeline_runs row
-- still status='running' more than 5 minutes after started_at as
-- 'error', with no job_name filter. That 5-minute threshold was
-- calibrated for process-emails, whose real completed runs take
-- 60-90s. generate-podcast is a categorically different shape of
-- job: worst case is one Claude call (up to a 120s timeout) plus up
-- to ~4 sequential ElevenLabs TTS calls (each up to a 60s timeout)
-- plus a Storage upload — a worst-case wall-clock that can plausibly
-- approach or exceed 5 minutes. Left unfiltered, the watchdog can
-- fire a false-positive stale-alert on a generate-podcast run that
-- is still legitimately in progress, racing against the function's
-- own terminal status='success' write.
--
-- This re-schedules the SAME job ('pipeline-runs-watchdog') with the
-- SAME 10-minute cadence and SAME alerting logic as
-- pg_cron_watchdog_stale_runs.sql, adding
-- "AND job_name <> 'generate-podcast'" to the stale-row UPDATE...WHERE
-- clause so generate-podcast runs are exempted from the blanket
-- 5-minute rule. All other job_names are still held to the original
-- 5-minute threshold.
--
-- cron.schedule() upserts by job name, so calling it again with
-- 'pipeline-runs-watchdog' replaces the previously installed
-- definition in place — no cron.unschedule() needed first (same
-- pattern used by pg_cron_retry_runs.sql to re-apply jobs already
-- installed by pg_cron_install_supplemental.sql).
--
-- HOW TO RUN: paste into Supabase SQL Editor -> New Query
-- Requires pg_cron, pg_net, and _pipeline_config from pg_cron.sql
-- (already applied, since pg_cron_watchdog_stale_runs.sql exists)
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
          AND job_name <> 'generate-podcast'
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

-- Verify the job was updated (same jobid as before, new definition)
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'pipeline-runs-watchdog';

-- ── Useful management commands ─────────────────────────────────────────────

-- View recent watchdog activity:
-- SELECT * FROM pipeline_runs WHERE error_message LIKE 'Marked stale by watchdog%' ORDER BY started_at DESC;

-- Disable the watchdog:
-- SELECT cron.unschedule('pipeline-runs-watchdog');
