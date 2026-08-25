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
