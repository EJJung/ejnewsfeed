# Knowledge Layer Schema + Distillation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `insights` knowledge-layer table plus a daily (candidate extraction) and weekly (merge/contradiction-detection) distillation job that populates it from existing newsletter articles, and scaffold the empty `decisions`/`hypotheses`/`open_questions` tables for later phases.

**Architecture:** A new Supabase Edge Function `distill-insights` (POST `{ mode: 'daily' | 'weekly' }`) runs per-domain Claude calls concurrently (`Promise.allSettled`, following the pattern just fixed in `process-emails`), logs every run to the existing `pipeline_runs` table, and is scheduled via two new `pg_cron` entries. Daily mode extracts 0–3 candidate insights per domain from that day's top-`impact_score` articles. Weekly mode classifies the week's candidates against existing active insights (promote / merge / contest / reject) via one Claude call per domain, applying the result with plain SQL updates — no embeddings, no vector search.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres (via Supabase SQL Editor — this project has no migration tooling; schema changes are applied manually, same as `supabase/pipeline_logs.sql` and `supabase/trend_summaries.sql`), Claude API (`claude-sonnet-4-6`), Python 3 (`pipeline/audit_pipeline.py`, using `supabase-py` + `python-dotenv`, already a project dependency).

## Global Constraints

- Claude model: `claude-sonnet-4-6` (matches every other edge function in this repo — do not use a different model).
- Every Claude `fetch` call MUST set `signal: AbortSignal.timeout(45_000)` (matches `process-emails`/`generate-trends` — an unguarded fetch can hang forever).
- Per-domain Claude calls within one invocation MUST run concurrently via `Promise.allSettled`, never a sequential `for` loop with `await` inside — this is the exact bug fixed in `process-emails` this session (sequential 45s-capped calls blew past the 5-minute EdgeRuntime background-execution ceiling and got killed by the stale-run watchdog).
- Domain slugs are exactly: `ai`, `it`, `entrepreneurship`, `business`, `ux` (lowercase). They map to `categories.name` values exactly: `AI`, `IT`, `Entrepreneurship`, `Business`, `UX Design` respectively.
- `insights.status` CHECK values are exactly: `candidate`, `active`, `contested`, `superseded`, `rejected`. Nothing is ever hard-deleted.
- Cron schedule (UTC): daily `30 22 * * *`, weekly `0 13 * * 1` — see spec for rationale (5 min after the last `process-emails` batch; 30 min after `generate-trends`' weekly run).
- New tables get RLS enabled with an `anon` read-all policy and a `service_role` all-access policy, matching `supabase/trend_summaries.sql` exactly (dashboard reads as `anon`, Edge Functions write as `service_role`).
- `distill-insights` logs to the existing `pipeline_runs` table (`job_name='distill-insights'`, `metadata: { mode, domain_results }`) — do not create a new run-log table.
- No embeddings, no pgvector, no new external dependencies — contradiction/duplicate detection is a single Claude call per domain comparing text.
- Full spec: `docs/superpowers/specs/2026-08-18-knowledge-layer-schema-distillation-design.md`.

---

### Task 1: Knowledge layer schema

**Files:**
- Create: `supabase/knowledge_layer_schema.sql`

**Interfaces:**
- Produces: tables `insights`, `insight_sources`, `decisions`, `hypotheses`, `hypothesis_evidence`, `open_questions` with the exact columns below — Task 2 and Task 3 insert/select against these column names directly.

- [ ] **Step 1: Write the schema SQL file**

```sql
-- ============================================================
-- EJ Newsfeed — Knowledge Layer Schema
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- insights is populated by the distill-insights Edge Function
-- (daily candidate extraction + weekly merge/contradiction pass).
-- decisions / hypotheses / open_questions are schema-only until
-- Phase 3 builds the meeting write-back loop that populates them.
-- ============================================================

-- ── insights ──────────────────────────────────────────────────────────────

CREATE TABLE insights (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text              TEXT NOT NULL,
  domains           TEXT[] NOT NULL,
  confidence        FLOAT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                       ('candidate','active','contested','superseded','rejected')),
  superseded_by     UUID REFERENCES insights(id),
  first_seen_at     DATE NOT NULL,
  last_confirmed_at DATE,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_insights_status  ON insights(status);
CREATE INDEX idx_insights_domains ON insights USING GIN(domains);
CREATE INDEX idx_insights_first_seen ON insights(first_seen_at DESC);

ALTER TABLE insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_insights"
  ON insights FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_insights"
  ON insights FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── insight_sources ───────────────────────────────────────────────────────

CREATE TABLE insight_sources (
  insight_id UUID REFERENCES insights(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL CHECK (relation IN ('supporting','contradicting')),
  PRIMARY KEY (insight_id, article_id)
);

CREATE INDEX idx_insight_sources_article ON insight_sources(article_id);

ALTER TABLE insight_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_insight_sources"
  ON insight_sources FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_insight_sources"
  ON insight_sources FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── decisions (schema only — populated in Phase 3) ──────────────────────────

CREATE TABLE decisions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text       TEXT NOT NULL,
  context    TEXT,
  domains    TEXT[] NOT NULL,
  decided_at DATE,
  meeting_id UUID,
  status     TEXT NOT NULL CHECK (status IN ('standing','revisited','reversed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_decisions"
  ON decisions FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_decisions"
  ON decisions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── hypotheses (schema only — populated in Phase 3) ─────────────────────────

CREATE TABLE hypotheses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement  TEXT NOT NULL,
  domains    TEXT[] NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('open','supported','refuted')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE hypotheses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_hypotheses"
  ON hypotheses FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_hypotheses"
  ON hypotheses FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE hypothesis_evidence (
  hypothesis_id UUID REFERENCES hypotheses(id) ON DELETE CASCADE,
  insight_id    UUID REFERENCES insights(id) ON DELETE CASCADE,
  stance        TEXT NOT NULL CHECK (stance IN ('for','against')),
  PRIMARY KEY (hypothesis_id, insight_id)
);

ALTER TABLE hypothesis_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_hypothesis_evidence"
  ON hypothesis_evidence FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_hypothesis_evidence"
  ON hypothesis_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── open_questions (schema only — populated in Phase 3) ─────────────────────

CREATE TABLE open_questions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question             TEXT NOT NULL,
  why_it_matters       TEXT,
  domains              TEXT[] NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('open','answered')),
  resolving_insight_id UUID REFERENCES insights(id),
  created_at           TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE open_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_open_questions"
  ON open_questions FOR SELECT TO anon USING (true);

CREATE POLICY "service_all_open_questions"
  ON open_questions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('insights','insight_sources','decisions','hypotheses','hypothesis_evidence','open_questions')
ORDER BY table_name;
```

- [ ] **Step 2: Apply the SQL manually**

This repo has no migration tooling — every schema change here (`supabase/pipeline_logs.sql`, `supabase/trend_summaries.sql`, `supabase/triage_stale_backlog.sql`) is applied by pasting into the Supabase SQL Editor. Open `https://supabase.com/dashboard/project/oqxxmdyyfjgigfjtposv/sql/new`, paste the full contents of `supabase/knowledge_layer_schema.sql`, and run it. The final `SELECT` should return all 6 table names.

- [ ] **Step 3: Verify from the repo**

Run from repo root:

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

for t in ['insights', 'insight_sources', 'decisions', 'hypotheses', 'hypothesis_evidence', 'open_questions']:
    r = sb.table(t).select('*').limit(1).execute()
    print(t, '-> OK, rows:', len(r.data))
"
```

Expected: all 6 tables print `-> OK, rows: 0` with no exceptions.

- [ ] **Step 4: Commit**

```bash
git add supabase/knowledge_layer_schema.sql
git commit -m "feat: add knowledge layer schema (insights, decisions, hypotheses, open_questions)"
```

---

### Task 2: `distill-insights` Edge Function — daily mode

**Files:**
- Create: `supabase/functions/distill-insights/index.ts`

**Interfaces:**
- Consumes: `insights`/`insight_sources` tables from Task 1; `articles` table (`id, title, snippet, url, category_tags, impact_score, published_at`); `pipeline_runs` table (`job_name, started_at, completed_at, status, error_message, metadata`) — same shape `process-emails` writes.
- Produces: HTTP endpoint `POST /functions/v1/distill-insights` with body `{ mode: 'daily' }`. Weekly mode (Task 3) is added to the same file and reuses `DOMAIN_TO_CATEGORY`, `sendAlert`, and the Claude-call helpers defined here.

- [ ] **Step 1: Write the daily-mode implementation**

```typescript
/**
 * distill-insights — Supabase Edge Function
 * ============================================
 * Daily: extracts 0-3 candidate insights per domain from that day's
 * top-impact_score articles.
 * Weekly: classifies the week's candidates against existing active
 * insights (promote / merge / contest / reject) and applies the result.
 *
 * POST /functions/v1/distill-insights
 * Body: { mode: 'daily' | 'weekly' }
 *
 * Schedule (pg_cron): daily 22:30 UTC, weekly Monday 13:00 UTC.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

// Domain slugs (generic, used by insights.domains) map to this project's
// existing categories.name values (see pipeline/audit_pipeline.py CATEGORIES).
const DOMAIN_TO_CATEGORY: Record<string, string> = {
  ai: 'AI',
  it: 'IT',
  entrepreneurship: 'Entrepreneurship',
  business: 'Business',
  ux: 'UX Design',
}
const DOMAINS = Object.keys(DOMAIN_TO_CATEGORY)

type Mode = 'daily' | 'weekly'

interface ArticleRow {
  id: string
  title: string
  snippet: string | null
  url: string | null
}

interface CandidateInsight {
  text: string
  confidence: number
  source_indices: number[]
}

// ── Alert helper (same pattern as process-emails) ───────────────────────────
async function sendAlert(supabase: ReturnType<typeof createClient>, message: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('_pipeline_config')
      .select('value')
      .eq('key', 'alert_webhook_url')
      .maybeSingle()
    const url = (data as { value?: string } | null)?.value?.trim()
    if (!url) return
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '🚨 EJ Newsfeed Pipeline Error',
        message,
        job: 'distill-insights',
        timestamp: new Date().toISOString(),
      }),
    })
  } catch { /* best-effort */ }
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { mode } = await req.json() as { mode: Mode }
  if (mode !== 'daily' && mode !== 'weekly') {
    return new Response(JSON.stringify({ ok: false, error: 'mode must be "daily" or "weekly"' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'distill-insights', status: 'running', metadata: { mode } })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  const work = (mode === 'daily' ? runDaily(supabase, anthropicKey) : runWeekly(supabase, anthropicKey))
    .then(async (domain_results) => {
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(),
          status: 'success',
          metadata: { mode, domain_results },
        }).eq('id', runId)
      }
      return { ok: true, mode, domain_results }
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('distill-insights fatal error:', err)
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(),
          status: 'error',
          error_message: msg,
          metadata: { mode },
        }).eq('id', runId)
      }
      await sendAlert(supabase, `distill-insights (${mode}) crashed: ${msg}`)
      return { ok: false, error: msg }
    })

  // @ts-ignore — Deno Deploy global
  if (typeof EdgeRuntime !== 'undefined') {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
    return new Response(
      JSON.stringify({ ok: true, message: `distill-insights (${mode}) started in background` }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  const result = await work
  return new Response(JSON.stringify(result), {
    status: (result as { ok: boolean }).ok === false ? 500 : 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})

// ── Daily mode ─────────────────────────────────────────────────────────────

async function runDaily(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
): Promise<Record<string, { candidates_created: number }>> {
  const todayISO = new Date().toISOString().slice(0, 10)

  const settled = await Promise.allSettled(
    DOMAINS.map(async (domain) => {
      const categoryName = DOMAIN_TO_CATEGORY[domain]

      const { data: articles } = await supabase
        .from('articles')
        .select('id, title, snippet, url')
        .contains('category_tags', [categoryName])
        .gte('published_at', `${todayISO}T00:00:00.000Z`)
        .lte('published_at', `${todayISO}T23:59:59.999Z`)
        .order('impact_score', { ascending: false, nullsFirst: false })
        .limit(8)

      const rows = (articles || []) as ArticleRow[]
      if (!rows.length) return { domain, candidates_created: 0 }

      const candidates = await extractCandidateInsights(anthropicKey, categoryName, rows)

      let created = 0
      for (const c of candidates) {
        const { data: inserted, error } = await supabase.from('insights').insert({
          text: c.text,
          domains: [domain],
          confidence: c.confidence,
          status: 'candidate',
          first_seen_at: todayISO,
        }).select('id').single()

        if (error || !inserted) {
          console.error(`  ✗ Failed to insert candidate insight for ${domain}:`, error?.message)
          continue
        }

        const sourceRows = c.source_indices
          .map((i) => rows[i - 1])
          .filter((a): a is ArticleRow => Boolean(a))
          .map((a) => ({ insight_id: (inserted as { id: string }).id, article_id: a.id, relation: 'supporting' }))

        if (sourceRows.length) {
          await supabase.from('insight_sources').insert(sourceRows)
        }
        created++
      }

      console.log(`  ✓ ${domain}: ${created} candidate insight(s) from ${rows.length} articles`)
      return { domain, candidates_created: created }
    }),
  )

  const results: Record<string, { candidates_created: number }> = {}
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') {
      results[s.value.domain] = { candidates_created: s.value.candidates_created }
    } else {
      console.error(`  ✗ Error processing domain ${DOMAINS[i]}: ${s.reason}`)
      results[DOMAINS[i]] = { candidates_created: 0 }
    }
  }
  return results
}

async function extractCandidateInsights(
  apiKey: string,
  categoryName: string,
  articles: ArticleRow[],
): Promise<CandidateInsight[]> {
  const articleList = articles
    .map((a, i) => `${i + 1}. ${a.title}${a.snippet ? ': ' + a.snippet : ''}`)
    .join('\n')

  const prompt = `You are analyzing today's top ${categoryName} articles to extract durable, non-obvious insights for a knowledge base.

Articles:
${articleList}

Extract 0-3 candidate insights — durable claims or findings worth remembering weeks from now, not restatements of a single headline. Skip routine news with no lasting signal; it's fine to return an empty array.

Return ONLY a JSON array, each item:
{
  "text": string — one clear sentence stating the claim,
  "confidence": number 0.0-1.0 — how well-supported this claim is by the given articles,
  "source_indices": number[] — 1-based indices into the article list above that support this claim
}
No markdown, no explanation — raw JSON only.`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Claude API error ${res.status}: ${errBody}`)
  }

  const data = await res.json()
  const rawText = (data.content?.[0]?.text || '').trim()

  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    console.error('Failed to parse Claude extraction JSON:', rawText.slice(0, 300))
    return []
  }
}

// ── Weekly mode (Task 3) ─────────────────────────────────────────────────────

async function runWeekly(
  _supabase: ReturnType<typeof createClient>,
  _anthropicKey: string,
): Promise<Record<string, unknown>> {
  throw new Error('weekly mode not implemented yet')
}
```

- [ ] **Step 2: Deploy**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy distill-insights
```

Expected: `Deployed Functions on project oqxxmdyyfjgigfjtposv: distill-insights`.

- [ ] **Step 3: Invoke daily mode and verify**

```bash
cd pipeline && python3 -c "
import os, urllib.request
from dotenv import load_dotenv
from pathlib import Path
import json

load_dotenv(Path('.') / '.env')
url = os.environ['SUPABASE_URL'] + '/functions/v1/distill-insights'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
req = urllib.request.Request(url, method='POST', headers={
    'Authorization': f'Bearer {key}',
    'Content-Type': 'application/json',
    'apikey': key,
}, data=json.dumps({'mode': 'daily'}).encode())
with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.status, resp.read().decode())
"
```

Expected: `200 {"ok":true,"message":"distill-insights (daily) started in background"}`.

Then poll for completion and inspect results:

```bash
cd pipeline && python3 -c "
import os, time
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

for _ in range(24):
    rows = sb.table('pipeline_runs').select('*').eq('job_name', 'distill-insights').order('started_at', desc=True).limit(1).execute()
    r = rows.data[0]
    if r['completed_at']:
        print('run:', r['status'], r['metadata'])
        break
    time.sleep(5)
else:
    print('TIMEOUT still running')

today = __import__('datetime').date.today().isoformat()
candidates = sb.table('insights').select('id, text, domains, confidence, status').eq('status', 'candidate').eq('first_seen_at', today).execute()
print(f'{len(candidates.data)} candidate insight(s) created today:')
for c in candidates.data:
    print(' -', c['domains'], c['confidence'], '|', c['text'])
"
```

Expected: run `status: success`, `domain_results` has an entry for all 5 domains, and the candidate-insight query prints zero or more rows with no errors. (Zero candidates for a given day is a valid outcome if Claude judged nothing durable — but across 5 domains with today's real article volume, expect at least one candidate in most runs.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/distill-insights/index.ts
git commit -m "feat: add distill-insights edge function, daily candidate extraction"
```

---

### Task 3: `distill-insights` — weekly mode

**Files:**
- Modify: `supabase/functions/distill-insights/index.ts` (replace the `runWeekly` stub from Task 2)

**Interfaces:**
- Consumes: `DOMAIN_TO_CATEGORY`, `DOMAINS`, `sendAlert`, `CLAUDE_API`, `CLAUDE_MODEL` from Task 2 (same file).
- Produces: working `mode: 'weekly'` request path.

- [ ] **Step 1: Replace the `runWeekly` stub with the real implementation**

```typescript
// ── Weekly mode ──────────────────────────────────────────────────────────

interface WeeklyDecision {
  promote: string[]
  merge: { candidate_id: string; into_insight_id: string }[]
  contest: { candidate_id: string; conflicts_with_insight_id: string }[]
  reject: string[]
}

interface InsightRow {
  id: string
  text: string
  status: string
  confidence?: number
}

async function runWeekly(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
): Promise<Record<string, { promoted: number; merged: number; contested: number; rejected: number }>> {
  const todayISO = new Date().toISOString().slice(0, 10)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const settled = await Promise.allSettled(
    DOMAINS.map(async (domain) => {
      const categoryName = DOMAIN_TO_CATEGORY[domain]

      const { data: candidateRows } = await supabase
        .from('insights')
        .select('id, text, status, confidence')
        .eq('status', 'candidate')
        .contains('domains', [domain])
        .gte('first_seen_at', sevenDaysAgo)

      const candidates = (candidateRows || []) as InsightRow[]
      if (!candidates.length) return { domain, promoted: 0, merged: 0, contested: 0, rejected: 0 }

      const { data: existingRows } = await supabase
        .from('insights')
        .select('id, text, status')
        .in('status', ['active', 'contested'])
        .contains('domains', [domain])
        .order('created_at', { ascending: false })
        .limit(50)

      const existing = (existingRows || []) as InsightRow[]

      const decision = await classifyCandidates(anthropicKey, categoryName, candidates, existing)
      const counts = await applyWeeklyDecision(supabase, decision, todayISO)
      console.log(`  ✓ ${domain}: promoted=${counts.promoted} merged=${counts.merged} contested=${counts.contested} rejected=${counts.rejected}`)
      return { domain, ...counts }
    }),
  )

  const results: Record<string, { promoted: number; merged: number; contested: number; rejected: number }> = {}
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') {
      results[s.value.domain] = { promoted: s.value.promoted, merged: s.value.merged, contested: s.value.contested, rejected: s.value.rejected }
    } else {
      console.error(`  ✗ Error processing domain ${DOMAINS[i]}: ${s.reason}`)
      results[DOMAINS[i]] = { promoted: 0, merged: 0, contested: 0, rejected: 0 }
    }
  }
  return results
}

async function classifyCandidates(
  apiKey: string,
  categoryName: string,
  candidates: InsightRow[],
  existing: InsightRow[],
): Promise<WeeklyDecision> {
  const existingBlock = existing.length
    ? existing.map((e) => `[${e.id}] (${e.status}) ${e.text}`).join('\n')
    : '(none yet)'
  const candidateBlock = candidates
    .map((c) => `[${c.id}] ${c.text} (confidence ${c.confidence ?? 'n/a'})`)
    .join('\n')

  const prompt = `You are curating a knowledge base of durable insights for ${categoryName}. Compare this week's newly extracted candidate insights against the currently active/contested insights, and classify each candidate.

Existing active/contested insights:
${existingBlock}

This week's candidates:
${candidateBlock}

For each candidate, decide exactly one:
- "promote": genuinely new, distinct, and well-supported enough to become an active insight
- "merge": restates or reinforces an existing insight — merge as additional evidence (needs into_insight_id from the existing list)
- "contest": conflicts with / contradicts an existing insight (needs conflicts_with_insight_id from the existing list)
- "reject": too weak, too narrow, or not durable enough to keep

Return ONLY a JSON object:
{
  "promote": ["candidate_id", ...],
  "merge": [{"candidate_id": "...", "into_insight_id": "..."}],
  "contest": [{"candidate_id": "...", "conflicts_with_insight_id": "..."}],
  "reject": ["candidate_id", ...]
}
Every candidate id must appear in exactly one bucket, using ids exactly as given in brackets above. No markdown, no explanation.`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Claude API error ${res.status}: ${errBody}`)
  }

  const data = await res.json()
  const rawText = (data.content?.[0]?.text || '').trim()
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const parsed = JSON.parse(cleaned) as Partial<WeeklyDecision>

  const decision: WeeklyDecision = {
    promote: parsed.promote || [],
    merge: parsed.merge || [],
    contest: parsed.contest || [],
    reject: parsed.reject || [],
  }

  // Any candidate Claude didn't classify is treated as rejected, not silently dropped.
  const classifiedIds = new Set([
    ...decision.promote,
    ...decision.merge.map((m) => m.candidate_id),
    ...decision.contest.map((c) => c.candidate_id),
    ...decision.reject,
  ])
  for (const c of candidates) {
    if (!classifiedIds.has(c.id)) decision.reject.push(c.id)
  }

  return decision
}

