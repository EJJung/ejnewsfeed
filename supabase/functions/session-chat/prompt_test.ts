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
