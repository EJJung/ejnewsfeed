# Meeting Pack Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let EJ create a meeting (agenda + decision questions), have Claude assemble relevant knowledge-layer items into reviewable context cards, and approve a stable pack — the prep half of Phase 3, read-only against the knowledge layer.

**Architecture:** One new edge function `assemble-pack` (Claude, background task, same shape as `distill-insights`/`generate-podcast`) with its pure parse/build logic factored into a unit-tested `pack_logic.ts` module. Two new Postgres tables (`meetings`, `context_cards`) applied via the SQL Editor (this repo has no migration tooling). Two new dashboard screens (Meetings list+create, Pack review) plus data helpers in the existing `lib/supabase.js`.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres (SQL Editor), Claude API (`claude-sonnet-4-6`), React + Vite + react-router-dom + Tailwind dashboard.

## Global Constraints

- Claude model: `claude-sonnet-4-6` (matches every other edge function in this repo).
- Every external `fetch` (Claude) MUST set `AbortSignal.timeout(...)`.
- Reuse `supabase/functions/_shared/alert.ts`'s `sendAlert(supabase, jobName, message)` for failure alerts — do not write a new copy.
- The edge function logs to the existing `pipeline_runs` table, `job_name = 'assemble-pack'`.
- **Read-only against the knowledge layer:** `assemble-pack` may only `SELECT` from `insights`, `insight_sources`, `decisions`, `hypotheses`, `open_questions`, `articles`. It MUST NOT `INSERT`/`UPDATE`/`DELETE` any of them. Its only writes are to `meetings` (status/error_message) and `context_cards`.
- `meetings.status` CHECK values are exactly: `draft`, `assembling`, `pack_ready`, `approved`, `error`.
- `context_cards.card_type` CHECK values are exactly: `insight`, `decision`, `hypothesis`, `open_question`, `article`, `manual`.
- A pack with zero sourced cards from well-formed Claude output is a **success** (empty pack), not an error. Only unparseable Claude output or a failed Claude/DB call is an error.
- No new schema on existing tables; no embedding/retrieval infra; no chat/voice/write-back (all follow-on specs).
- Dashboard has no test harness (Vite only) — UI verification is by driving the real flow against Supabase, matching the repo's existing convention. Edge-function pure logic is unit-tested with `deno test`.
- Full spec: `docs/superpowers/specs/2026-08-24-meeting-pack-prep-design.md`.

---

### Task 1: Schema — `meetings` + `context_cards` tables

**Files:**
- Create: `supabase/meeting_pack_schema.sql`

**Interfaces:**
- Consumes: existing knowledge-layer RLS conventions (`service_role` full access; authenticated read) from `supabase/knowledge_layer_schema.sql`.
- Produces: tables `meetings` and `context_cards` with the columns Tasks 3–5 read/write.

- [ ] **Step 1: Write the schema SQL file**

Create `supabase/meeting_pack_schema.sql`:

```sql
-- ============================================================
-- EJ Newsfeed — Meeting Pack schema (Phase 3a: prep)
-- Run in Supabase SQL Editor → New Query
-- Read-only consumer of the knowledge layer; adds two new tables.
-- ============================================================

CREATE TABLE IF NOT EXISTS meetings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               TEXT NOT NULL,
  agenda              TEXT NOT NULL,
  prospective_result  TEXT,
  decision_questions  TEXT[] NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','assembling','pack_ready','approved','error')),
  error_message       TEXT,
  summary             TEXT,               -- reserved for the follow-on write-back spec; unused here
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_cards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  card_type     TEXT NOT NULL
                CHECK (card_type IN ('insight','decision','hypothesis','open_question','article','manual')),
  ref_table     TEXT,                     -- source table for sourced cards; null for 'manual'
  ref_id        UUID,                     -- source row id; null for 'manual'
  headline      TEXT NOT NULL,
  body          TEXT NOT NULL,
  why_relevant  TEXT,                     -- Claude's rationale; null for 'manual'
  included      BOOLEAN NOT NULL DEFAULT true,
  edited        BOOLEAN NOT NULL DEFAULT false,
  position      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_context_cards_meeting ON context_cards(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

-- Keep updated_at fresh on meetings.
CREATE OR REPLACE FUNCTION set_meetings_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_meetings_updated_at ON meetings;
CREATE TRIGGER trg_meetings_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION set_meetings_updated_at();

-- ── RLS (mirror knowledge-layer pattern: service_role full, authenticated read/write) ──
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY meetings_service ON meetings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY context_cards_service ON context_cards FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Single private user: authenticated may read and write both tables (the
-- dashboard creates/edits meetings and cards directly).
CREATE POLICY meetings_auth ON meetings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY context_cards_auth ON context_cards FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Verify ──
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('meetings','context_cards') ORDER BY table_name;
```

- [ ] **Step 2: Apply manually in the SQL Editor**

Open the Supabase SQL Editor → New Query, paste the file contents, run. Confirm the final `SELECT` returns two rows: `context_cards`, `meetings`.

- [ ] **Step 3: Verify the CHECK constraints reject bad values**

Run in the SQL Editor:

```sql
INSERT INTO meetings (title, agenda, status) VALUES ('t','a','bogus');
```

Expected: ERROR — `new row for relation "meetings" violates check constraint`. (No row inserted.)

- [ ] **Step 4: Commit**

```bash
git add supabase/meeting_pack_schema.sql
git commit -m "feat: add meetings + context_cards schema (meeting pack prep)"
```

---

### Task 2: `pack_logic.ts` — pure parse/build logic (TDD)

