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