async function applyWeeklyDecision(
  supabase: ReturnType<typeof createClient>,
  decision: WeeklyDecision,
  todayISO: string,
): Promise<{ promoted: number; merged: number; contested: number; rejected: number }> {
  let promoted = 0, merged = 0, contested = 0, rejected = 0

  if (decision.promote.length) {
    const { error } = await supabase.from('insights').update({ status: 'active', updated_at: new Date().toISOString() }).in('id', decision.promote)
    if (!error) promoted = decision.promote.length
  }

  for (const { candidate_id, into_insight_id } of decision.merge) {
    const { data: sources } = await supabase.from('insight_sources').select('article_id, relation').eq('insight_id', candidate_id)
    for (const src of (sources || []) as { article_id: string; relation: string }[]) {
      await supabase.from('insight_sources').upsert(
        { insight_id: into_insight_id, article_id: src.article_id, relation: 'supporting' },
        { onConflict: 'insight_id,article_id' },
      )
    }
    await supabase.from('insights').update({ status: 'superseded', superseded_by: into_insight_id, updated_at: new Date().toISOString() }).eq('id', candidate_id)
    await supabase.from('insights').update({ last_confirmed_at: todayISO, updated_at: new Date().toISOString() }).eq('id', into_insight_id)
    merged++
  }

  for (const { candidate_id, conflicts_with_insight_id } of decision.contest) {
    const { data: sources } = await supabase.from('insight_sources').select('article_id').eq('insight_id', candidate_id)
    for (const src of (sources || []) as { article_id: string }[]) {
      await supabase.from('insight_sources').upsert(
        { insight_id: conflicts_with_insight_id, article_id: src.article_id, relation: 'contradicting' },
        { onConflict: 'insight_id,article_id' },
      )
    }
    await supabase.from('insights').update({ status: 'contested', updated_at: new Date().toISOString() }).eq('id', conflicts_with_insight_id)
    await supabase.from('insights').update({ status: 'superseded', superseded_by: conflicts_with_insight_id, updated_at: new Date().toISOString() }).eq('id', candidate_id)
    contested++
  }

  if (decision.reject.length) {
    const { error } = await supabase.from('insights').update({ status: 'rejected', updated_at: new Date().toISOString() }).in('id', decision.reject)
    if (!error) rejected = decision.reject.length
  }

  return { promoted, merged, contested, rejected }
}
```

- [ ] **Step 2: Deploy**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy distill-insights
```

