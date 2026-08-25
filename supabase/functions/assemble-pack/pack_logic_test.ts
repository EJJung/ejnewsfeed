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
