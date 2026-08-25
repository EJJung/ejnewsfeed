# Write-back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a completed meeting's transcript, let Claude propose new decisions/hypotheses/open-questions + a summary, let EJ review them, and commit the approved set into the knowledge layer with `meeting_id` provenance — closing the flywheel.

**Architecture:** One new edge function `writeback` (synchronous, `extract`/`commit` modes) with its pure parse/map logic in a unit-tested `logic.ts`. One new staging table `writeback_proposals` plus a nullable `meeting_id` added to `hypotheses`/`open_questions`, applied via the SQL Editor. One new dashboard review screen reachable from a completed meeting, plus data helpers. Extraction writes only the staging table; the single knowledge-layer write is isolated to `commit`.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres (SQL Editor), Claude API (`claude-sonnet-4-6`), React + Vite + react-router-dom + Tailwind.

## Global Constraints

- Claude model: `claude-sonnet-4-6`. Every external `fetch` (Claude) sets `AbortSignal.timeout(...)`.
- Reuse `_shared/alert.ts`'s `sendAlert`. Log to `pipeline_runs` with `job_name='writeback'` (metadata includes `mode`).
- **Knowledge-layer writes are isolated to `mode='commit'`.** `mode='extract'` writes ONLY `writeback_proposals` and reads `session_messages`/`meetings` — it MUST NOT insert/update `decisions`/`hypotheses`/`open_questions`. Only `commit` writes those three tables (plus `meetings.summary` and `writeback_proposals` status).
- **Create-only:** commit only INSERTs new rows. It MUST NOT UPDATE or DELETE any existing `decisions`/`hypotheses`/`open_questions`/`insights` row.
- `writeback_proposals.kind` CHECK: exactly `decision`, `hypothesis`, `open_question`, `summary`. `writeback_proposals.status` CHECK: exactly `proposed`, `committed`, `discarded`.
- Committed rows get default status: `decisions` → `standing`, `hypotheses` → `open`, `open_questions` → `open`. Every committed item carries `meeting_id`. `decisions.decided_at` = the commit date.
- An item with empty `domains` cannot be committed (knowledge tables require non-empty `domains`): skip it, leave it `proposed`, and report the skipped count. Commit is idempotent: only `status='proposed'` rows are processed.
- `deno check` is NOT a valid gate for edge functions here (pre-existing repo-wide never-type noise). Validate via `supabase functions deploy` + live invoke.
- No updating existing knowledge rows (follow-on); no voice; no auto-extract; no insight writes.
- Full spec: `docs/superpowers/specs/2026-08-24-writeback-design.md`.

---

### Task 1: Schema — `writeback_proposals` + `meeting_id` on hypotheses/open_questions

**Files:**
- Create: `supabase/writeback_schema.sql`

- [ ] **Step 1: Write the schema SQL file**

Create `supabase/writeback_schema.sql`:

```sql
-- ============================================================
-- EJ Newsfeed — Write-back schema (Phase 3c: Capture half, write-back)
-- Run in Supabase SQL Editor → New Query
-- Adds the proposal staging table + meeting_id provenance on two
-- knowledge-layer tables. Additive and nullable — the daily/weekly
-- distill-insights pipeline is unaffected.
-- ============================================================

CREATE TABLE IF NOT EXISTS writeback_proposals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id        UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('decision','hypothesis','open_question','summary')),
  text              TEXT NOT NULL,
  detail            TEXT,
  domains           TEXT[] NOT NULL DEFAULT '{}',
  included          BOOLEAN NOT NULL DEFAULT true,
  edited            BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','committed','discarded')),
  committed_ref_id  UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_writeback_proposals_meeting ON writeback_proposals(meeting_id);

-- Provenance: match decisions' existing `meeting_id UUID` (plain, no FK).
ALTER TABLE hypotheses     ADD COLUMN IF NOT EXISTS meeting_id UUID;
ALTER TABLE open_questions ADD COLUMN IF NOT EXISTS meeting_id UUID;

-- ── RLS (mirror the meeting-pack pattern) ──
ALTER TABLE writeback_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY writeback_proposals_service ON writeback_proposals FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY writeback_proposals_auth    ON writeback_proposals FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Verify ──
SELECT table_name FROM information_schema.tables WHERE table_name = 'writeback_proposals';
SELECT column_name FROM information_schema.columns
WHERE table_name IN ('hypotheses','open_questions') AND column_name = 'meeting_id'
ORDER BY table_name;
```

- [ ] **Step 2: Apply manually in the SQL Editor**