**Files:**
- Create: `supabase/functions/assemble-pack/pack_logic.ts`
- Test: `supabase/functions/assemble-pack/pack_logic_test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no I/O).
- Produces:
  - `type RefTable = 'insights' | 'decisions' | 'hypotheses' | 'open_questions' | 'articles'`
  - `type CardType = 'insight' | 'decision' | 'hypothesis' | 'open_question' | 'article'`
  - `interface SelectedRef { ref_table: RefTable; ref_id: string; card_type: CardType; why_relevant: string }`
  - `interface HydratedRow { headline: string; body: string }`
  - `interface CardInput { card_type: CardType; ref_table: RefTable; ref_id: string; headline: string; body: string; why_relevant: string; position: number }`
  - `function hydrationKey(table: RefTable, id: string): string`
  - `function parseSelection(rawText: string): SelectedRef[]` — throws on unparseable JSON; returns only valid refs (skips malformed entries); `[]` is a valid result.
  - `function buildCards(selected: SelectedRef[], hydration: Record<string, HydratedRow>): CardInput[]` — skips refs with no hydration entry; assigns `position` by input order.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/assemble-pack/pack_logic_test.ts`:

```typescript
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { parseSelection, buildCards, hydrationKey } from './pack_logic.ts'

Deno.test('parseSelection parses a well-formed selection', () => {
  const raw = JSON.stringify({
    selections: [
      { ref_table: 'insights', ref_id: 'i1', card_type: 'insight', why_relevant: 'core to agenda' },
      { ref_table: 'decisions', ref_id: 'd1', card_type: 'decision', why_relevant: 'prior call' },
    ],
  })
  const out = parseSelection(raw)
  assertEquals(out.length, 2)
  assertEquals(out[0], { ref_table: 'insights', ref_id: 'i1', card_type: 'insight', why_relevant: 'core to agenda' })
})

Deno.test('parseSelection strips ```json code fences', () => {
  const raw = '```json\n{"selections":[{"ref_table":"articles","ref_id":"a1","card_type":"article","why_relevant":"color"}]}\n```'
  const out = parseSelection(raw)
  assertEquals(out.length, 1)
  assertEquals(out[0].ref_table, 'articles')
})

Deno.test('parseSelection skips entries with invalid table/type/id', () => {
  const raw = JSON.stringify({
    selections: [
      { ref_table: 'bogus', ref_id: 'x', card_type: 'insight', why_relevant: 'y' },
      { ref_table: 'insights', ref_id: '', card_type: 'insight', why_relevant: 'y' },
      { ref_table: 'insights', ref_id: 'i2', card_type: 'weird', why_relevant: 'y' },
      { ref_table: 'insights', ref_id: 'i3', card_type: 'insight', why_relevant: 'ok' },
    ],
  })
  const out = parseSelection(raw)
  assertEquals(out.length, 1)
  assertEquals(out[0].ref_id, 'i3')
})

Deno.test('parseSelection returns [] for well-formed but empty selections', () => {
  assertEquals(parseSelection('{"selections":[]}'), [])
})

Deno.test('parseSelection throws on unparseable output', () => {
  assertThrows(() => parseSelection('not json at all'))
})

Deno.test('buildCards hydrates matched refs and skips unmatched', () => {
  const selected = parseSelection(JSON.stringify({
    selections: [
      { ref_table: 'insights', ref_id: 'i1', card_type: 'insight', why_relevant: 'r1' },
      { ref_table: 'insights', ref_id: 'missing', card_type: 'insight', why_relevant: 'r2' },
    ],
  }))
  const hydration = { [hydrationKey('insights', 'i1')]: { headline: 'H1', body: 'B1' } }
  const cards = buildCards(selected, hydration)
  assertEquals(cards.length, 1)
  assertEquals(cards[0], {
    card_type: 'insight', ref_table: 'insights', ref_id: 'i1',
    headline: 'H1', body: 'B1', why_relevant: 'r1', position: 0,
  })
})

