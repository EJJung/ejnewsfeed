# Companion Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From an approved meeting pack, let EJ hold a resumable text conversation with a skeptical "Challenger" companion that argues from the pack, ending in a `complete` meeting with a stored transcript — read-only against the knowledge layer.

**Architecture:** One new edge function `session-chat` (synchronous Claude call, same shape as `generate-analysis`) with its pure prompt/history logic factored into a unit-tested `prompt.ts`. One new table `session_messages` (the transcript) plus a CHECK extension on `meetings.status`, applied via the SQL Editor. One new dashboard session screen reachable from the approved pack, plus data helpers.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres (SQL Editor), Claude API (`claude-sonnet-4-6`, non-streaming), React + Vite + react-router-dom + Tailwind.

## Global Constraints

- Claude model: `claude-sonnet-4-6` (matches every other edge function in this repo).
- Every external `fetch` (Claude) MUST set `AbortSignal.timeout(...)`.
- **Read-only against the knowledge layer:** `session-chat` may only read `meetings` and `context_cards`. It MUST NOT read OR write `insights`, `insight_sources`, `decisions`, `hypotheses`, `open_questions`, `articles`. Its only writes are to `meetings` (status) and `session_messages`.
- `session_messages.role` CHECK values are exactly: `user`, `assistant`.
- `meetings.status` CHECK, after this spec, is exactly: `draft`, `assembling`, `pack_ready`, `approved`, `error`, `in_session`, `complete`.
- The companion is a **Challenger**: works toward the meeting's prospective result, presses each decision question, and surfaces the pack's contradictions/argues the uncomfortable side rather than agreeing by default. Concise and direct.
- The session reads the pack's cards where `included = true` only (excluded cards never enter the prompt).
- `deno check` is NOT a valid gate for this repo's edge functions (pre-existing repo-wide `never`-type inference noise on the untyped Supabase client — the deployed functions fail it identically). Validate edge functions via `supabase functions deploy` + live invoke. Do not "fix" the never-type noise.
- No `pipeline_runs` background machinery (this is a short synchronous request). No streaming. No write-back (next spec). No voice/Realtime.
- Full spec: `docs/superpowers/specs/2026-08-24-companion-session-design.md`.

---

### Task 1: Schema — `session_messages` + extend `meetings.status` CHECK

**Files:**
- Create: `supabase/companion_session_schema.sql`

**Interfaces:**
- Consumes: the Prep half's `meetings` table (its `status` CHECK is `meetings_status_check`).
- Produces: table `session_messages`; widened `meetings.status` CHECK.

- [ ] **Step 1: Write the schema SQL file**

Create `supabase/companion_session_schema.sql`:

```sql
-- ============================================================
-- EJ Newsfeed — Companion Session schema (Phase 3b: Capture half, session)
-- Run in Supabase SQL Editor → New Query
-- Adds the session transcript table and widens meetings.status.
-- Read-only consumer of the knowledge layer.
-- ============================================================

CREATE TABLE IF NOT EXISTS session_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  seq         INT NOT NULL,          -- monotonic turn order within the meeting (0 = companion opener)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_messages_meeting_seq
  ON session_messages(meeting_id, seq);

-- Widen meetings.status to add in_session + complete (reserved by the Prep spec).
-- The Prep schema created an inline single-column CHECK, auto-named
-- meetings_status_check. Drop and recreate it with the two new values.
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('draft','assembling','pack_ready','approved','error','in_session','complete'));

-- ── RLS (mirror the meeting-pack pattern) ──
ALTER TABLE session_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_messages_service ON session_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY session_messages_auth    ON session_messages FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Verify ──
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE conname = 'meetings_status_check';
SELECT table_name FROM information_schema.tables WHERE table_name = 'session_messages';
```

- [ ] **Step 2: Apply manually in the SQL Editor**

Paste the file into the Supabase SQL Editor → New Query and run. Confirm the first `SELECT` shows the `meetings_status_check` def containing `in_session` and `complete`, and the second returns `session_messages`.

- [ ] **Step 3: Verify the widened CHECK accepts the new values and the messages CHECK rejects a bad role**

Run in the SQL Editor:

```sql
INSERT INTO session_messages (meeting_id, role, content, seq)
VALUES (gen_random_uuid(), 'bogus', 'x', 0);
```

Expected: ERROR — violates check constraint `session_messages_role_check` (the FK would also fail, but the role CHECK is what we're verifying; either error confirms the row is rejected). No row inserted.

- [ ] **Step 4: Commit**

```bash
git add supabase/companion_session_schema.sql
git commit -m "feat: add session_messages schema, widen meetings.status (companion session)"
```

---

### Task 2: `prompt.ts` — pure prompt + history logic (TDD)

**Files:**
- Create: `supabase/functions/session-chat/prompt.ts`
- Test: `supabase/functions/session-chat/prompt_test.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `interface MeetingCtx { agenda: string; prospective_result: string | null; decision_questions: string[] }`
  - `interface Card { card_type: string; headline: string; body: string; why_relevant: string | null; included: boolean }`
  - `interface Msg { role: string; content: string }`
  - `interface ClaudeMsg { role: 'user' | 'assistant'; content: string }`
  - `const BEGIN_SEED: string`
  - `function buildSystemPrompt(meeting: MeetingCtx, cards: Card[]): string` — filters to `included !== false` cards, groups by card_type, embeds persona + agenda + prospective result + decision questions.
  - `function toClaudeMessages(rows: Msg[]): ClaudeMsg[]` — prepends a `user`/`BEGIN_SEED` turn, maps rows verbatim (so history always starts with `user`, satisfying the Claude API).

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/session-chat/prompt_test.ts`:

```typescript
import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { buildSystemPrompt, toClaudeMessages, BEGIN_SEED } from './prompt.ts'

const meeting = {
  agenda: 'Pick next quarter AI focus',
  prospective_result: 'A ranked shortlist',
  decision_questions: ['Which domain has the strongest tailwind?', 'What are we most wrong about?'],
}
const cards = [
  { card_type: 'insight', headline: 'Vertical AI wins', body: 'Domain-specific AI outperforms', why_relevant: 'core thesis', included: true },
  { card_type: 'article', headline: 'Stripe buys OpenRouter', body: 'Model routing validated', why_relevant: 'concrete signal', included: true },
  { card_type: 'insight', headline: 'EXCLUDED CARD', body: 'should not appear', why_relevant: 'nope', included: false },
]

Deno.test('buildSystemPrompt embeds agenda, result, and every decision question', () => {
  const p = buildSystemPrompt(meeting, cards)
  assertStringIncludes(p, 'Pick next quarter AI focus')
  assertStringIncludes(p, 'A ranked shortlist')
  assertStringIncludes(p, 'Which domain has the strongest tailwind?')
  assertStringIncludes(p, 'What are we most wrong about?')
})

Deno.test('buildSystemPrompt conveys the Challenger persona', () => {
  const p = buildSystemPrompt(meeting, cards).toLowerCase()
  assertStringIncludes(p, 'challenger')
  assertStringIncludes(p, 'press')
})

Deno.test('buildSystemPrompt includes included cards and excludes included=false cards', () => {
  const p = buildSystemPrompt(meeting, cards)
  assertStringIncludes(p, 'Vertical AI wins')
  assertStringIncludes(p, 'Stripe buys OpenRouter')
  assertEquals(p.includes('EXCLUDED CARD'), false)
  assertEquals(p.includes('should not appear'), false)
})

Deno.test('buildSystemPrompt handles a null prospective_result and empty questions', () => {
  const p = buildSystemPrompt({ agenda: 'A', prospective_result: null, decision_questions: [] }, [])
  assertStringIncludes(p, 'A')
  // Should not throw and should still contain the persona
  assertStringIncludes(p.toLowerCase(), 'challenger')
})

Deno.test('toClaudeMessages prepends a user BEGIN_SEED turn to empty history', () => {
  const out = toClaudeMessages([])
  assertEquals(out.length, 1)
  assertEquals(out[0], { role: 'user', content: BEGIN_SEED })
})

Deno.test('toClaudeMessages yields valid alternation starting with user for an assistant-first transcript', () => {
  const rows = [
    { role: 'assistant', content: 'opener' },
    { role: 'user', content: 'my reply' },
  ]
  const out = toClaudeMessages(rows)
  assertEquals(out.map((m) => m.role), ['user', 'assistant', 'user'])
  assertEquals(out[0].content, BEGIN_SEED)
  assertEquals(out[1], { role: 'assistant', content: 'opener' })
  assertEquals(out[2], { role: 'user', content: 'my reply' })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd supabase/functions/session-chat && deno test prompt_test.ts`
Expected: FAIL — `Module not found "file:///.../prompt.ts"`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/session-chat/prompt.ts`:

```typescript
/**
 * Pure prompt + history helpers for session-chat. No I/O — unit-tested in
 * prompt_test.ts. The handler (index.ts) does all DB/Claude I/O and calls
 * these to build the Claude request.
 */

export interface MeetingCtx {
  agenda: string
  prospective_result: string | null
  decision_questions: string[]
}

export interface Card {
  card_type: string
  headline: string
  body: string
  why_relevant: string | null
  included: boolean
}

export interface Msg {
  role: string
  content: string
}

export interface ClaudeMsg {
  role: 'user' | 'assistant'
  content: string
}

// Sent as the leading user turn so the Claude message history always starts
// with `user` (the API requires it) even though the companion's opener is the
// first stored message. Also the instruction that produces that opener.
export const BEGIN_SEED =
  "Let's begin. Open the session by naming the single highest-stakes, most contested decision on the table right now, and push me on it."

const GROUP_LABELS: Record<string, string> = {
  insight: 'INSIGHTS',
  decision: 'PRIOR DECISIONS',
  hypothesis: 'HYPOTHESES',
  open_question: 'OPEN QUESTIONS',
  article: 'RECENT ARTICLES',
  manual: 'EJ-ADDED NOTES',
}
const GROUP_ORDER = ['insight', 'decision', 'hypothesis', 'open_question', 'article', 'manual']

function renderCards(cards: Card[]): string {
  const included = cards.filter((c) => c.included !== false)
  const parts: string[] = []
  for (const key of GROUP_ORDER) {
    const group = included.filter((c) => c.card_type === key)
    if (!group.length) continue
    const lines = group.map((c) =>
      `- ${c.headline}: ${c.body}${c.why_relevant ? ` (why it's here: ${c.why_relevant})` : ''}`,
    )
    parts.push(`${GROUP_LABELS[key] || key.toUpperCase()}\n${lines.join('\n')}`)
  }
  return parts.join('\n\n') || '(the pack is empty)'
}

export function buildSystemPrompt(meeting: MeetingCtx, cards: Card[]): string {
  const questions = meeting.decision_questions?.length
    ? meeting.decision_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(none specified)'

  return `You are EJ's meeting companion — a sharp, skeptical Challenger, not a cheerleader. Your job is to help EJ reach a real, defensible decision on the agenda below, not to make EJ feel good.

How you operate:
- Work toward the desired result. Keep the conversation moving toward an actual decision.
- Press hard on each decision question. Don't let vague answers slide.
- When the context pack contains contradicting evidence, surface that tension and argue the uncomfortable side rather than agreeing by default.
- Be concise and direct. Challenge weak reasoning. Skip agreeable filler and flattery.

AGENDA: ${meeting.agenda}
DESIRED RESULT: ${meeting.prospective_result || '(not specified)'}
DECISION QUESTIONS:
${questions}

CONTEXT PACK (EJ's approved knowledge for this meeting — argue from it):
${renderCards(cards)}`
}

export function toClaudeMessages(rows: Msg[]): ClaudeMsg[] {
  return [
    { role: 'user', content: BEGIN_SEED },
    ...rows.map((r) => ({ role: r.role === 'assistant' ? 'assistant' as const : 'user' as const, content: r.content })),
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd supabase/functions/session-chat && deno test prompt_test.ts`
Expected: PASS (6 tests, `ok`).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/session-chat/prompt.ts supabase/functions/session-chat/prompt_test.ts
git commit -m "feat: add session-chat prompt + history logic with tests"
```

---

### Task 3: `session-chat` edge function handler

**Files:**
- Create: `supabase/functions/session-chat/index.ts`

**Interfaces:**
- Consumes: `buildSystemPrompt`, `toClaudeMessages`, types from `./prompt.ts`; `meetings`, `context_cards`, `session_messages` tables.
- Produces: `POST /functions/v1/session-chat` with body `{ meeting_id, start?: true, message?: string }` → `{ reply }` on success. Writes `session_messages` rows and flips `meetings.status` to `in_session` on session start.

- [ ] **Step 1: Write the handler**

Create `supabase/functions/session-chat/index.ts`:

```typescript
/**
 * session-chat — Supabase Edge Function
 * =====================================
 * A synchronous chat turn with the "Challenger" meeting companion, over the
 * meeting's approved pack. Two modes:
 *   { meeting_id, start: true } — begin the session: flip approved→in_session,
 *     generate + store the companion's opening turn (seq 0), return it.
 *   { meeting_id, message }     — a normal turn: store the user message, get
 *     the companion's reply, store + return it.
 *
 * READ-ONLY against the knowledge layer: reads only meetings + context_cards;
 * writes only meetings (status) + session_messages.
 *
 * POST /functions/v1/session-chat
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildSystemPrompt, toClaudeMessages, type Card, type Msg } from './prompt.ts'

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

  try {
    const body = await req.json().catch(() => null)
    const meetingId: string | undefined = body?.meeting_id
    const isStart: boolean = body?.start === true
    const message: string | undefined = typeof body?.message === 'string' ? body.message : undefined
    if (!meetingId) return json({ error: 'meeting_id required' }, 400)
    if (!isStart && !message?.trim()) return json({ error: 'message required' }, 400)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

    // Load the meeting and validate status per mode.
    const { data: meeting, error: mErr } = await supabase
      .from('meetings')
      .select('id, status, agenda, prospective_result, decision_questions')
      .eq('id', meetingId)
      .single()
    if (mErr || !meeting) return json({ error: 'meeting not found' }, 404)
    const m = meeting as {
      status: string; agenda: string; prospective_result: string | null; decision_questions: string[]
    }

    if (isStart && m.status !== 'approved' && m.status !== 'in_session') {
      return json({ error: `cannot start a session for a meeting in status '${m.status}'` }, 400)
    }
    if (!isStart && m.status !== 'in_session') {
      return json({ error: `cannot chat a meeting in status '${m.status}'` }, 400)
    }

    // Load existing transcript (also gives us the next seq).
    const { data: existingRows } = await supabase
      .from('session_messages')
      .select('role, content, seq')
      .eq('meeting_id', meetingId)
      .order('seq', { ascending: true })
    const existing = (existingRows || []) as (Msg & { seq: number })[]

    // Idempotent start: if already begun, just return the stored opener.
    if (isStart && existing.length > 0) {
      const opener = existing.find((r) => r.role === 'assistant')?.content ?? existing[0].content
      if (m.status !== 'in_session') {
        await supabase.from('meetings').update({ status: 'in_session' }).eq('id', meetingId)
      }
      return json({ reply: opener })
    }

    // Build the system prompt from the approved pack (all cards; the pure
    // renderer filters to included=true).
    const { data: cardRows } = await supabase
      .from('context_cards')
      .select('card_type, headline, body, why_relevant, included')
      .eq('meeting_id', meetingId)
    const cards = (cardRows || []) as Card[]
    const system = buildSystemPrompt(m, cards)

    // For a normal turn, persist the user message first so it's part of history.
    let history: Msg[] = existing.map((r) => ({ role: r.role, content: r.content }))
    if (!isStart) {
      const userSeq = existing.length
      const { error: uErr } = await supabase.from('session_messages').insert({
        meeting_id: meetingId, role: 'user', content: message!.trim(), seq: userSeq,
      })
      if (uErr) throw new Error(`Failed to store user message: ${uErr.message}`)
      history = [...history, { role: 'user', content: message!.trim() }]
    }

    const claudeMessages = toClaudeMessages(history)

    const res = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1500, system, messages: claudeMessages }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`)
    const data = await res.json()
    if (data.stop_reason === 'max_tokens') throw new Error('Claude reply was truncated by max_tokens')
    const reply = (data.content?.[0]?.text || '').trim()
    if (!reply) throw new Error('Claude returned an empty reply')

    // Persist the assistant reply at the next seq.
    const assistantSeq = isStart ? 0 : existing.length + 1
    const { error: aErr } = await supabase.from('session_messages').insert({
      meeting_id: meetingId, role: 'assistant', content: reply, seq: assistantSeq,
    })
    if (aErr) throw new Error(`Failed to store assistant reply: ${aErr.message}`)

    if (isStart) {
      await supabase.from('meetings').update({ status: 'in_session' }).eq('id', meetingId)
    }

    return json({ reply })
  } catch (err) {
    console.error('session-chat error:', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
```

- [ ] **Step 2: Type-check (informational only)**

Run: `cd /Users/ejjung/Dev/ejnewsfeed && deno check supabase/functions/session-chat/index.ts`

As documented in Global Constraints, expect the same pre-existing `never`-type inference errors the other edge functions produce on the untyped Supabase client. Confirm only that no NEW error class appears (e.g. `cannot find name` from a typo, or a genuine syntax error). The real validation is Steps 3–4.

- [ ] **Step 3: Deploy**

Run: `cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy session-chat`
Expected: `Deployed Functions on project oqxxmdyyfjgigfjtposv: session-chat`.

- [ ] **Step 4: Live smoke test against a seeded, approved meeting**

Run from `pipeline/` (has the service-role env). This creates a meeting, seeds an approved pack directly (no assemble-pack dependency), starts a session, sends one turn, and verifies transcript + read-only:

```bash
cd pipeline && python3 -c "
import os, json, urllib.request
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path
load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
url = os.environ['SUPABASE_URL'] + '/functions/v1/session-chat'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
def call(payload):
    req = urllib.request.Request(url, method='POST',
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'apikey': key},
        data=json.dumps(payload).encode())
    with urllib.request.urlopen(req, timeout=125) as r:
        return r.status, json.loads(r.read().decode())

def kl_counts():
    return {t: sb.table(t).select('*', count='exact', head=True).execute().count
            for t in ['insights','decisions','hypotheses','open_questions','articles']}
before = kl_counts()

mtg = sb.table('meetings').insert({
    'title': 'SESSION SMOKE — delete me',
    'agenda': 'Should we focus next quarter on vertical AI or horizontal tooling?',
    'prospective_result': 'A clear pick with the main risk named.',
    'decision_questions': ['Which bet has the stronger moat?', 'What would make us reverse this in 6 months?'],
    'status': 'approved',
}).execute().data[0]
mid = mtg['id']; print('meeting', mid)
sb.table('context_cards').insert([
  {'meeting_id': mid, 'card_type': 'insight', 'headline': 'Vertical AI matches HW valuations',
   'body': 'Domain-specific AI apps are commanding general-purpose-hardware multiples.', 'why_relevant': 'core tension', 'included': True},
  {'meeting_id': mid, 'card_type': 'insight', 'headline': 'Model routing is the horizontal control point',
   'body': 'Whoever controls routing captures margin across verticals.', 'why_relevant': 'counter-thesis', 'included': True},
  {'meeting_id': mid, 'card_type': 'insight', 'headline': 'EXCLUDED — should not steer the companion',
   'body': 'excluded card body', 'why_relevant': None, 'included': False},
]).execute()

s, r = call({'meeting_id': mid, 'start': True})
print('start:', s, (r.get('reply') or r)[:220] if isinstance(r.get('reply'), str) else r)
st = sb.table('meetings').select('status').eq('id', mid).single().execute().data['status']
print('status after start:', st)

s, r = call({'meeting_id': mid, 'message': 'I lean vertical AI because the moat is domain data. Convince me I am wrong.'})
print('turn:', s, (r.get('reply') or r)[:260] if isinstance(r.get('reply'), str) else r)

msgs = sb.table('session_messages').select('role, seq, content').eq('meeting_id', mid).order('seq').execute().data
print('transcript:', [(mm['seq'], mm['role']) for mm in msgs])
after = kl_counts()
print('READ-ONLY OK:', before == after)
print('SESSION_SMOKE_ID:', mid)
"
```

Expected: `start: 200` with a provocative opener; `status after start: in_session`; the turn returns a reply that pushes back (argues the horizontal/routing side); transcript `[(0,'assistant'),(1,'user'),(2,'assistant')]`; `READ-ONLY OK: True`.

- [ ] **Step 5: Clean up the smoke-test meeting**

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path
load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
sb.table('meetings').delete().eq('title', 'SESSION SMOKE — delete me').execute()
print('cleaned up (messages + cards cascade)')
"
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/session-chat/index.ts
git commit -m "feat: add session-chat edge function handler"
```

---

### Task 4: Dashboard — session screen + entry from the approved pack

**Files:**
- Modify: `dashboard/src/lib/supabase.js` (session helpers)
- Create: `dashboard/src/components/MeetingSession.jsx`
- Modify: `dashboard/src/components/MeetingPack.jsx` (Start/Resume/View-transcript button)
- Modify: `dashboard/src/App.jsx` (session route)

**Interfaces:**
- Consumes: `getMeeting` (from the Prep half, already in `lib/supabase.js`); the `session-chat` function (Task 3); `session_messages` table (Task 1).
- Produces: helpers `getSessionMessages(meetingId)`, `startSession(meetingId)`, `sendSessionMessage(meetingId, text)`, `endSession(meetingId)`; a `/meetings/:id/session` route rendering `MeetingSession`.

- [ ] **Step 1: Add session helpers to `lib/supabase.js`**

Append to `dashboard/src/lib/supabase.js`:

```javascript
// ── Companion session helpers (Phase 3b) ──

export async function getSessionMessages(meetingId) {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('session_messages').select('id, role, content, seq')
    .eq('meeting_id', meetingId).order('seq', { ascending: true })
  if (error) throw error
  return data
}

async function invokeSessionChat(payload) {
  const { data, error } = await supabase.functions.invoke('session-chat', { body: payload })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data.reply
}

export async function startSession(meetingId) {
  if (isMockMode) throw new Error('startSession unavailable in mock mode')
  return invokeSessionChat({ meeting_id: meetingId, start: true })
}

export async function sendSessionMessage(meetingId, text) {
  if (isMockMode) throw new Error('sendSessionMessage unavailable in mock mode')
  return invokeSessionChat({ meeting_id: meetingId, message: text })
}

export async function endSession(meetingId) {
  if (isMockMode) return
  const { error } = await supabase.from('meetings').update({ status: 'complete' }).eq('id', meetingId)
  if (error) throw error
}
```

- [ ] **Step 2: Create `MeetingSession.jsx`**

Create `dashboard/src/components/MeetingSession.jsx`:

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getMeeting, getSessionMessages, startSession, sendSessionMessage, endSession } from '../lib/supabase.js'

export default function MeetingSession() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [meeting, setMeeting] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)
  const startedRef = useRef(false)

  const load = useCallback(async () => {
    const mtg = await getMeeting(id)
    setMeeting(mtg)
    setMessages(await getSessionMessages(id))
    return mtg
  }, [id])

  useEffect(() => {
    (async () => {
      try {
        const mtg = await load()
        // Auto-start the session on first entry from an approved pack.
        if (mtg?.status === 'approved' && !startedRef.current) {
          startedRef.current = true
          setBusy(true)
          await startSession(id)
          await load()
        }
      } catch (e) { setError(e.message) } finally { setBusy(false) }
    })()
  }, [id, load])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])

  const readOnly = meeting?.status === 'complete'

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true); setError(null)
    // Optimistically show the user's turn.
    setMessages((prev) => [...prev, { id: `tmp-${prev.length}`, role: 'user', content: text }])
    setInput('')
    try {
      await sendSessionMessage(id, text)
      await load()
    } catch (e) {
      setError(e.message)
      setInput(text) // restore so the user can resend
      setMessages((prev) => prev.filter((mm) => !String(mm.id).startsWith('tmp-')))
    } finally { setBusy(false) }
  }

  async function finish() {
    if (!confirm('End this session? You can review the transcript afterward; write-back comes in the next release.')) return
    await endSession(id)
    navigate(`/meetings/${id}`)
  }

  if (!meeting) return <div className="max-w-3xl mx-auto px-6 py-8 text-gray-500">Loading…</div>

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 flex flex-col h-full">
      <button onClick={() => navigate(`/meetings/${id}`)} className="text-sm text-gray-500 hover:underline mb-3 self-start">← Meeting</button>

      <details className="mb-4 p-3 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700">
        <summary className="font-medium cursor-pointer">{meeting.title}</summary>
        <p className="mt-2"><span className="font-medium">Agenda:</span> {meeting.agenda}</p>
        {meeting.prospective_result && <p><span className="font-medium">Desired result:</span> {meeting.prospective_result}</p>}
        {meeting.decision_questions?.length > 0 && (
          <ul className="list-decimal ml-5 mt-1">{meeting.decision_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        )}
      </details>

      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {messages.map((mm) => (
          <div key={mm.id} className={`flex ${mm.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${
              mm.role === 'user' ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-900'
            }`}>{mm.content}</div>
          </div>
        ))}
        {busy && <div className="text-xs text-gray-400 pl-1">companion is thinking…</div>}
        {error && <div className="text-xs text-red-600 pl-1">Couldn't reach the companion: {error}. Your message is restored — try again.</div>}
        <div ref={bottomRef} />
      </div>

      {readOnly ? (
        <div className="mt-2 text-sm text-gray-500 border-t border-gray-100 pt-3">
          Session complete — transcript is read-only. Write-back (turning this into decisions/hypotheses/questions) arrives in the next release.
        </div>
      ) : (
        <div className="mt-2 border-t border-gray-100 pt-3">
          <div className="flex gap-2">
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder="Make your case…" rows={2} disabled={busy}
              className="flex-1 px-3 py-2 rounded-lg border border-gray-300 text-sm resize-none disabled:opacity-50" />
            <button onClick={send} disabled={busy || !input.trim()}
              className="px-4 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50">Send</button>
          </div>
          <button onClick={finish} disabled={busy}
            className="mt-2 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50">End session</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add the entry button in `MeetingPack.jsx`**

In `dashboard/src/components/MeetingPack.jsx`, the action row currently shows Re-assemble + Approve. Add a session entry button that appears based on status. Import `useNavigate` is already present (the component uses it). Add this button into the action row (the `<div className="flex items-center gap-3 my-5">` block), after the Approve control:

```jsx
{meeting.status === 'approved' && (
  <button onClick={() => navigate(`/meetings/${id}/session`)}
    className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-sm hover:bg-violet-700">
    Start session
  </button>
)}
{meeting.status === 'in_session' && (
  <button onClick={() => navigate(`/meetings/${id}/session`)}
    className="px-4 py-1.5 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700">
    Resume session
  </button>
)}
{meeting.status === 'complete' && (
  <button onClick={() => navigate(`/meetings/${id}/session`)}
    className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-100">
    View transcript
  </button>
)}
```

- [ ] **Step 4: Wire the route in `App.jsx`**

Add the import (after the `MeetingPack` import from the Prep half):

```jsx
import MeetingSession from './components/MeetingSession.jsx'
```

Add the route next to the `/meetings/:id` route:

```jsx
<Route path="/meetings/:id/session" element={<MeetingSession />} />
```

- [ ] **Step 5: Build check**

Run: `cd dashboard && npm run build`
Expected: builds with no errors.

- [ ] **Step 6: Verify the full session loop end-to-end**

Run `cd dashboard && npm run dev`. In the app, on a meeting whose pack you've approved:
1. Click **Start session** → routes to the session view; within a few seconds the companion's opening provocation appears and the meeting badge becomes `in_session`.
2. Send a turn → the companion pushes back, arguing from the pack.
3. Navigate away and reopen the meeting → **Resume session** returns you to the full thread.
4. **End session** → returns to the meeting detail; the badge is `complete`; reopening shows **View transcript** (read-only, no input box).

Expected: every step behaves as described; no console errors.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/lib/supabase.js dashboard/src/components/MeetingSession.jsx dashboard/src/components/MeetingPack.jsx dashboard/src/App.jsx
git commit -m "feat: add companion session screen + entry from approved pack"
```

---

## After this plan lands

Update `knowledge-center-plan.md`'s Phase 3 entry: mark the session (3d's text stand-in) as implemented, and note that write-back (3e) is the remaining spec. The Capture half's write-back spec should be brainstormed only after this ships and a real session transcript exists — the `session_messages` transcript is the write-back extraction's input, and seeing a real one first is why the Capture half was split. Not a task here (documentation bookkeeping on a different file).