Paste into the Supabase SQL Editor → New Query and run. Confirm the first `SELECT` returns `writeback_proposals` and the second returns two rows (one for `hypotheses`, one for `open_questions`).

- [ ] **Step 3: Verify the CHECK constraints reject bad values**

Run in the SQL Editor:

```sql
INSERT INTO writeback_proposals (meeting_id, kind, text) VALUES (gen_random_uuid(), 'bogus', 'x');
```

Expected: ERROR — violates the `kind` CHECK (or the FK; either rejects the row). No row inserted.

- [ ] **Step 4: Commit**

```bash
git add supabase/writeback_schema.sql
git commit -m "feat: add writeback_proposals schema + meeting_id provenance (write-back)"
```

---

### Task 2: `logic.ts` — pure parse/map logic (TDD)

**Files:**
- Create: `supabase/functions/writeback/logic.ts`
- Test: `supabase/functions/writeback/logic_test.ts`

**Interfaces:**
- Produces:
  - `type ProposalKind = 'decision' | 'hypothesis' | 'open_question' | 'summary'`
  - `interface ProposalInput { kind: ProposalKind; text: string; detail: string | null; domains: string[] }`
  - `interface KnowledgeInsert { table: 'decisions' | 'hypotheses' | 'open_questions'; row: Record<string, unknown> }`
  - `function parseExtraction(rawText: string): ProposalInput[]` — parses Claude's `{summary, decisions[], hypotheses[], open_questions[]}`; returns a flat `ProposalInput[]` (a `summary` entry first if non-empty, then the items); throws only on unparseable JSON; skips malformed entries; empty arrays are valid (yields just the summary, or `[]`).
  - `function toKnowledgeInsert(p: ProposalInput, meetingId: string, decidedAt: string): KnowledgeInsert | null` — maps an item proposal to its target table + insert row; returns `null` for `kind='summary'` OR for empty `domains` (signals "not committable here").

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/writeback/logic_test.ts`:

```typescript
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { parseExtraction, toKnowledgeInsert } from './logic.ts'

const full = JSON.stringify({
  summary: 'We leaned vertical AI but flagged the routing risk.',
  decisions: [{ text: 'Focus Q1 on vertical AI', context: 'domain-data moat', domains: ['ai', 'business'] }],
  hypotheses: [{ statement: 'Routing margin compresses by 2027', domains: ['ai'] }],
  open_questions: [{ question: 'Can we defend the data moat?', why_it_matters: 'core to the bet', domains: ['ai'] }],
})

Deno.test('parseExtraction returns summary first, then one input per item', () => {
  const out = parseExtraction(full)
  assertEquals(out.length, 4)
  assertEquals(out[0], { kind: 'summary', text: 'We leaned vertical AI but flagged the routing risk.', detail: null, domains: [] })
  assertEquals(out[1], { kind: 'decision', text: 'Focus Q1 on vertical AI', detail: 'domain-data moat', domains: ['ai', 'business'] })
  assertEquals(out[2], { kind: 'hypothesis', text: 'Routing margin compresses by 2027', detail: null, domains: ['ai'] })
  assertEquals(out[3], { kind: 'open_question', text: 'Can we defend the data moat?', detail: 'core to the bet', domains: ['ai'] })
})

Deno.test('parseExtraction strips ```json fences', () => {
  const out = parseExtraction('```json\n' + full + '\n```')
  assertEquals(out.length, 4)
})

Deno.test('parseExtraction skips items missing required text and empty summary', () => {
  const raw = JSON.stringify({
    summary: '',
    decisions: [{ text: '', domains: ['ai'] }, { text: 'Keep it', domains: ['ai'] }],
    hypotheses: [],
    open_questions: [],
  })
  const out = parseExtraction(raw)
  assertEquals(out.length, 1) // no summary row (empty), one valid decision
  assertEquals(out[0].text, 'Keep it')
})

Deno.test('parseExtraction returns [] for a well-formed empty extraction', () => {
  assertEquals(parseExtraction('{"summary":"","decisions":[],"hypotheses":[],"open_questions":[]}'), [])
})

Deno.test('parseExtraction throws on unparseable output', () => {
  assertThrows(() => parseExtraction('not json'))
})

Deno.test('toKnowledgeInsert maps a decision', () => {
  const p = { kind: 'decision' as const, text: 'Focus vertical AI', detail: 'moat', domains: ['ai'] }
  assertEquals(toKnowledgeInsert(p, 'm1', '2026-08-24'), {
    table: 'decisions',
    row: { text: 'Focus vertical AI', context: 'moat', domains: ['ai'], decided_at: '2026-08-24', meeting_id: 'm1', status: 'standing' },
  })
})