- [ ] **Step 3: Seed synthetic test data**

Weekly mode needs at least one existing `active` insight and one near-duplicate `candidate` to meaningfully exercise the merge/contest paths (a brand-new knowledge base with zero active insights will only ever hit promote/reject). Seed clearly-marked test rows, tied to a real article so the FK is valid:

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path
from datetime import date, timedelta

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

article = sb.table('articles').select('id').limit(1).execute().data[0]
article_id = article['id']

active = sb.table('insights').insert({
    'text': '[TEST] Cloud infrastructure costs are rising industry-wide',
    'domains': ['business'],
    'confidence': 0.8,
    'status': 'active',
    'first_seen_at': (date.today() - timedelta(days=7)).isoformat(),
}).select('id').single().execute().data
sb.table('insight_sources').insert({'insight_id': active['id'], 'article_id': article_id, 'relation': 'supporting'}).execute()

candidate = sb.table('insights').insert({
    'text': '[TEST] Cloud costs are climbing across the industry',
    'domains': ['business'],
    'confidence': 0.7,
    'status': 'candidate',
    'first_seen_at': date.today().isoformat(),
}).select('id').single().execute().data
sb.table('insight_sources').insert({'insight_id': candidate['id'], 'article_id': article_id, 'relation': 'supporting'}).execute()

