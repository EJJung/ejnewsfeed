# EJ Newsfeed Pipeline Audit — 2026-03-21 (Saturday)

> **Note:** Today is Saturday. The pipeline runs Mon–Fri only (pg_cron: `0 14 * * 1-5`), so no run was expected today. This audit evaluates the most recent weekday run (Friday, March 20).

---

## Check Results

| Check | Status | Detail |
|---|---|---|
| **fetch-emails** | ⚠️ Indeterminate | `raw_emails` table has 0 rows total — emails appear to be purged after processing (or RLS blocks anon reads). Cannot confirm Friday's fetch directly. |
| **process-emails** | ✅ Pass | **20 articles** extracted with `published_at` = 2026-03-20. Pipeline produced content on Friday. |
| **daily summaries** | ❌ Fail | **0 summaries** for 2026-03-20. Last summaries are from **2026-03-19** (3 categories, 34 articles). Friday's summaries were never generated. |
| **unprocessed backlog** | ✅ Pass | 0 unprocessed emails in queue. |

---

## Summary

```
📊 EJ Newsfeed Pipeline Audit — 2026-03-21 (Sat)

⚠️  fetch-emails:     indeterminate (raw_emails table empty; likely purged post-processing)
✅  process-emails:   20 articles extracted on Fri 3/20
❌  daily summaries:  0 summaries for Fri 3/20 (last generated: Wed 3/19)
✅  unprocessed:      0 emails pending

Overall: DEGRADED
```

---

## Observations

1. **Daily summaries gap on Friday 3/20:** Articles were successfully extracted (20 articles), but the daily summary generation step did not run or failed silently. The last summaries were generated on Wednesday 3/19 across 3 categories (20 + 2 + 12 = 34 articles). Thursday 3/18 also appears to have no summaries — the pattern before that jumps to Monday 3/17.

2. **raw_emails table is always empty (0 rows):** This suggests either (a) the pipeline deletes raw emails after processing, or (b) RLS policies prevent the anon key from reading `raw_emails`. This makes it impossible to directly verify whether `fetch-emails` ran. Since articles were produced on Friday, the fetch likely did run.

3. **One future-dated article:** There's an article titled "The AI Marketing Playbook (Webinar)" with `published_at` = 2026-03-26, which is 5 days in the future. This is likely a newsletter promoting an upcoming event — not a pipeline bug, but worth noting.

4. **Total pipeline health:** 441 articles and 19 daily summaries in the database. The pipeline is generally functional, but the daily summary generation has been inconsistent (missing for Friday 3/20 and possibly Thursday 3/18).

---

## Recommended Actions

- **Investigate daily summary generation:** Check why summaries weren't created for Friday 3/20 despite 20 articles being available. The summary generation may be a separate step not triggered by pg_cron, or it may have errored silently.
- **Check `raw_emails` RLS policies:** Confirm whether the anon key is supposed to have read access. If emails are intentionally purged, consider adding a lightweight `pipeline_runs` log table to track fetch-emails execution history.
- **Review summary generation for 3/18 and 3/20:** Determine if there's a pattern to the missing summaries (they exist for Mon 3/17 and Wed 3/19 but not the days between/after).
