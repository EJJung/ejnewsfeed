# Knowledge Layer Schema + Distillation — Design

*Drafted 2026-08-18. First sub-project of [Phase 1](../../../knowledge-center-plan.md#phase-1--knowledge-layer--multi-source-ingestion-23-weeks) of the ejnewsfeed knowledge-center plan (items 1b + 1c). Phase 0 (pipeline stabilization) is complete as of commit `8c8b830`.*

## Why this is scoped this way

Phase 1 in the parent plan bundles four fairly independent pieces: generalized ingestion (1a), the knowledge-layer schema (1b), distillation jobs (1c), and a dashboard Knowledge view (1d). This spec covers only 1b + 1c — the schema and the jobs that populate it. It deliberately runs entirely on the newsletter articles the pipeline already ingests, so it's testable immediately without waiting on new ingestion adapters. 1a and 1d are separate, later specs.

## Existing context this design builds on

- `articles` table already has `primary_category_id`, `category_tags TEXT[]`, `impact_score FLOAT` (0–1), populated by `process-emails`.
- `categories` table has 5 rows today: AI, IT, Entrepreneurship, UX Design, Business. The knowledge layer treats all 5 as domains (the parent plan's "AI, entrepreneurship, business, UX" list is extended to include IT since it's already a real, populated category).
- `daily_summaries` (per category, per day, prose) and `trend_summaries` (per category, per period, prose + key_themes, produced weekly/monthly/quarterly/yearly by the existing `generate-trends` function) already exist and are **untouched** by this design — they keep producing prose reports in parallel. The new `insights` table is a structurally different, complementary artifact: atomic, source-linked, status-tracked claims, not narrative text.
- `pipeline_runs` table already tracks job execution (`process-emails`, `fetch-emails`) with `status`/`error_message`/`metadata`; this design reuses it rather than inventing a new run-log table.
- No embeddings/vector search exists anywhere in this codebase today; this design does not introduce any (see "Out of scope").

## Schema

### `insights` (populated by this design)

```sql
CREATE TABLE insights (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text              TEXT NOT NULL,              -- the claim/finding, one clear sentence
  domains           TEXT[] NOT NULL,             -- one or more of: ai, it, entrepreneurship, business, ux
  confidence        FLOAT NOT NULL,              -- 0.0–1.0, Claude's assessed confidence
  status            TEXT NOT NULL CHECK (status IN
                       ('candidate','active','contested','superseded','rejected')),
  superseded_by     UUID REFERENCES insights(id),
  first_seen_at     DATE NOT NULL,               -- date of the daily run that first surfaced it
  last_confirmed_at DATE,                        -- last weekly run that reaffirmed it
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE insight_sources (
  insight_id UUID REFERENCES insights(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL CHECK (relation IN ('supporting','contradicting')),
  PRIMARY KEY (insight_id, article_id)
);

CREATE INDEX idx_insights_status  ON insights(status);
CREATE INDEX idx_insights_domains ON insights USING GIN(domains);
```

Nothing is ever hard-deleted. Status lifecycle:

- **Daily job** inserts new rows with `status='candidate'`.
- **Weekly job** reads the week's candidates per domain and, per Claude's classification, moves each to `active` (promote), `superseded` (merged into an existing active insight, which gains the candidate's sources and an updated `last_confirmed_at`), leaves it linked into a `contested` insight (existing insight's status flips, candidate's sources attach as `contradicting`, candidate itself becomes `superseded` by the now-contested insight), or `rejected` (too weak/noisy, kept for history but excluded from normal views).

### `decisions` / `hypotheses` / `open_questions` (schema only — populated in Phase 3)

Created now per the parent plan's design rule (generic, domain-tagged, source-linked from the start, so the professional-reasoning system and Phase 3's write-back loop don't require a later migration). Left empty until Phase 3 builds the meeting write-back that populates them.

```sql
CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL, context TEXT, domains TEXT[] NOT NULL,
  decided_at DATE, meeting_id UUID,  -- FK added in Phase 3 once `meetings` exists
  status TEXT NOT NULL CHECK (status IN ('standing','revisited','reversed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE hypotheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement TEXT NOT NULL, domains TEXT[] NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','supported','refuted')),
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE hypothesis_evidence (
  hypothesis_id UUID REFERENCES hypotheses(id) ON DELETE CASCADE,
  insight_id    UUID REFERENCES insights(id) ON DELETE CASCADE,
  stance        TEXT NOT NULL CHECK (stance IN ('for','against')),
  PRIMARY KEY (hypothesis_id, insight_id)
);

CREATE TABLE open_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL, why_it_matters TEXT, domains TEXT[] NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','answered')),
  resolving_insight_id UUID REFERENCES insights(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Distillation jobs

New Supabase Edge Function `distill-insights`, POST body `{ mode: 'daily' | 'weekly' }`. Follows the existing `process-emails`/`generate-trends` pattern: `EdgeRuntime.waitUntil()` background execution, a `pipeline_runs` row per invocation (`job_name='distill-insights'`, `metadata: { mode, domain_results }`), and `sendAlert` on failure (parse errors, Claude API errors) — not on "0 candidates today," which is a normal outcome.

Each domain's work happens **concurrently** via `Promise.allSettled`, not sequentially — this session's `process-emails` fix (parallelizing per-email/per-category Claude calls to avoid the 5-minute EdgeRuntime ceiling) applies here too, since this job also makes one Claude call per domain per invocation.

### Domain ↔ category mapping

`insights.domains` stores lowercase slugs (`ai`, `it`, `entrepreneurship`, `business`, `ux`) so the taxonomy stays generic per the parent plan's design rule — not coupled to `categories.name`'s exact casing/wording. The distillation jobs map slug → category name with a fixed table baked into the function:

```
ai              -> "AI"
it              -> "IT"
entrepreneurship -> "Entrepreneurship"
business        -> "Business"
ux              -> "UX Design"
```

Articles are queried by matching this mapped name against `category_tags` (not `primary_category_id`), since `category_tags` already carries the same cross-category multi-tagging `articles` uses today.

### Daily mode

```
for each domain (ai, it, entrepreneurship, business, ux):
  category_name = map(domain)   -- see mapping above
  top_articles = articles WHERE published_at = today AND category_name = ANY(category_tags)
                 ORDER BY impact_score DESC LIMIT 8
  if top_articles is empty: skip

  candidates = Claude(top_articles) -> [{ text, confidence }, ...]   -- 0-3 per domain
  for each candidate:
    insert into insights (status='candidate', domains=[domain], first_seen_at=today)
    insert into insight_sources (relation='supporting') for each source article
```

Claude is instructed to compress (0–3 candidates per domain), not transcribe one insight per article. ~5 Claude calls/day.

### Weekly mode

```
for each domain:
  weeks_candidates = insights WHERE status='candidate' AND domain IN domains
                      AND first_seen_at IN [last 7 days]
  existing_active   = insights WHERE status IN ('active','contested') AND domain IN domains
                       -- bounded to most recent ~50 to keep the prompt size sane

  if weeks_candidates is empty: skip

  decision = Claude(weeks_candidates + existing_active) -> {
    promote: [candidate_id, ...],
    merge:   [{candidate_id, into_insight_id}, ...],
    contest: [{candidate_id, conflicts_with_insight_id}],
    reject:  [candidate_id, ...],
  }

  apply decision:
    promote → status='active'
    merge   → candidate.status='superseded', superseded_by=into_insight_id,
              copy candidate's insight_sources onto into_insight_id, into_insight_id.last_confirmed_at=today
    contest → conflicts_with_insight.status='contested', link candidate's sources as 'contradicting'
              on the existing insight, candidate.status='superseded',
              candidate.superseded_by=conflicts_with_insight_id (contested insight now IS the record)
    reject  → status='rejected'
```

~5 Claude calls/week. This pass is what keeps `active` insights few and vetted rather than an ever-growing pile of daily candidates — it's the mechanism that makes the knowledge layer "compound" instead of becoming a second feed.

## Scheduling & operations

- New `supabase/pg_cron_distill_insights.sql`, following the existing `pg_cron_*.sql` file convention:
  - Daily: `30 22 * * *` UTC (5 min after `process-emails-afternoon-guarantee` at 22:25, so `impact_score`/`daily_summaries` are settled)
  - Weekly: `0 13 * * 1` UTC (Monday, 30 min after `generate-trends`' weekly run at 12:30 — no hard dependency, just avoids overlap)
- `audit_pipeline.py` gets a new Stage 5: candidate insights created in the last 24h, active-insight count per domain, and a warning if the weekly job hasn't run in >8 days (same style as the existing summary-continuity check).

## Testing / validation

No test suite covers the existing pipeline edge functions — they're validated live (the pattern used for this session's `process-emails` fix: deploy, manually invoke, inspect `pipeline_runs` and the affected tables). Same approach here:

1. Deploy, manually invoke `mode: 'daily'`, inspect `insights`/`insight_sources` rows and the `pipeline_runs` log for each domain.
2. Run daily manually for ~3 days so the first weekly run has real candidates — firing weekly against an empty candidate set on day one isn't a meaningful test.
3. Manually invoke `mode: 'weekly'`, inspect the promote/merge/contest/reject outcomes before enabling the cron.
4. Only then add the pg_cron entries.

## Out of scope (deferred to later specs)

- Dashboard Knowledge view (1d) — once this is populating real data.
- Multi-source ingestion / RSS/YouTube/podcast (1a) — orthogonal, separate spec.
- `decisions`/`hypotheses`/`open_questions` population — Phase 3 (meetings + write-back).
- Embeddings/vector search for contradiction detection — explicitly deferred in favor of Claude-only comparison; revisit only if per-domain candidate+existing-insight volume grows large enough to strain a single prompt.