print('active insight id:', active['id'])
print('candidate insight id:', candidate['id'])
"
```

Note the two printed ids — you'll use them in Step 5's verification and Step 6's cleanup.

- [ ] **Step 4: Invoke weekly mode**

```bash
cd pipeline && python3 -c "
import os, urllib.request, json
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path('.') / '.env')
url = os.environ['SUPABASE_URL'] + '/functions/v1/distill-insights'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
req = urllib.request.Request(url, method='POST', headers={
    'Authorization': f'Bearer {key}',
    'Content-Type': 'application/json',
    'apikey': key,
}, data=json.dumps({'mode': 'weekly'}).encode())
with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.status, resp.read().decode())
"
```

Expected: `200 {"ok":true,"message":"distill-insights (weekly) started in background"}`.

- [ ] **Step 5: Poll for completion and verify structural invariants**

```bash
cd pipeline && python3 -c "
import os, time
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

for _ in range(24):
    rows = sb.table('pipeline_runs').select('*').eq('job_name', 'distill-insights').order('started_at', desc=True).limit(1).execute()
    r = rows.data[0]
    if r['completed_at'] and r['metadata'].get('mode') == 'weekly':
        print('run:', r['status'], r['metadata'])
        break
    time.sleep(5)
else:
    print('TIMEOUT still running')

