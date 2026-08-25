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
