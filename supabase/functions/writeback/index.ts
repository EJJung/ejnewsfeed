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

  // A summary is singular per meeting. If one already survives (an edited or
  // committed summary), do NOT insert a fresh one — a duplicate would be
  // hidden in the UI and could nondeterministically overwrite the kept
  // summary at commit, silently discarding EJ's edit.
  const { data: existingSummary } = await supabase.from('writeback_proposals')
    .select('id').eq('meeting_id', meetingId).eq('kind', 'summary').limit(1)
  const toInsert = (existingSummary && existingSummary.length > 0)
    ? inputs.filter((p) => p.kind !== 'summary')
    : inputs

  if (toInsert.length) {
    const rows = toInsert.map((p) => ({
      meeting_id: meetingId, kind: p.kind, text: p.text, detail: p.detail, domains: p.domains, status: 'proposed',
    }))
    const { error } = await supabase.from('writeback_proposals').insert(rows)
    if (error) throw new Error(`Failed to insert proposals: ${error.message}`)
  }
  return { proposed: toInsert.length }
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
