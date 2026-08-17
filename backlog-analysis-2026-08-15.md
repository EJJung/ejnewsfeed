# Backlog Investigation — Why 998 Emails Are "Stuck"

> Generated: 2026-08-15 · Analysis of audit history (May 27 – Aug 14) + pipeline code

## Verdict

The 998 unprocessed emails are **genuinely unreachable — permanently orphaned by design**, not leftover rows from before the May fixes. The backlog has grown monotonically by **~15/day** since the May 27 audit (124 → 998, never decreasing once) and will keep growing forever until the design is changed.

## The Mechanism (two interacting constraints)

**1. `process-emails` can only see *today's* emails.**
`supabase/functions/process-emails/index.ts` (line ~292) selects:

```
processed = false
AND received_at >= <today 00:00 UTC>
AND received_at <= <today 23:59 UTC>
```

The comment says this was intentional ("never process stale backlog emails"). The consequence: any email not processed by **midnight UTC (8:00 PM EDT) on its arrival day** becomes invisible to every future run. `processed` stays `false` forever. That's the entire backlog — a graveyard of daily spillover.

**2. Daily capacity < daily arrivals.**
Each invocation processes at most 2 emails (`limit(2)`). The pg_cron schedule fires `process-emails` 6× per day (14:10/13/16 and 22:10/13/16 UTC), plus 2 summary-guarantee passes → **~12–16 emails/day max capacity**. With 77 active sources, arrivals run ~25–30/day on weekdays. The excess (~15/day) spills past midnight UTC and is orphaned by constraint 1.

## Evidence from the audit history

| Date | Backlog | Delta |
|---|---|---|
| 2026-05-27 | 124 | — |
| 2026-06-13 | 328 | +204 in 17 days |
| 2026-07-11 | 676 | +348 in 28 days |
| 2026-08-14 | 998 | +322 in 34 days |

- The backlog **never decreased once** across 56 audits — confirming no run ever touches old rows.
- Saturday audits (which ran after the pipeline, unlike weekday ones) show days where all of that day's fetched emails were processed (e.g., "10 fetched, 10/10 processed") — yet the backlog still grew, because the growth is *yesterday's* spillover, not that day's.
- Weekday processing works fine for what it can reach: Aug 13 produced 80 articles. The pipeline isn't broken — it's under-provisioned and forgetful.

## Secondary findings

- **Evening emails are never fetched at all.** `fetch-emails` queries Gmail for `after:<today> before:<tomorrow>` only. The last fetch is 22:00 UTC (6 PM EDT); emails arriving after that are excluded from the next day's query too — they never even reach `raw_emails`. This is a silent ingestion leak on top of the processing leak.
- **The audit's weekday timing is still wrong.** Reports generate at 12:12 UTC (8:12 AM EDT), before the 14:00 UTC pipeline — so "0 emails today / 0 articles today / 0 summaries" failures on weekday reports are artifacts, not real failures. (Fix plan's Fix 6 called for 11 AM; launchd is still effectively running earlier.)
- Because of the above, every audit since May reads **DEGRADED**, which buries the one real signal (backlog growth) in noise.

## Recommended fixes

1. **Triage the 998 (5 min).** Their news value has expired. Mark them resolved so the metric becomes meaningful again — e.g. add a `skipped_stale` status or simply `UPDATE raw_emails SET processed = true WHERE processed = false AND received_at < '2026-08-15'`. (Optionally keep the last ~3 days for backfill.)
2. **Stop the orphaning (small code change).** In `process-emails`, replace the today-only window with a rolling window (e.g., last 72h), keeping `order received_at ascending`. Spillover then gets caught the next morning instead of dying at midnight.
3. **Match capacity to arrivals.** Either raise `limit(2)` → 4 (with the retry jobs that's 24–32/day), or add two more retry invocations per window. Watch the 150s EdgeRuntime budget — the original reason for `limit(2)`.
4. **Fix the evening fetch leak.** Widen the Gmail query to `after:<yesterday>` — dedupe via `gmail_message_id` already makes this safe and idempotent.
5. **Fix audit timing** so weekday reports run after the 14:16 UTC pass (e.g., 15:00 UTC / 11 AM EDT), and change the backlog check to only count emails older than N hours as "stuck."