Deno.test('toKnowledgeInsert maps a hypothesis and an open_question', () => {
  assertEquals(toKnowledgeInsert({ kind: 'hypothesis', text: 'H', detail: null, domains: ['ai'] }, 'm1', '2026-08-24'), {
    table: 'hypotheses', row: { statement: 'H', domains: ['ai'], meeting_id: 'm1', status: 'open' },
  })
  assertEquals(toKnowledgeInsert({ kind: 'open_question', text: 'Q?', detail: 'why', domains: ['ai'] }, 'm1', '2026-08-24'), {
    table: 'open_questions', row: { question: 'Q?', why_it_matters: 'why', domains: ['ai'], meeting_id: 'm1', status: 'open' },
  })
})

Deno.test('toKnowledgeInsert returns null for summary and for empty domains', () => {
  assertEquals(toKnowledgeInsert({ kind: 'summary', text: 's', detail: null, domains: [] }, 'm1', '2026-08-24'), null)
  assertEquals(toKnowledgeInsert({ kind: 'decision', text: 'd', detail: null, domains: [] }, 'm1', '2026-08-24'), null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd supabase/functions/writeback && deno test logic_test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/writeback/logic.ts`:

```typescript
/**
 * Pure parse/map helpers for the writeback edge function. No I/O —
 * unit-tested in logic_test.ts. The handler (index.ts) does all DB/Claude I/O
 * and calls these to turn Claude's extraction into proposal rows and, at
 * commit, into knowledge-layer insert objects.
 */

export type ProposalKind = 'decision' | 'hypothesis' | 'open_question' | 'summary'

export interface ProposalInput {
  kind: ProposalKind
  text: string
  detail: string | null
  domains: string[]
}

export interface KnowledgeInsert {
  table: 'decisions' | 'hypotheses' | 'open_questions'
  row: Record<string, unknown>
}

function cleanDomains(d: unknown): string[] {
  return Array.isArray(d) ? d.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim()) : []
}

export function parseExtraction(rawText: string): ProposalInput[] {
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`writeback: Claude returned unparseable JSON: ${rawText.slice(0, 300)}`)
  }
  const p = (parsed || {}) as Record<string, unknown>
  const out: ProposalInput[] = []

  const summary = typeof p.summary === 'string' ? p.summary.trim() : ''
  if (summary) out.push({ kind: 'summary', text: summary, detail: null, domains: [] })

  for (const d of (Array.isArray(p.decisions) ? p.decisions : [])) {
    const it = d as Record<string, unknown>
    const text = typeof it.text === 'string' ? it.text.trim() : ''
    if (!text) continue
    out.push({ kind: 'decision', text, detail: typeof it.context === 'string' ? it.context.trim() : null, domains: cleanDomains(it.domains) })
  }
  for (const h of (Array.isArray(p.hypotheses) ? p.hypotheses : [])) {
    const it = h as Record<string, unknown>
    const text = typeof it.statement === 'string' ? it.statement.trim() : ''
    if (!text) continue
    out.push({ kind: 'hypothesis', text, detail: null, domains: cleanDomains(it.domains) })
  }
  for (const q of (Array.isArray(p.open_questions) ? p.open_questions : [])) {
    const it = q as Record<string, unknown>
    const text = typeof it.question === 'string' ? it.question.trim() : ''
    if (!text) continue
    out.push({ kind: 'open_question', text, detail: typeof it.why_it_matters === 'string' ? it.why_it_matters.trim() : null, domains: cleanDomains(it.domains) })
  }

  return out
}