test_insights = sb.table('insights').select('id, text, status, superseded_by').like('text', '[TEST]%').execute().data
print(f'{len(test_insights)} test insight(s):')
for i in test_insights:
    print(' -', i['status'], '| superseded_by:', i['superseded_by'], '|', i['text'])

# Structural invariant: the candidate must have left 'candidate' status,
# and if it's 'superseded', superseded_by must point to a real insights row.
candidate = next(i for i in test_insights if i['text'].startswith('[TEST] Cloud costs are climbing'))
assert candidate['status'] != 'candidate', 'weekly run did not classify the test candidate'
if candidate['status'] == 'superseded':
    target = sb.table('insights').select('id').eq('id', candidate['superseded_by']).execute().data
    assert len(target) == 1, 'superseded_by does not point to a real insight'
    print('PASS: candidate classified as', candidate['status'], '-> valid superseded_by')
else:
    print('PASS: candidate classified as', candidate['status'])
"
```

Expected: run `status: success`, and the assertions pass (no `AssertionError`). Which exact branch Claude picks (merge vs. promote vs. reject) is not asserted — only that classification happened and any `superseded_by` reference is valid.

- [ ] **Step 6: Clean up synthetic test data**

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

test_ids = [i['id'] for i in sb.table('insights').select('id').like('text', '[TEST]%').execute().data]
sb.table('insight_sources').delete().in_('insight_id', test_ids).execute()
sb.table('insights').delete().in_('id', test_ids).execute()
print(f'Deleted {len(test_ids)} test insight(s) and their sources.')
"
```

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/distill-insights/index.ts
git commit -m "feat: add distill-insights weekly merge/contradiction-detection pass"
```

---

### Task 4: Audit stage for distillation health

**Files:**
- Modify: `pipeline/audit_pipeline.py`

**Interfaces:**
- Consumes: `sb` client, `CheckResult`, `_pct` already defined in this file; `STAGES` list this task appends to.
- Produces: `audit_insight_distillation(target_date, lookback_days)` function, used the same way Stage 1-4 functions are (called by `run_audit`'s existing loop, which already handles both 1-arg and 2-arg signatures via `try/except TypeError`).

- [ ] **Step 1: Add the Stage 5 function**

Insert this after `audit_summarization` (before the `# ── Main report` section, around line 394):