Deno.test('buildCards assigns positions by input order', () => {
  const selected = parseSelection(JSON.stringify({
    selections: [
      { ref_table: 'insights', ref_id: 'i1', card_type: 'insight', why_relevant: 'r1' },
      { ref_table: 'decisions', ref_id: 'd1', card_type: 'decision', why_relevant: 'r2' },
    ],
  }))
  const hydration = {
    [hydrationKey('insights', 'i1')]: { headline: 'H1', body: 'B1' },
    [hydrationKey('decisions', 'd1')]: { headline: 'H2', body: 'B2' },
  }
  const cards = buildCards(selected, hydration)
  assertEquals(cards.map((c) => c.position), [0, 1])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd supabase/functions/assemble-pack && deno test pack_logic_test.ts`
Expected: FAIL — `Module not found "file:///.../pack_logic.ts"`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/assemble-pack/pack_logic.ts`:

```typescript
/**
 * Pure parse/build helpers for assemble-pack. No I/O — unit-tested in
 * pack_logic_test.ts. The handler (index.ts) does all DB/Claude I/O and
 * calls these to turn Claude's raw selection into context_cards rows.
 */

export type RefTable = 'insights' | 'decisions' | 'hypotheses' | 'open_questions' | 'articles'
export type CardType = 'insight' | 'decision' | 'hypothesis' | 'open_question' | 'article'

export interface SelectedRef {
  ref_table: RefTable
  ref_id: string
  card_type: CardType
  why_relevant: string
}

export interface HydratedRow {
  headline: string
  body: string
}

export interface CardInput {
  card_type: CardType
  ref_table: RefTable
  ref_id: string
  headline: string
  body: string
  why_relevant: string
  position: number
}

const REF_TABLES: RefTable[] = ['insights', 'decisions', 'hypotheses', 'open_questions', 'articles']
const CARD_TYPES: CardType[] = ['insight', 'decision', 'hypothesis', 'open_question', 'article']

export function hydrationKey(table: RefTable, id: string): string {
  return `${table}:${id}`
}

export function parseSelection(rawText: string): SelectedRef[] {
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`assemble-pack: Claude returned unparseable JSON: ${rawText.slice(0, 300)}`)
  }
  const rawSelections = (parsed as { selections?: unknown[] } | null)?.selections
  if (!Array.isArray(rawSelections)) {
    throw new Error('assemble-pack: Claude output missing a "selections" array')
  }

  const out: SelectedRef[] = []
  for (const item of rawSelections) {
    const it = item as Partial<SelectedRef> | null | undefined
    if (
      it &&
      REF_TABLES.includes(it.ref_table as RefTable) &&
      CARD_TYPES.includes(it.card_type as CardType) &&
      typeof it.ref_id === 'string' && it.ref_id.trim() &&
      typeof it.why_relevant === 'string'
    ) {
      out.push({
        ref_table: it.ref_table as RefTable,
        ref_id: it.ref_id.trim(),
        card_type: it.card_type as CardType,
        why_relevant: it.why_relevant.trim(),
      })
    }
  }
  return out
}

export function buildCards(
  selected: SelectedRef[],
  hydration: Record<string, HydratedRow>,
): CardInput[] {
  const cards: CardInput[] = []
  for (const ref of selected) {
    const row = hydration[hydrationKey(ref.ref_table, ref.ref_id)]
    if (!row) continue
    cards.push({
      card_type: ref.card_type,
      ref_table: ref.ref_table,
      ref_id: ref.ref_id,
      headline: row.headline,
      body: row.body,
      why_relevant: ref.why_relevant,
      position: cards.length,
    })
  }
  return cards
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd supabase/functions/assemble-pack && deno test pack_logic_test.ts`
Expected: PASS (7 tests, `ok`).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/assemble-pack/pack_logic.ts supabase/functions/assemble-pack/pack_logic_test.ts
git commit -m "feat: add assemble-pack pure parse/build logic with tests"
```

---

### Task 3: `assemble-pack` edge function handler

**Files:**
- Create: `supabase/functions/assemble-pack/index.ts`

**Interfaces:**
- Consumes: `sendAlert` from `../_shared/alert.ts`; `parseSelection`, `buildCards`, `hydrationKey`, types from `./pack_logic.ts`; `meetings`, `context_cards`, `insights`, `insight_sources`, `decisions`, `hypotheses`, `open_questions`, `articles`, `pipeline_runs` tables.
- Produces: `POST /functions/v1/assemble-pack` with body `{ meeting_id: string }`. On success inserts `context_cards` rows and sets `meetings.status='pack_ready'`; on failure sets `meetings.status='error'` + `error_message`.

- [ ] **Step 1: Write the handler**

Create `supabase/functions/assemble-pack/index.ts`:

```typescript
/**
 * assemble-pack — Supabase Edge Function
 * ======================================
 * Given a meeting_id, reads a compact digest of the whole knowledge layer
 * (active/contested insights, standing/revisited decisions, open/supported
 * hypotheses, open questions) plus recent high-impact articles, asks Claude
 * which items are relevant to the meeting's agenda + decision questions, and
 * writes the selected items as context_cards snapshots for EJ to review.
 *
 * READ-ONLY against the knowledge layer: only SELECTs from insights/…/articles.
 * Its only writes are to meetings (status) and context_cards.
 *
 * POST /functions/v1/assemble-pack   Body: { meeting_id }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendAlert } from '../_shared/alert.ts'
import {
  parseSelection, buildCards, hydrationKey,
  type HydratedRow, type CardInput,
} from './pack_logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'
const ARTICLE_LOOKBACK_DAYS = 14
const ARTICLE_LIMIT = 15

interface MeetingRow {
  id: string
  title: string
  agenda: string
  prospective_result: string | null
  decision_questions: string[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  let meetingId: string | null = null
  try {
    const body = await req.json()
    if (typeof body?.meeting_id === 'string') meetingId = body.meeting_id
  } catch { /* fall through to 400 below */ }
  if (!meetingId) {
    return new Response(JSON.stringify({ ok: false, error: 'meeting_id required' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'assemble-pack', status: 'running', metadata: { meeting_id: meetingId } })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  const work = assemblePack(supabase, anthropicKey, meetingId)
    .then(async (result) => {
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(), status: 'success',
          metadata: { meeting_id: meetingId, ...result },
        }).eq('id', runId)
      }
      return { ok: true, ...result }
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('assemble-pack fatal error:', err)
      await supabase.from('meetings').update({ status: 'error', error_message: msg }).eq('id', meetingId)
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(), status: 'error', error_message: msg,
          metadata: { meeting_id: meetingId },
        }).eq('id', runId)
      }
      await sendAlert(supabase, 'assemble-pack', `assemble-pack crashed: ${msg}`)
      return { ok: false, error: msg }
    })

  // @ts-ignore — Deno Deploy global
  if (typeof EdgeRuntime !== 'undefined') {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
    return new Response(JSON.stringify({ ok: true, message: 'assemble-pack started in background' }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const result = await work
  return new Response(JSON.stringify(result), {
    status: (result as { ok: boolean }).ok === false ? 500 : 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})

async function assemblePack(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  meetingId: string,
) {
  // Load the meeting and mark it assembling. Also clear any prior sourced,
  // non-edited cards so re-assembly is idempotent (manual/edited cards kept).
  const { data: meeting, error: mErr } = await supabase
    .from('meetings')
    .select('id, title, agenda, prospective_result, decision_questions')
    .eq('id', meetingId)
    .single()
  if (mErr || !meeting) throw new Error(`meeting not found: ${mErr?.message ?? meetingId}`)
  const m = meeting as MeetingRow

  await supabase.from('meetings').update({ status: 'assembling', error_message: null }).eq('id', meetingId)
  await supabase.from('context_cards').delete()
    .eq('meeting_id', meetingId).neq('card_type', 'manual').eq('edited', false)

  // ── Gather the digest (READ-ONLY SELECTs) + build the hydration map ──
  const hydration: Record<string, HydratedRow> = {}
  const digestParts: string[] = []

  const { data: insights } = await supabase
    .from('insights').select('id, text, status, domains')
    .in('status', ['active', 'contested'])
  const insightRows = (insights || []) as { id: string; text: string; status: string; domains: string[] }[]
  for (const r of insightRows) {
    hydration[hydrationKey('insights', r.id)] = { headline: r.text.slice(0, 80), body: r.text }
  }
  if (insightRows.length) {
    digestParts.push('### INSIGHTS\n' + insightRows.map((r) =>
      `- id=${r.id} [${r.status}] (${(r.domains || []).join(', ')}): ${r.text}`).join('\n'))
  }

  // Contested insights: attach supporting/contradicting article titles for real contradiction framing.
  const contested = insightRows.filter((r) => r.status === 'contested')
  if (contested.length) {
    const contestedLines: string[] = []
    for (const c of contested) {
      const { data: links } = await supabase
        .from('insight_sources').select('article_id, relation').eq('insight_id', c.id)
      const linkRows = (links || []) as { article_id: string; relation: string }[]
      const ids = linkRows.map((l) => l.article_id)
      const titleById: Record<string, string> = {}
      if (ids.length) {
        const { data: arts } = await supabase.from('articles').select('id, title').in('id', ids)
        for (const a of (arts || []) as { id: string; title: string }[]) titleById[a.id] = a.title
      }
      const sup = linkRows.filter((l) => l.relation === 'supporting').map((l) => titleById[l.article_id]).filter(Boolean)
      const con = linkRows.filter((l) => l.relation === 'contradicting').map((l) => titleById[l.article_id]).filter(Boolean)
      contestedLines.push(`- id=${c.id}: "${c.text}"\n    supporting: ${sup.join('; ') || '(none)'}\n    contradicting: ${con.join('; ') || '(none)'}`)
    }
    digestParts.push('### CONTESTED INSIGHT SOURCES\n' + contestedLines.join('\n'))
  }

  const { data: decisions } = await supabase
    .from('decisions').select('id, text, context, domains, decided_at, status')
    .in('status', ['standing', 'revisited'])
  const decisionRows = (decisions || []) as
    { id: string; text: string; context: string | null; domains: string[]; decided_at: string | null; status: string }[]
  for (const r of decisionRows) {
    hydration[hydrationKey('decisions', r.id)] = { headline: r.text.slice(0, 80), body: r.context ? `${r.text}\n\n${r.context}` : r.text }
  }
  if (decisionRows.length) {
    digestParts.push('### DECISIONS\n' + decisionRows.map((r) =>
      `- id=${r.id} [${r.status}] (${(r.domains || []).join(', ')}, ${r.decided_at ?? 'undated'}): ${r.text}`).join('\n'))
  }

  const { data: hypotheses } = await supabase
    .from('hypotheses').select('id, statement, domains, status')
    .in('status', ['open', 'supported'])
  const hypothesisRows = (hypotheses || []) as { id: string; statement: string; domains: string[]; status: string }[]
  for (const r of hypothesisRows) {
    hydration[hydrationKey('hypotheses', r.id)] = { headline: r.statement.slice(0, 80), body: r.statement }
  }
  if (hypothesisRows.length) {
    digestParts.push('### HYPOTHESES\n' + hypothesisRows.map((r) =>
      `- id=${r.id} [${r.status}] (${(r.domains || []).join(', ')}): ${r.statement}`).join('\n'))
  }

  const { data: questions } = await supabase
    .from('open_questions').select('id, question, why_it_matters, domains').eq('status', 'open')
  const questionRows = (questions || []) as { id: string; question: string; why_it_matters: string | null; domains: string[] }[]
  for (const r of questionRows) {
    hydration[hydrationKey('open_questions', r.id)] = { headline: r.question.slice(0, 80), body: r.why_it_matters ? `${r.question}\n\nWhy it matters: ${r.why_it_matters}` : r.question }
  }
  if (questionRows.length) {
    digestParts.push('### OPEN QUESTIONS\n' + questionRows.map((r) =>
      `- id=${r.id} (${(r.domains || []).join(', ')}): ${r.question}`).join('\n'))
  }

  const sinceISO = new Date(Date.now() - ARTICLE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: articles } = await supabase
    .from('articles').select('id, title, snippet')
    .gte('published_at', sinceISO)
    .order('impact_score', { ascending: false, nullsFirst: false })
    .limit(ARTICLE_LIMIT)
  const articleRows = (articles || []) as { id: string; title: string; snippet: string | null }[]
  for (const r of articleRows) {
    hydration[hydrationKey('articles', r.id)] = { headline: r.title, body: r.snippet || r.title }
  }
  if (articleRows.length) {
    digestParts.push('### RECENT ARTICLES (for concrete color)\n' + articleRows.map((r) =>
      `- id=${r.id}: ${r.title}${r.snippet ? ' — ' + r.snippet : ''}`).join('\n'))
  }

  // Nothing in the knowledge layer at all → valid empty pack, no Claude call.
  if (!digestParts.length) {
    await supabase.from('meetings').update({ status: 'pack_ready' }).eq('id', meetingId)
    return { card_count: 0, skipped: 'empty_knowledge_layer' }
  }

  // ── Ask Claude which items are relevant ──
  const selected = await selectRelevant(anthropicKey, m, digestParts.join('\n\n'))
  const cards = buildCards(selected, hydration)

  if (cards.length) {
    const rows = cards.map((c: CardInput) => ({ ...c, meeting_id: meetingId, included: true }))
    const { error: insErr } = await supabase.from('context_cards').insert(rows)
    if (insErr) throw new Error(`Failed to insert context_cards: ${insErr.message}`)
  }

  await supabase.from('meetings').update({ status: 'pack_ready' }).eq('id', meetingId)
  return { card_count: cards.length }
}

async function selectRelevant(apiKey: string, meeting: MeetingRow, digest: string) {
  const questions = meeting.decision_questions?.length
    ? meeting.decision_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(none specified)'

  const prompt = `You are assembling a meeting prep pack for EJ, who tracks AI, IT, entrepreneurship, business, and UX.

MEETING
Title: ${meeting.title}
Agenda: ${meeting.agenda}
Desired result: ${meeting.prospective_result || '(not specified)'}
Critical decision questions:
${questions}

Below is EJ's current knowledge layer. Each item has an id. Select ONLY the items genuinely relevant to THIS agenda and these decision questions — favor items that inform a decision, and surface genuine contradictions (contested insights) rather than one-sided claims. Do not pad; a short, sharp pack beats a long one. It is fine to select nothing if nothing is relevant.

${digest}

Return ONLY a JSON object of this exact shape, no markdown fences, no explanation:
{"selections": [{"ref_table": "insights|decisions|hypotheses|open_questions|articles", "ref_id": "<the id>", "card_type": "insight|decision|hypothesis|open_question|article", "why_relevant": "<one sentence>"}]}

card_type must match ref_table (insights→insight, decisions→decision, hypotheses→hypothesis, open_questions→open_question, articles→article).`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`)

  const data = await res.json()
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude selection was truncated by max_tokens')
  }
  const rawText = (data.content?.[0]?.text || '').trim()
  return parseSelection(rawText)
}
```

- [ ] **Step 2: Type-check the function**

Run: `cd /Users/ejjung/Dev/ejnewsfeed && deno check supabase/functions/assemble-pack/index.ts`

Note (discovered during execution): `deno check` reports pre-existing `TS2345` `never`-type inference errors on the untyped Supabase client's `.insert()`/`.update()` calls. This is a **repo-wide, pre-existing condition** — the already-deployed `distill-insights` and `generate-podcast` functions fail `deno check` identically (unpinned `esm.sh` `@supabase/supabase-js@2` + no `Database` generic). It is inference noise, not a bug, and is NOT a valid gate for this repo's edge functions. The real validation is Step 3 (`supabase functions deploy`, which bundles/validates) + Step 4 (live invoke). Do not attempt to "fix" these by pinning versions or adding generics — that's an unrelated cross-codebase refactor the spec excludes.

- [ ] **Step 3: Deploy**

Run: `cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy assemble-pack`
Expected: `Deployed Functions on project oqxxmdyyfjgigfjtposv: assemble-pack`.

- [ ] **Step 4: Live smoke test against a seeded meeting**

Create a throwaway meeting and invoke the function (run from `pipeline/`, which has the service-role env):

```bash
cd pipeline && python3 -c "
import os, json, urllib.request, time
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path
load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

mtg = sb.table('meetings').insert({
    'title': 'SMOKE TEST — delete me',
    'agenda': 'Where should we focus AI product effort next quarter?',
    'prospective_result': 'A ranked shortlist of 2-3 focus areas.',
    'decision_questions': ['Which domain has the strongest tailwind right now?', 'What are we most wrong about?'],
    'status': 'draft',
}).execute().data[0]
mid = mtg['id']; print('meeting', mid)

url = os.environ['SUPABASE_URL'] + '/functions/v1/assemble-pack'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
req = urllib.request.Request(url, method='POST',
    headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'apikey': key},
    data=json.dumps({'meeting_id': mid}).encode())
with urllib.request.urlopen(req, timeout=30) as resp:
    print('invoke:', resp.status, resp.read().decode())

for _ in range(20):
    row = sb.table('meetings').select('status, error_message').eq('id', mid).single().execute().data
    if row['status'] in ('pack_ready', 'error'):
        print('final status:', row['status'], row.get('error_message'))
        break
    time.sleep(5)

cards = sb.table('context_cards').select('card_type, headline, why_relevant').eq('meeting_id', mid).order('position').execute().data
print(f'{len(cards)} cards:')
for c in cards: print(f\"  [{c['card_type']}] {c['headline'][:60]} — {c.get('why_relevant')}\")
print('SMOKE meeting id (delete after inspecting):', mid)
"
```

Expected: `invoke: 200 {"ok":true,"message":"assemble-pack started in background"}`, then `final status: pack_ready`, and a handful of cards with sensible `why_relevant` lines (given the layer currently has ~64 active insights). A zero-card `pack_ready` is acceptable only if Claude genuinely found nothing relevant — re-read the agenda if so. Verify `error_message` is null. **Verify read-only:** re-run a quick count of `insights`/`decisions`/`hypotheses`/`open_questions` before and after — the counts must be unchanged.

- [ ] **Step 5: Clean up the smoke-test meeting**

```bash
cd pipeline && python3 -c "
import os, sys
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path
load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
sb.table('meetings').delete().eq('title', 'SMOKE TEST — delete me').execute()
print('deleted smoke-test meetings (cards cascade)')
"
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/assemble-pack/index.ts
git commit -m "feat: add assemble-pack edge function handler"
```

---

### Task 4: Dashboard — Meetings list + creation

**Files:**
- Modify: `dashboard/src/lib/supabase.js` (add meeting data helpers)
- Create: `dashboard/src/components/MeetingsView.jsx`
- Modify: `dashboard/src/App.jsx` (route + import)
- Modify: `dashboard/src/components/Sidebar.jsx` (nav item)

**Interfaces:**
- Consumes: `supabase` client and `isMockMode` from `lib/supabase.js`; the `assemble-pack` function from Task 3; `meetings`/`context_cards` tables from Task 1.
- Produces: helper functions `listMeetings()`, `createMeeting({title, agenda, prospective_result, decision_questions})`, `assemblePack(meetingId)`, `getMeeting(id)` in `lib/supabase.js`; a `/meetings` route rendering `MeetingsView`.

- [ ] **Step 1: Add data helpers to `lib/supabase.js`**

Append to `dashboard/src/lib/supabase.js` (after the existing helpers):

```javascript
// ── Meeting Pack helpers (Phase 3a) ──

export async function listMeetings() {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('meetings')
    .select('id, title, status, created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getMeeting(id) {
  if (isMockMode) return null
  const { data, error } = await supabase.from('meetings').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

export async function createMeeting({ title, agenda, prospective_result, decision_questions }) {
  if (isMockMode) throw new Error('createMeeting unavailable in mock mode')
  const { data, error } = await supabase
    .from('meetings')
    .insert({ title, agenda, prospective_result, decision_questions, status: 'draft' })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function assemblePack(meetingId) {
  if (isMockMode) throw new Error('assemblePack unavailable in mock mode')
  // Optimistically flip status so the list reflects assembling immediately.
  await supabase.from('meetings').update({ status: 'assembling' }).eq('id', meetingId)
  const { error } = await supabase.functions.invoke('assemble-pack', { body: { meeting_id: meetingId } })
  if (error) throw error
}
```

- [ ] **Step 2: Create `MeetingsView.jsx`**

Create `dashboard/src/components/MeetingsView.jsx`:

```jsx
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { listMeetings, createMeeting, assemblePack } from '../lib/supabase.js'

const STATUS_LABEL = {
  draft: 'Draft', assembling: 'Assembling…', pack_ready: 'Pack ready',
  approved: 'Approved', error: 'Error',
}
const STATUS_CLASS = {
  draft: 'bg-gray-100 text-gray-600', assembling: 'bg-amber-100 text-amber-700',
  pack_ready: 'bg-blue-100 text-blue-700', approved: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
}

export default function MeetingsView() {
  const navigate = useNavigate()
  const [meetings, setMeetings] = useState([])
  const [showForm, setShowForm] = useState(false)

  const refresh = useCallback(async () => {
    try { setMeetings(await listMeetings()) } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Poll while anything is assembling, so the badge flips to pack_ready.
  useEffect(() => {
    if (!meetings.some((m) => m.status === 'assembling')) return
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [meetings, refresh])

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Meetings</h1>
        <button onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700">
          {showForm ? 'Cancel' : 'New meeting'}
        </button>
      </div>

      {showForm && <NewMeetingForm onCreated={async () => { setShowForm(false); await refresh() }} />}

      <div className="space-y-2 mt-6">
        {meetings.length === 0 && <p className="text-gray-500 text-sm">No meetings yet.</p>}
        {meetings.map((m) => (
          <div key={m.id}
            className="flex items-center justify-between p-4 rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer"
            onClick={() => navigate(`/meetings/${m.id}`)}>
            <span className="font-medium text-gray-900">{m.title}</span>
            <span className={`text-xs px-2 py-1 rounded-full ${STATUS_CLASS[m.status] || ''}`}>
              {STATUS_LABEL[m.status] || m.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function NewMeetingForm({ onCreated }) {
  const [title, setTitle] = useState('')
  const [agenda, setAgenda] = useState('')
  const [result, setResult] = useState('')
  const [questions, setQuestions] = useState([''])
  const [busy, setBusy] = useState(false)

  function setQuestion(i, val) {
    setQuestions((qs) => qs.map((q, idx) => (idx === i ? val : q)))
  }

  async function submit(assemble) {
    if (!title.trim() || !agenda.trim()) return
    setBusy(true)
    try {
      const cleanQuestions = questions.map((q) => q.trim()).filter(Boolean)
      const id = await createMeeting({
        title: title.trim(), agenda: agenda.trim(),
        prospective_result: result.trim() || null, decision_questions: cleanQuestions,
      })
      if (assemble) await assemblePack(id)
      await onCreated()
    } catch (e) { console.error(e); alert(`Failed: ${e.message}`) } finally { setBusy(false) }
  }

  return (
    <div className="p-5 rounded-lg border border-gray-200 bg-gray-50 space-y-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting title"
        className="w-full px-3 py-2 rounded border border-gray-300 text-sm" />
      <textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="Agenda"
        rows={3} className="w-full px-3 py-2 rounded border border-gray-300 text-sm" />
      <textarea value={result} onChange={(e) => setResult(e.target.value)} placeholder="Desired result (optional)"
        rows={2} className="w-full px-3 py-2 rounded border border-gray-300 text-sm" />
      <div className="space-y-2">
        <label className="text-xs font-medium text-gray-600">Critical decision questions</label>
        {questions.map((q, i) => (
          <input key={i} value={q} onChange={(e) => setQuestion(i, e.target.value)}
            placeholder={`Question ${i + 1}`}
            className="w-full px-3 py-2 rounded border border-gray-300 text-sm" />
        ))}
        <button type="button" onClick={() => setQuestions((qs) => [...qs, ''])}
          className="text-xs text-violet-600 hover:underline">+ Add question</button>
      </div>
      <div className="flex gap-2 pt-1">
        <button disabled={busy} onClick={() => submit(false)}
          className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-gray-100 disabled:opacity-50">
          Save draft
        </button>
        <button disabled={busy} onClick={() => submit(true)}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm hover:bg-violet-700 disabled:opacity-50">
          {busy ? 'Working…' : 'Save & assemble pack'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire the route in `App.jsx`**

Add the import near the other view imports (after line 7's `KnowledgeView` import):

```jsx
import MeetingsView from './components/MeetingsView.jsx'
```

Add these routes alongside the existing ones (next to the `/knowledge` route):

```jsx
<Route path="/meetings" element={<MeetingsView />} />
```

(The `/meetings/:id` detail route is added in Task 5.)

- [ ] **Step 4: Add the Sidebar nav item**

`Sidebar.jsx` routes via a `handleNav(key)` dispatcher and derives `activeNav` from the URL; each item is a `<NavItem label isActive onClick icon />`. Two edits:

First, add a `meetings` branch to `handleNav` (alongside the existing `else if` chain, before the final `else`):

```jsx
    else if (key === 'knowledge') navigate('/knowledge')
    else if (key === 'meetings') navigate('/meetings')
```

Then add the `NavItem` right after the "Knowledge" one in the `<nav>` block:

```jsx
<NavItem
  label="Meetings"
  isActive={activeNav === 'meetings'}
  onClick={() => handleNav('meetings')}
  icon={
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />
    </svg>
  }
/>
```

`activeNav` derives from `location.pathname`'s first segment, so it highlights for both `/meetings` and `/meetings/:id`. No other changes to `Sidebar.jsx`.

- [ ] **Step 5: Verify by driving the real flow**

Run the dashboard against Supabase:

```bash
cd dashboard && npm run dev
```

Open the app, sign in, click **Meetings** in the sidebar. Create a meeting (title + agenda + one or two questions), click **Save & assemble pack**. Expected: the meeting appears with an `Assembling…` badge that flips to `Pack ready` within ~30s (the list polls every 4s). Confirm a `Save draft` also creates a `Draft`-badged meeting without assembling.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/supabase.js dashboard/src/components/MeetingsView.jsx dashboard/src/App.jsx dashboard/src/components/Sidebar.jsx
git commit -m "feat: add Meetings list + creation UI"
```

---

### Task 5: Dashboard — Pack review (meeting detail)

**Files:**
- Modify: `dashboard/src/lib/supabase.js` (add card helpers)
- Create: `dashboard/src/components/MeetingPack.jsx`
- Modify: `dashboard/src/App.jsx` (detail route)

**Interfaces:**
- Consumes: `getMeeting`, `assemblePack` from Task 4; `context_cards` table from Task 1.
- Produces: helper functions `getCards(meetingId)`, `setCardIncluded(cardId, included)`, `editCard(cardId, {headline, body})`, `addManualCard(meetingId, {headline, body})`, `approvePack(meetingId)` in `lib/supabase.js`; a `/meetings/:id` route rendering `MeetingPack`.

- [ ] **Step 1: Add card helpers to `lib/supabase.js`**

Append to `dashboard/src/lib/supabase.js`:

```javascript
export async function getCards(meetingId) {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('context_cards').select('*').eq('meeting_id', meetingId)
    .order('card_type').order('position')
  if (error) throw error
  return data
}

export async function setCardIncluded(cardId, included) {
  if (isMockMode) return
  const { error } = await supabase.from('context_cards').update({ included }).eq('id', cardId)
  if (error) throw error
}

export async function editCard(cardId, { headline, body }) {
  if (isMockMode) return
  const { error } = await supabase
    .from('context_cards').update({ headline, body, edited: true }).eq('id', cardId)
  if (error) throw error
}

export async function addManualCard(meetingId, { headline, body }) {
  if (isMockMode) return
  const { error } = await supabase.from('context_cards').insert({
    meeting_id: meetingId, card_type: 'manual', headline, body, included: true,
  })
  if (error) throw error
}

export async function approvePack(meetingId) {
  if (isMockMode) return
  const { error } = await supabase.from('meetings').update({ status: 'approved' }).eq('id', meetingId)
  if (error) throw error
}
```

- [ ] **Step 2: Create `MeetingPack.jsx`**

Create `dashboard/src/components/MeetingPack.jsx`:

```jsx
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  getMeeting, getCards, setCardIncluded, editCard, addManualCard, approvePack, assemblePack,
} from '../lib/supabase.js'

const GROUPS = [
  { key: 'insight', label: 'Insights & Contradictions' },
  { key: 'decision', label: 'Decisions' },
  { key: 'hypothesis', label: 'Hypotheses' },
  { key: 'open_question', label: 'Open Questions' },
  { key: 'article', label: 'Articles' },
  { key: 'manual', label: 'Your additions' },
]

export default function MeetingPack() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [meeting, setMeeting] = useState(null)
  const [cards, setCards] = useState([])

  const refresh = useCallback(async () => {
    try {
      setMeeting(await getMeeting(id))
      setCards(await getCards(id))
    } catch (e) { console.error(e) }
  }, [id])

  useEffect(() => { refresh() }, [refresh])

  // Poll while assembling / re-assembling.
  useEffect(() => {
    if (meeting?.status !== 'assembling') return
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [meeting, refresh])

  if (!meeting) return <div className="max-w-3xl mx-auto px-6 py-8 text-gray-500">Loading…</div>

  async function toggle(card) { await setCardIncluded(card.id, !card.included); await refresh() }

  async function reassemble() {
    if (!confirm('Re-assemble the pack? Your manual and edited cards are kept; other cards are regenerated.')) return
    await assemblePack(id); await refresh()
  }

  async function approve() { await approvePack(id); await refresh() }

  const assembling = meeting.status === 'assembling'

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <button onClick={() => navigate('/meetings')} className="text-sm text-gray-500 hover:underline mb-4">← Meetings</button>

      <h1 className="text-2xl font-semibold text-gray-900">{meeting.title}</h1>
      <div className="mt-3 p-4 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700 space-y-2">
        <p><span className="font-medium">Agenda:</span> {meeting.agenda}</p>
        {meeting.prospective_result && <p><span className="font-medium">Desired result:</span> {meeting.prospective_result}</p>}
        {meeting.decision_questions?.length > 0 && (
          <div><span className="font-medium">Decision questions:</span>
            <ul className="list-decimal ml-5 mt-1">{meeting.decision_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 my-5">
        {meeting.status === 'error' && <span className="text-sm text-red-600">Error: {meeting.error_message}</span>}
        <button onClick={reassemble} disabled={assembling}
          className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-100 disabled:opacity-50">
          {assembling ? 'Assembling…' : 'Re-assemble'}
        </button>
        {meeting.status !== 'approved' ? (
          <button onClick={approve} disabled={assembling}
            className="px-4 py-1.5 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700 disabled:opacity-50">
            Approve pack
          </button>
        ) : <span className="text-sm text-green-700 font-medium">✓ Approved</span>}
      </div>

      {!assembling && cards.length === 0 && (
        <p className="text-sm text-gray-500">AI found nothing relevant — add cards manually below.</p>
      )}

      {GROUPS.map((g) => {
        const groupCards = cards.filter((c) => c.card_type === g.key)
        if (!groupCards.length) return null
        return (
          <section key={g.key} className="mb-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">{g.label}</h2>
            <div className="space-y-2">
              {groupCards.map((c) => <Card key={c.id} card={c} onToggle={() => toggle(c)} onSaved={refresh} />)}
            </div>
          </section>
        )
      })}

      <AddCard meetingId={id} onAdded={refresh} />
    </div>
  )
}

function Card({ card, onToggle, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [headline, setHeadline] = useState(card.headline)
  const [body, setBody] = useState(card.body)

  async function save() { await editCard(card.id, { headline, body }); setEditing(false); await onSaved() }

  return (
    <div className={`p-4 rounded-lg border ${card.included ? 'border-gray-200' : 'border-gray-100 opacity-40'}`}>
      {editing ? (
        <div className="space-y-2">
          <input value={headline} onChange={(e) => setHeadline(e.target.value)}
            className="w-full px-2 py-1 rounded border border-gray-300 text-sm font-medium" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
            className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
          <div className="flex gap-2">
            <button onClick={save} className="text-xs text-violet-600 hover:underline">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:underline">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-gray-900 text-sm">{card.headline}</p>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-gray-700">Edit</button>
              <button onClick={onToggle} className="text-xs text-gray-400 hover:text-gray-700">
                {card.included ? 'Exclude' : 'Include'}
              </button>
            </div>
          </div>
          <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{card.body}</p>
          {card.why_relevant && <p className="text-xs text-violet-500 mt-2 italic">Why: {card.why_relevant}</p>}
        </>
      )}
    </div>
  )
}

function AddCard({ meetingId, onAdded }) {
  const [open, setOpen] = useState(false)
  const [headline, setHeadline] = useState('')
  const [body, setBody] = useState('')

  async function add() {
    if (!headline.trim() || !body.trim()) return
    await addManualCard(meetingId, { headline: headline.trim(), body: body.trim() })
    setHeadline(''); setBody(''); setOpen(false); await onAdded()
  }

  if (!open) return <button onClick={() => setOpen(true)} className="text-sm text-violet-600 hover:underline">+ Add card</button>
  return (
    <div className="p-4 rounded-lg border border-gray-200 bg-gray-50 space-y-2">
      <input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Card headline"
        className="w-full px-2 py-1 rounded border border-gray-300 text-sm font-medium" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Card content" rows={3}
        className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
      <div className="flex gap-2">
        <button onClick={add} className="text-xs text-violet-600 hover:underline">Add</button>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:underline">Cancel</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire the detail route in `App.jsx`**

Add the import (after the Task 4 `MeetingsView` import):

```jsx
import MeetingPack from './components/MeetingPack.jsx'
```

Add the route next to the `/meetings` route from Task 4:

```jsx
<Route path="/meetings/:id" element={<MeetingPack />} />
```

- [ ] **Step 4: Verify the full prep loop end-to-end**

Run `cd dashboard && npm run dev`. Then, in the app:
1. Create a meeting and assemble a pack (Task 4 flow).
2. Click the meeting → the detail screen shows agenda/questions pinned and cards grouped by type.
3. Toggle a card **Exclude** → it greys out; **Include** → restores.
4. **Edit** a sourced card's headline/body, Save → change persists on refresh.
5. **+ Add card** → a manual card appears under "Your additions".
6. **Re-assemble** → confirm the manual card AND the edited card survive; other cards refresh.
7. **Approve pack** → status badge becomes Approved and the button is replaced by "✓ Approved".

Expected: every step behaves as described; no console errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/supabase.js dashboard/src/components/MeetingPack.jsx dashboard/src/App.jsx
git commit -m "feat: add meeting pack review UI (include/exclude/edit/add/re-assemble/approve)"
```

---

## After this plan lands

Update `knowledge-center-plan.md`'s Phase 3 entry: mark **3a (meeting setup), 3b (pack assembly), 3c (pack review)** as implemented, and note that the companion session (3d) + write-back (3e) are the next spec. Matching how Phase 2's entries were updated in-place after shipping. Not a task here since it's documentation bookkeeping on a different file.

The approved-pack state (`meetings.status='approved'` + its `context_cards` where `included=true`) is the input contract for the follow-on **Capture** spec (companion chat session + transcript write-back). That spec should be brainstormed only after this one is live and a real pack has been reviewed — the pack format is the companion's input, and seeing a real one first is the whole reason this was split out.
