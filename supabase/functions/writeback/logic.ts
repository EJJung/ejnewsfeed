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
