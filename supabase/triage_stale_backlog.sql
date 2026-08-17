-- triage_stale_backlog.sql
-- =========================
-- One-time cleanup for the orphaned raw_emails backlog (998 rows as of 2026-08-14).
--
-- Background: process-emails historically only selected unprocessed emails
-- received *today* (UTC). Anything left over at midnight UTC became permanently
-- unreachable, accumulating ~15 rows/day since at least late May 2026.
-- See backlog-analysis-2026-08-15.md at the repo root.
--
-- This marks every unprocessed email older than the new 72-hour rolling
-- processing window as skipped. Their news value has expired; skipping them
-- (rather than processing) avoids flooding the feed and burning Claude tokens
-- on months-old newsletters. Emails inside the 72h window are left alone —
-- the updated process-emails function will pick those up on its next runs.
--
-- Run this in the Supabase SQL Editor BEFORE deploying the updated
-- process-emails function, so the new rolling window starts from a clean slate.

-- 1. Add a flag so skipped rows stay distinguishable from genuinely
--    processed ones (idempotent).
ALTER TABLE raw_emails ADD COLUMN IF NOT EXISTS skipped_stale BOOLEAN DEFAULT false;

-- 2. Preview what will be skipped (optional sanity check)
SELECT
  count(*)         AS will_skip,
  min(received_at) AS oldest,
  max(received_at) AS newest
FROM raw_emails
WHERE processed = false
  AND received_at < now() - interval '72 hours';

-- 3. Mark them as processed + skipped.
UPDATE raw_emails
SET processed     = true,
    skipped_stale = true
WHERE processed = false
  AND received_at < now() - interval '72 hours';

-- 4. Verify: remaining unprocessed should only be recent (< 72h old)
SELECT count(*)         AS remaining_unprocessed,
       min(received_at) AS oldest_remaining
FROM raw_emails
WHERE processed = false;