export function toKnowledgeInsert(p: ProposalInput, meetingId: string, decidedAt: string): KnowledgeInsert | null {
  if (p.kind === 'summary') return null
  if (!p.domains.length) return null
  if (p.kind === 'decision') {
    return { table: 'decisions', row: { text: p.text, context: p.detail, domains: p.domains, decided_at: decidedAt, meeting_id: meetingId, status: 'standing' } }
  }
  if (p.kind === 'hypothesis') {
    return { table: 'hypotheses', row: { statement: p.text, domains: p.domains, meeting_id: meetingId, status: 'open' } }
  }
  return { table: 'open_questions', row: { question: p.text, why_it_matters: p.detail, domains: p.domains, meeting_id: meetingId, status: 'open' } }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd supabase/functions/writeback && deno test logic_test.ts`
Expected: PASS (8 tests, `ok`).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/writeback/logic.ts supabase/functions/writeback/logic_test.ts
git commit -m "feat: add writeback parse/map logic with tests"
```

---

### Task 3: `writeback` edge function handler

**Files:**
- Create: `supabase/functions/writeback/index.ts`

**Interfaces:**
- Consumes: `sendAlert` from `../_shared/alert.ts`; `parseExtraction`, `toKnowledgeInsert`, types from `./logic.ts`; `meetings`, `session_messages`, `writeback_proposals`, `decisions`, `hypotheses`, `open_questions`, `pipeline_runs`.
- Produces: `POST /functions/v1/writeback` body `{ meeting_id, mode: 'extract'|'commit' }`. `extract` → `{ ok, proposed }`; `commit` → `{ ok, committed, skipped }`.

- [ ] **Step 1: Write the handler**

Create `supabase/functions/writeback/index.ts`:

```typescript
/**
 * writeback — Supabase Edge Function
 * ==================================
 * mode='extract': Claude reads a completed meeting's session_messages
 *   transcript and proposes a summary + new decisions/hypotheses/open
 *   questions into the writeback_proposals staging table. NO knowledge-layer
 *   write.
 * mode='commit': inserts the approved (included) proposals into the knowledge
 *   layer with meeting_id provenance, writes meetings.summary, and marks
 *   proposals committed/discarded. THE ONLY knowledge-layer write.
 *
 * Create-only: commit never updates/deletes existing rows.
 * POST /functions/v1/writeback   Body: { meeting_id, mode }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendAlert } from '../_shared/alert.ts'
import { parseExtraction, toKnowledgeInsert, type ProposalInput } from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  let mode = 'extract'
  let meetingId: string | undefined
  try {
    const body = await req.json()
    meetingId = body?.meeting_id
    if (body?.mode === 'commit' || body?.mode === 'extract') mode = body.mode
  } catch { /* handled below */ }
  if (!meetingId) return json({ error: 'meeting_id required' }, 400)

  const { data: runRow } = await supabase
    .from('pipeline_runs').insert({ job_name: 'writeback', status: 'running', metadata: { mode, meeting_id: meetingId } })
    .select('id').single()
  const runId = (runRow as { id: string } | null)?.id ?? null

  try {
    const { data: meeting, error: mErr } = await supabase
      .from('meetings').select('id, status').eq('id', meetingId).single()
    if (mErr || !meeting) return json({ error: 'meeting not found' }, 404)
    if ((meeting as { status: string }).status !== 'complete') {
      return json({ error: `write-back requires a completed meeting (status is '${(meeting as { status: string }).status}')` }, 400)
    }

    const result = mode === 'commit'
      ? await runCommit(supabase, meetingId)
      : await runExtract(supabase, meetingId, Deno.env.get('ANTHROPIC_API_KEY')!)

    if (runId) {
      await supabase.from('pipeline_runs').update({
        completed_at: new Date().toISOString(), status: 'success', metadata: { mode, meeting_id: meetingId, ...result },
      }).eq('id', runId)
    }
    return json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`writeback (${mode}) error:`, err)
    if (runId) {
      await supabase.from('pipeline_runs').update({
        completed_at: new Date().toISOString(), status: 'error', error_message: msg, metadata: { mode, meeting_id: meetingId },
      }).eq('id', runId)
    }
    await sendAlert(supabase, 'writeback', `writeback (${mode}) crashed: ${msg}`)
    return json({ ok: false, error: msg }, 500)
  }
})

async function runExtract(supabase: ReturnType<typeof createClient>, meetingId: string, anthropicKey: string) {
  const { data: meeting } = await supabase
    .from('meetings').select('agenda, prospective_result, decision_questions').eq('id', meetingId).single()
  const m = (meeting || {}) as { agenda: string; prospective_result: string | null; decision_questions: string[] }

  const { data: msgs } = await supabase
    .from('session_messages').select('role, content, seq').eq('meeting_id', meetingId).order('seq', { ascending: true })
  const transcript = ((msgs || []) as { role: string; content: string }[])
    .map((mm) => `${mm.role === 'assistant' ? 'COMPANION' : 'EJ'}: ${mm.content}`).join('\n\n')
  if (!transcript.trim()) throw new Error('no transcript to extract from')

  const inputs = await extractProposals(anthropicKey, m, transcript)

  // Re-runnable: clear prior non-edited, still-proposed rows; keep edited + committed.
  await supabase.from('writeback_proposals').delete()
    .eq('meeting_id', meetingId).eq('status', 'proposed').eq('edited', false)

  if (inputs.length) {
    const rows = inputs.map((p) => ({
      meeting_id: meetingId, kind: p.kind, text: p.text, detail: p.detail, domains: p.domains, status: 'proposed',
    }))
    const { error } = await supabase.from('writeback_proposals').insert(rows)
    if (error) throw new Error(`Failed to insert proposals: ${error.message}`)
  }
  return { proposed: inputs.length }
}

async function extractProposals(
  apiKey: string,
  meeting: { agenda: string; prospective_result: string | null; decision_questions: string[] },
  transcript: string,
): Promise<ProposalInput[]> {
  const questions = meeting.decision_questions?.length ? meeting.decision_questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(none)'
  const prompt = `You are extracting durable knowledge from a decision meeting's transcript for EJ, who tracks AI, IT, entrepreneurship, business, and UX. Domains use the slugs: ai, it, entrepreneurship, business, ux.

MEETING AGENDA: ${meeting.agenda}
DESIRED RESULT: ${meeting.prospective_result || '(not specified)'}
DECISION QUESTIONS:
${questions}

TRANSCRIPT:
${transcript}

Extract ONLY what EJ actually concluded, hypothesized, or asked in THIS conversation — be conservative. Do NOT invent decisions EJ didn't make. If the session reached no real decisions, return empty arrays. Assign each item one or more domain slugs from the list above.

Return ONLY a JSON object of this exact shape, no markdown fences:
{"summary": "2-4 sentence recap of what was decided/discussed", "decisions": [{"text": "the decision", "context": "why", "domains": ["ai"]}], "hypotheses": [{"statement": "the hypothesis", "domains": ["ai"]}], "open_questions": [{"question": "the question", "why_it_matters": "why", "domains": ["ai"]}]}`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (data.stop_reason === 'max_tokens') throw new Error('Claude extraction truncated by max_tokens')
  return parseExtraction((data.content?.[0]?.text || '').trim())
}

async function runCommit(supabase: ReturnType<typeof createClient>, meetingId: string) {
  const { data: rows } = await supabase
    .from('writeback_proposals').select('id, kind, text, detail, domains, included').eq('meeting_id', meetingId).eq('status', 'proposed')
  const proposals = (rows || []) as { id: string; kind: ProposalInput['kind']; text: string; detail: string | null; domains: string[]; included: boolean }[]

  const decidedAt = new Date().toISOString().slice(0, 10)
  let committed = 0
  let skipped = 0

  for (const p of proposals) {
    if (!p.included) {
      await supabase.from('writeback_proposals').update({ status: 'discarded' }).eq('id', p.id)
      continue
    }
    if (p.kind === 'summary') {
      await supabase.from('meetings').update({ summary: p.text }).eq('id', meetingId)
      await supabase.from('writeback_proposals').update({ status: 'committed' }).eq('id', p.id)
      committed++
      continue
    }
    const ins = toKnowledgeInsert({ kind: p.kind, text: p.text, detail: p.detail, domains: p.domains }, meetingId, decidedAt)
    if (!ins) { skipped++; continue } // empty domains — leave 'proposed' for EJ to fix
    const { data: created, error } = await supabase.from(ins.table).insert(ins.row).select('id').single()
    if (error) throw new Error(`Failed to commit ${p.kind}: ${error.message}`)
    await supabase.from('writeback_proposals')
      .update({ status: 'committed', committed_ref_id: (created as { id: string }).id }).eq('id', p.id)
    committed++
  }
  return { committed, skipped }
}
```

- [ ] **Step 2: Type-check (informational)**

Run: `cd /Users/ejjung/Dev/ejnewsfeed && deno check supabase/functions/writeback/index.ts` — expect only the pre-existing never-type noise; confirm no NEW error class (typo/syntax). Not a gate.

- [ ] **Step 3: Deploy**

Run: `cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy writeback`
Expected: `Deployed Functions on project oqxxmdyyfjgigfjtposv: writeback`.

- [ ] **Step 4: Live smoke test**

Run from `pipeline/`. Seeds a completed meeting with a short transcript, extracts, inspects proposals, commits, and verifies the knowledge-layer rows + provenance + re-commit idempotency:

```bash
cd pipeline && python3 -c "
import os, json, urllib.request
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path
load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
url = os.environ['SUPABASE_URL'] + '/functions/v1/writeback'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
def call(payload):
    req = urllib.request.Request(url, method='POST',
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'apikey': key},
        data=json.dumps(payload).encode())
    with urllib.request.urlopen(req, timeout=125) as r:
        return r.status, json.loads(r.read().decode())

dec0 = sb.table('decisions').select('*', count='exact', head=True).execute().count
mtg = sb.table('meetings').insert({'title':'WRITEBACK SMOKE — delete me','agenda':'Vertical vs horizontal AI','status':'complete',
    'decision_questions':['Which moat is stronger?']}).execute().data[0]
mid = mtg['id']; print('meeting', mid)
sb.table('session_messages').insert([
  {'meeting_id': mid, 'role':'assistant','seq':0,'content':'What is the single highest-stakes call here?'},
  {'meeting_id': mid, 'role':'user','seq':1,'content':'I have decided we focus Q1 on vertical AI — the domain-data moat is our edge. Open question: can we defend that moat if foundation models keep absorbing verticals? My hypothesis is routing margin compresses by 2027.'},
  {'meeting_id': mid, 'role':'assistant','seq':2,'content':'Then commit to it and name the risk: your moat erodes if data becomes commoditized.'},
]).execute()

s, r = call({'meeting_id': mid, 'mode':'extract'})
print('extract:', s, r)
props = sb.table('writeback_proposals').select('kind, text, domains, included').eq('meeting_id', mid).execute().data
print('proposals:')
for p in props: print('  ', p['kind'], '|', p['text'][:60], '| domains', p['domains'])

s, r = call({'meeting_id': mid, 'mode':'commit'})
print('commit:', s, r)
dec1 = sb.table('decisions').select('id, text, meeting_id, status, decided_at').eq('meeting_id', mid).execute().data
print('decisions with this meeting_id:', dec1)
hyp = sb.table('hypotheses').select('statement, meeting_id, status').eq('meeting_id', mid).execute().data
oq  = sb.table('open_questions').select('question, meeting_id, status').eq('meeting_id', mid).execute().data
print('hypotheses:', hyp)
print('open_questions:', oq)
summ = sb.table('meetings').select('summary').eq('id', mid).single().execute().data['summary']
print('meeting.summary set:', bool(summ))

s, r = call({'meeting_id': mid, 'mode':'commit'})
print('re-commit (should be 0 committed):', s, r)
print('WRITEBACK_SMOKE_ID:', mid)
"
```

Expected: `extract` returns `{ok:true, proposed:N}` with a summary + a decision (vertical AI), a hypothesis (routing margin), an open question (moat defense), each with domains. `commit` returns `{committed:M, skipped:0}`; the `decisions`/`hypotheses`/`open_questions` rows appear WITH the meeting_id and correct default status; `meeting.summary` set; re-commit returns `committed:0` (idempotent). If any item has empty domains, `skipped` reflects it.

- [ ] **Step 5: Clean up (also delete the committed knowledge-layer rows this smoke created)**

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path
load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
m = sb.table('meetings').select('id').eq('title','WRITEBACK SMOKE — delete me').execute().data
for row in m:
    mid = row['id']
    sb.table('decisions').delete().eq('meeting_id', mid).execute()
    sb.table('hypotheses').delete().eq('meeting_id', mid).execute()
    sb.table('open_questions').delete().eq('meeting_id', mid).execute()
    sb.table('meetings').delete().eq('id', mid).execute()  # proposals + session_messages cascade
print('cleaned up smoke meeting + its committed knowledge rows')
"
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/writeback/index.ts
git commit -m "feat: add writeback edge function handler (extract + commit modes)"
```

---

### Task 4: Dashboard — write-back review screen + entry

**Files:**
- Modify: `dashboard/src/lib/supabase.js` (write-back helpers)
- Create: `dashboard/src/components/MeetingWriteback.jsx`
- Modify: `dashboard/src/components/MeetingPack.jsx` (Write-back button on a complete meeting)
- Modify: `dashboard/src/App.jsx` (write-back route)

**Interfaces:**
- Consumes: `getMeeting` (existing); the `writeback` function (Task 3); `writeback_proposals` (Task 1).
- Produces: helpers `getProposals(meetingId)`, `extractWriteback(meetingId)`, `commitWriteback(meetingId)`, `setProposalIncluded(id, included)`, `editProposal(id, {text, detail, domains})`; a `/meetings/:id/writeback` route rendering `MeetingWriteback`.

- [ ] **Step 1: Add helpers to `lib/supabase.js`**

Append to `dashboard/src/lib/supabase.js`:

```javascript
// ── Write-back helpers (Phase 3c) ──

export async function getProposals(meetingId) {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('writeback_proposals').select('*').eq('meeting_id', meetingId).order('kind').order('created_at')
  if (error) throw error
  return data
}

async function invokeWriteback(meetingId, mode) {
  const { data, error } = await supabase.functions.invoke('writeback', { body: { meeting_id: meetingId, mode } })
  if (error) throw error
  if (data?.ok === false) throw new Error(data.error || 'writeback failed')
  return data
}

export async function extractWriteback(meetingId) {
  if (isMockMode) throw new Error('extractWriteback unavailable in mock mode')
  return invokeWriteback(meetingId, 'extract')
}

export async function commitWriteback(meetingId) {
  if (isMockMode) throw new Error('commitWriteback unavailable in mock mode')
  return invokeWriteback(meetingId, 'commit')
}

export async function setProposalIncluded(id, included) {
  if (isMockMode) return
  const { error } = await supabase.from('writeback_proposals').update({ included }).eq('id', id)
  if (error) throw error
}

export async function editProposal(id, { text, detail, domains }) {
  if (isMockMode) return
  const { error } = await supabase
    .from('writeback_proposals').update({ text, detail, domains, edited: true }).eq('id', id)
  if (error) throw error
}
```

- [ ] **Step 2: Create `MeetingWriteback.jsx`**

Create `dashboard/src/components/MeetingWriteback.jsx`:

```jsx
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getMeeting, getProposals, extractWriteback, commitWriteback, setProposalIncluded, editProposal } from '../lib/supabase.js'

