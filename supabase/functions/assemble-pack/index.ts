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
  type HydratedRow, type CardInput, type RefTable,
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

  // Dedup against sourced cards that survived the idempotency delete (i.e.
  // edited cards, edited=true). Without this, re-selecting the same insight
  // would insert a pristine twin alongside the user's edited card, and there
  // is no delete-card UI to remove it. Manual cards have a null ref_id and
  // are not matched here.
  const { data: surviving } = await supabase
    .from('context_cards')
    .select('ref_table, ref_id')
    .eq('meeting_id', meetingId)
    .not('ref_id', 'is', null)
  const survivingKeys = new Set(
    ((surviving || []) as { ref_table: string; ref_id: string }[])
      .map((s) => hydrationKey(s.ref_table as RefTable, s.ref_id)),
  )
  const freshCards = cards.filter((c) => !survivingKeys.has(hydrationKey(c.ref_table, c.ref_id)))

  if (freshCards.length) {
    const rows = freshCards.map((c: CardInput) => ({ ...c, meeting_id: meetingId, included: true }))
    const { error: insErr } = await supabase.from('context_cards').insert(rows)
    if (insErr) throw new Error(`Failed to insert context_cards: ${insErr.message}`)
  }

  await supabase.from('meetings').update({ status: 'pack_ready' }).eq('id', meetingId)
  return { card_count: freshCards.length }
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
