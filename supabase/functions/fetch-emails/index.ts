/**
 * fetch-emails — Supabase Edge Function
 * ======================================
 * Connects to ej.newsfeed@gmail.com via Gmail API, pulls unread inbox
 * messages, and saves them as raw_emails rows in Supabase.
 *
 * Triggered by pg_cron at 7:00am UTC Mon–Fri (adjust for your timezone).
 * Can also be invoked manually via HTTP POST.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getAccessToken,
  extractEmailContent,
  getHeader,
} from '../_shared/gmail.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

// ── Alert helper ───────────────────────────────────────────────────────────
// Posts a JSON payload to the configured alert_webhook_url (if set).
// Best-effort: never throws, never blocks the main flow.
async function sendAlert(supabase: ReturnType<typeof createClient>, message: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('_pipeline_config')
      .select('value')
      .eq('key', 'alert_webhook_url')
      .maybeSingle()
    const url = (data as { value?: string } | null)?.value?.trim()
    if (!url) return
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '🚨 EJ Newsfeed Pipeline Error',
        message,
        job: 'fetch-emails',
        timestamp: new Date().toISOString(),
      }),
    })
  } catch { /* best-effort — never block the main response */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── Open a pipeline_runs record ────────────────────────────────────────
  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'fetch-emails', status: 'running' })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  const finishRun = async (patch: Record<string, unknown>) => {
    if (!runId) return
    await supabase
      .from('pipeline_runs')
      .update({ completed_at: new Date().toISOString(), ...patch })
      .eq('id', runId)
  }

  try {
    // ── 1. Get fresh Gmail access token ─────────────────────────────────
    let accessToken: string
    try {
      accessToken = await getAccessToken(
        Deno.env.get('GMAIL_CLIENT_ID')!,
        Deno.env.get('GMAIL_CLIENT_SECRET')!,
        Deno.env.get('GMAIL_REFRESH_TOKEN')!,
      )
    } catch (tokenErr) {
      const msg = `Gmail OAuth token refresh failed: ${String(tokenErr)}. ` +
        `Check GMAIL_REFRESH_TOKEN in Supabase Edge Function secrets — ` +
        `it may have been revoked and needs to be regenerated.`
      console.error(msg)
      await finishRun({ status: 'error', error_message: msg })
      await sendAlert(supabase, msg)
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const authHeader = { Authorization: `Bearer ${accessToken}` }

    // ── 2. List inbox messages with a day-aware window ────────────────────
    // Monday uses 4d to catch emails that arrived over the weekend (Sat/Sun).
    // Other weekdays use 2d as a buffer in case yesterday's run was missed.
    // Deduplication via gmail_message_id uniqueness prevents re-saving emails
    // that were already fetched in a previous run.
    //
    // Optional POST body overrides:
    //   daysBack  — integer, overrides the day-of-week window
    //   query     — string, fully overrides the Gmail q= parameter
    //               e.g. "in:inbox after:2026/05/12 before:2026/05/14"
    //   maxResults — integer (1–500), overrides the default 50
    let bodyDaysBack: number | null = null
    let bodyQuery: string | null = null
    let bodyMaxResults: number | null = null
    try {
      const body = await req.json()
      if (typeof body?.daysBack === 'number' && body.daysBack > 0) bodyDaysBack = body.daysBack
      if (typeof body?.query === 'string' && body.query.trim()) bodyQuery = body.query.trim()
      if (typeof body?.maxResults === 'number' && body.maxResults > 0) bodyMaxResults = Math.min(body.maxResults, 500)
    } catch { /* empty body or non-JSON — ignore */ }

    const dayOfWeek = new Date().getDay() // 0=Sun, 1=Mon, ..., 6=Sat
    const daysBack = bodyDaysBack ?? (dayOfWeek === 1 ? 4 : 2)
    const maxResults = bodyMaxResults ?? 50
    const gmailQuery = bodyQuery ?? `in:inbox+newer_than:${daysBack}d`

    const listRes = await fetch(
      `${GMAIL_BASE}/messages?q=${encodeURIComponent(gmailQuery)}&maxResults=${maxResults}`,
      { headers: authHeader },
    )
    const listData = await listRes.json()
    const messages: { id: string }[] = listData.messages || []

    console.log(`Found ${messages.length} inbox message(s) (query: "${gmailQuery}", maxResults: ${maxResults}).`)

    let savedCount = 0
    let skippedCount = 0

    for (const { id: messageId } of messages) {
      // Skip if already stored
      const { data: existing } = await supabase
        .from('raw_emails')
        .select('id')
        .eq('gmail_message_id', messageId)
        .maybeSingle()

      if (existing) { skippedCount++; continue }

      // Fetch full message
      const msgRes = await fetch(
        `${GMAIL_BASE}/messages/${messageId}?format=full`,
        { headers: authHeader },
      )
      const message = await msgRes.json()

      const sender  = getHeader(message, 'from')
      const subject = getHeader(message, 'subject') || '(no subject)'
      const dateStr = getHeader(message, 'date')
      const { html, text } = extractEmailContent(message.payload as Record<string, unknown>)

      let receivedAt: string
      try { receivedAt = new Date(dateStr).toISOString() }
      catch { receivedAt = new Date().toISOString() }

      // Auto-detect sender email & name
      const senderEmail = sender.includes('<')
        ? sender.split('<')[1]?.replace('>', '').trim().toLowerCase()
        : sender.trim().toLowerCase()
      const senderName = sender.includes('<')
        ? sender.split('<')[0].trim().replace(/"/g, '')
        : senderEmail

      // Look up or create source record
      let sourceId: string | null = null
      const { data: existingSource } = await supabase
        .from('sources')
        .select('id')
        .eq('email_address', senderEmail)
        .maybeSingle()

      if (existingSource) {
        sourceId = existingSource.id
      } else {
        const { data: newSource } = await supabase
          .from('sources')
          .insert({ name: senderName, email_address: senderEmail })
          .select('id')
          .single()
        sourceId = newSource?.id ?? null
      }

      // Store raw email
      await supabase.from('raw_emails').insert({
        gmail_message_id: messageId,
        source_id:        sourceId,
        subject,
        sender,
        received_at:  receivedAt,
        raw_html:     html || null,
        raw_text:     text || null,
        processed:    false,
      })

      savedCount++
      console.log(`  ✓ Saved: ${subject.slice(0, 60)}`)
    }

    const result = { ok: true, saved: savedCount, skipped: skippedCount, total: messages.length }
    console.log('fetch-emails complete:', result)

    await finishRun({
      status: 'success',
      emails_fetched: savedCount,
      emails_skipped: skippedCount,
      metadata: { total_inbox: messages.length, query: gmailQuery },
    })

    return new Response(JSON.stringify(result), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const errMsg = String(err)
    console.error('fetch-emails error:', err)
    await finishRun({ status: 'error', error_message: errMsg })
    await sendAlert(supabase, `Unexpected fetch-emails error: ${errMsg}`)
    return new Response(JSON.stringify({ ok: false, error: errMsg }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