const GROUPS = [
  { key: 'decision', label: 'Decisions' },
  { key: 'hypothesis', label: 'Hypotheses' },
  { key: 'open_question', label: 'Open Questions' },
]

export default function MeetingWriteback() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [meeting, setMeeting] = useState(null)
  const [proposals, setProposals] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  const load = useCallback(async () => {
    setMeeting(await getMeeting(id))
    setProposals(await getProposals(id))
  }, [id])

  useEffect(() => { load().catch((e) => setError(e.message)) }, [load])

  async function runExtract() {
    setBusy(true); setError(null); setNote(null)
    try { await extractWriteback(id); await load() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function runCommit() {
    setBusy(true); setError(null); setNote(null)
    try {
      const r = await commitWriteback(id)
      setNote(`Committed ${r.committed} item(s) to the knowledge base${r.skipped ? `; ${r.skipped} skipped for missing domains — add domains and commit again` : ''}.`)
      await load()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (!meeting) return <div className="max-w-3xl mx-auto px-6 py-8 text-gray-500">Loading…</div>

  const summary = proposals.find((p) => p.kind === 'summary')
  const hasProposed = proposals.some((p) => p.status === 'proposed')
  const committed = proposals.some((p) => p.status === 'committed')

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <button onClick={() => navigate(`/meetings/${id}`)} className="text-sm text-gray-500 hover:underline mb-4">← Meeting</button>
      <h1 className="text-2xl font-semibold text-gray-900">Write-back — {meeting.title}</h1>

      {proposals.length === 0 ? (
        <div className="mt-6">
          <p className="text-sm text-gray-500 mb-3">Extract the decisions, hypotheses, and open questions from this session's transcript.</p>
          <button onClick={runExtract} disabled={busy}
            className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50">
            {busy ? 'Extracting…' : 'Extract decisions & questions'}
          </button>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>
      ) : (
        <>
          {summary && (
            <div className="mt-5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Summary</h2>
              <ProposalCard p={summary} onSaved={load} committedMode={committed} />
            </div>
          )}
          {GROUPS.map((g) => {
            const items = proposals.filter((p) => p.kind === g.key)
            if (!items.length) return null
            return (
              <section key={g.key} className="mt-5">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">{g.label}</h2>
                <div className="space-y-2">{items.map((p) => <ProposalCard key={p.id} p={p} onSaved={load} committedMode={committed} />)}</div>
              </section>
            )
          })}

          {note && <p className="mt-5 text-sm text-green-700">{note}</p>}
          {error && <p className="mt-5 text-sm text-red-600">{error}</p>}

          <div className="mt-6 flex gap-3">
            {hasProposed && (
              <>
                <button onClick={runExtract} disabled={busy}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-100 disabled:opacity-50">Re-extract</button>
                <button onClick={runCommit} disabled={busy}
                  className="px-4 py-1.5 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700 disabled:opacity-50">
                  {busy ? 'Working…' : 'Commit to knowledge base'}
                </button>
              </>
            )}
            {committed && !hasProposed && <span className="text-sm text-green-700 font-medium">✓ Committed to the knowledge base</span>}
          </div>
        </>
      )}
    </div>
  )
}

function ProposalCard({ p, onSaved, committedMode }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(p.text)
  const [detail, setDetail] = useState(p.detail || '')
  const [domains, setDomains] = useState((p.domains || []).join(', '))

  const isCommitted = p.status === 'committed'
  const isDiscarded = p.status === 'discarded'
  const editable = p.status === 'proposed'

  async function save() {
    await editProposal(p.id, {
      text, detail: detail.trim() || null,
      domains: domains.split(',').map((d) => d.trim()).filter(Boolean),
    })
    setEditing(false); await onSaved()
  }
  async function toggle() { await setProposalIncluded(p.id, !p.included); await onSaved() }

  const dimmed = (!p.included && editable) || isDiscarded

  return (
    <div className={`p-4 rounded-lg border ${dimmed ? 'border-gray-100 opacity-40' : 'border-gray-200'}`}>
      {editing ? (
        <div className="space-y-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
          {p.kind !== 'hypothesis' && p.kind !== 'summary' && (
            <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={2} placeholder="context / why it matters" className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
          )}
          {p.kind !== 'summary' && (
            <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="domains (comma-separated: ai, business)" className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
          )}
          <div className="flex gap-2">
            <button onClick={save} className="text-xs text-violet-600 hover:underline">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:underline">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-900 whitespace-pre-wrap">{p.text}</p>
          {p.detail && <p className="text-xs text-gray-500 mt-1">{p.detail}</p>}
          {p.kind !== 'summary' && p.domains?.length > 0 && <p className="text-xs text-violet-500 mt-1">{p.domains.join(' · ')}</p>}
          {p.kind !== 'summary' && p.domains?.length === 0 && editable && <p className="text-xs text-amber-600 mt-1">no domains — add some before committing</p>}
          {editable && !committedMode && (
            <div className="flex gap-2 mt-2">
              <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-gray-700">Edit</button>
              {p.kind !== 'summary' && (
                <button onClick={toggle} className="text-xs text-gray-400 hover:text-gray-700">{p.included ? 'Exclude' : 'Include'}</button>
              )}
            </div>
          )}
          {isCommitted && <p className="text-xs text-green-600 mt-1">✓ in the knowledge base</p>}
          {isDiscarded && <p className="text-xs text-gray-400 mt-1">excluded</p>}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add the entry button in `MeetingPack.jsx`**

In `dashboard/src/components/MeetingPack.jsx`, the `complete`-status block currently renders a "View transcript" button. Add a Write-back button right after it (same action row):

```jsx
{meeting.status === 'complete' && (
  <button onClick={() => navigate(`/meetings/${id}/writeback`)}
    className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-sm hover:bg-violet-700">
    Write-back
  </button>
)}
```

- [ ] **Step 4: Wire the route in `App.jsx`**

Add the import (after the `MeetingSession` import):

```jsx
import MeetingWriteback from './components/MeetingWriteback.jsx'
```

Add the route next to the `/meetings/:id/session` route:

```jsx
<Route path="/meetings/:id/writeback" element={<MeetingWriteback />} />
```

- [ ] **Step 5: Build check**

Run: `cd dashboard && npm run build`
Expected: builds with no errors.

- [ ] **Step 6: Verify the full write-back loop end-to-end**

Run `cd dashboard && npm run dev`. On a meeting you've completed a session for:
1. Open the meeting → **Write-back** → the write-back view.
2. Click **Extract decisions & questions** → a summary + grouped proposals appear, each with domains.
3. Toggle **Exclude** on one, **Edit** another (change text/domains), then **Commit to knowledge base**.
4. Confirm the success note (committed N). Reopen the Knowledge view / query the DB to confirm the approved items are now in `decisions`/`hypotheses`/`open_questions` with this meeting's `meeting_id`, and the excluded one is not.
5. Confirm an item with its domains cleared is reported as skipped, not committed.

Expected: every step behaves as described; no console errors.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/lib/supabase.js dashboard/src/components/MeetingWriteback.jsx dashboard/src/components/MeetingPack.jsx dashboard/src/App.jsx
git commit -m "feat: add write-back review screen + entry from completed meeting"
```

---

## After this plan lands

Update `knowledge-center-plan.md`'s Phase 3 entry: mark 3e write-back complete, and note that Phase 3 (the meeting flywheel) is now end-to-end — with the remaining follow-ons being update-existing-rows write-back and the Realtime voice swap of the session. This closes the core flywheel: a pack (Prep) → a session (companion) → write-back (this) → the next pack reads what this wrote. Not a task here (documentation bookkeeping on a different file).