```python
# ── Stage 5: Insight Distillation ────────────────────────────────────────────

def audit_insight_distillation(target_date: date, lookback_days: int) -> list[CheckResult]:
    date_str = target_date.isoformat()
    results  = []

    # Candidate insights created on the target date
    candidates = sb.table("insights") \
        .select("id, domains, status") \
        .eq("first_seen_at", date_str) \
        .execute()
    n_candidates = len(candidates.data or [])
    results.append(CheckResult(
        "info", f"candidate insights ({date_str})",
        f"{n_candidates} candidate(s) extracted"
    ))

    # Active insight count per domain
    active = sb.table("insights") \
        .select("domains") \
        .eq("status", "active") \
        .execute()
    domain_counts: dict[str, int] = {}
    for row in (active.data or []):
        for d in (row.get("domains") or []):
            domain_counts[d] = domain_counts.get(d, 0) + 1
    if domain_counts:
        breakdown = "  ".join(f"{k}={v}" for k, v in sorted(domain_counts.items()))
        results.append(CheckResult("info", "active insights by domain", breakdown))
    else:
        results.append(CheckResult("info", "active insights by domain", "none yet"))

    # Weekly job freshness
    last_weekly = sb.table("pipeline_runs") \
        .select("started_at, status, metadata") \
        .eq("job_name", "distill-insights") \
        .order("started_at", desc=True) \
        .limit(20) \
        .execute()
    weekly_runs = [r for r in (last_weekly.data or []) if (r.get("metadata") or {}).get("mode") == "weekly"]

    if not weekly_runs:
        results.append(CheckResult("info", "weekly distillation", "no weekly runs yet"))
    else:
        last_run = weekly_runs[0]
        last_date = date.fromisoformat(last_run["started_at"][:10])
        days_since = (target_date - last_date).days
        if days_since > 8:
            results.append(CheckResult("warn", "weekly distillation",
                                       f"last run {days_since}d ago ({last_run['status']}) — expected weekly"))
        else:
            results.append(CheckResult("pass", "weekly distillation",
                                       f"last run {days_since}d ago, status={last_run['status']}"))

    return results
```

