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