- [ ] **Step 2: Register the stage**

Update the `STAGES` list (around line 398):

```python
STAGES = [
    ("Stage 1 — Email Fetch",         audit_email_fetch),
    ("Stage 2 — Article Parsing",     audit_article_parsing),
    ("Stage 3 — Article Scoring",     audit_article_scoring),
    ("Stage 4 — Summarization",       audit_summarization),
    ("Stage 5 — Insight Distillation", audit_insight_distillation),
]
```

- [ ] **Step 3: Run the audit and verify**

```bash
cd pipeline && python3 audit_pipeline.py
```

Expected: console output now includes a `Stage 5 — Insight Distillation` section with `candidate insights (<today>)`, `active insights by domain`, and `weekly distillation` lines, with no Python traceback.

- [ ] **Step 4: Commit**

```bash
git add pipeline/audit_pipeline.py
git commit -m "feat: add Stage 5 insight-distillation checks to pipeline audit"
```

---

### Task 5: Schedule via pg_cron

**Files:**
- Create: `supabase/pg_cron_distill_insights.sql`

**Interfaces:**
- Consumes: `_pipeline_config` keys `supabase_url` / `supabase_anon_key` (already populated — used by `supabase/pg_cron_trends.sql`), the deployed `distill-insights` function from Tasks 2-3.

- [ ] **Step 1: Write the cron SQL file**

```sql
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
```

- [ ] **Step 2: Apply manually**

Paste into `https://supabase.com/dashboard/project/oqxxmdyyfjgigfjtposv/sql/new` and run. The final `SELECT` should return both jobs with `active = true`.

- [ ] **Step 3: Verify from the repo**

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
cfg = sb.table('_pipeline_config').select('key, value').in_('key', ['supabase_url', 'supabase_anon_key']).execute()
print('config present:', {r['key']: bool(r['value']) for r in cfg.data})
"
```

Expected: both `supabase_url` and `supabase_anon_key` print `True` (they're required by the cron job body and should already be populated from the existing `generate-trends` setup — if either is `False`, insert it before relying on the cron).

- [ ] **Step 4: Commit**

```bash
git add supabase/pg_cron_distill_insights.sql
git commit -m "feat: schedule distill-insights daily/weekly via pg_cron"
```
