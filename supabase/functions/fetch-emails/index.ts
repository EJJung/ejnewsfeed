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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── 1. Get fresh Gmail access token ───────────────────────────────────
    const accessToken = await getAccessToken(
      Deno.env.get('GMAIL_CLIENT_ID')!,
      Deno.env.get('GMAIL_CLIENT_SECRET')!,
      Deno.env.get('GMAIL_REFRESH_TOKEN')!,
    )

    const authHeader = { Authorization: `Bearer ${accessToken}` }

    // ── 2. List inbox messages with a day-aware window ────────────────────
    // Monday uses 4d to catch emails that arrived over the weekend (Sat/Sun).
    // Other weekdays use 2d as a buffer in case yesterday's run was missed.
    // Deduplication via gmail_message_id uniqueness prevents re-saving emails
    // that were already fetched in a previous run.
    const dayOfWeek = new Date().getDay() // 0=Sun, 1=Mon, ..., 6=Sat
    const daysBack = dayOfWeek === 1 ? 4 : 2
    const listRes = await fetch(
      `${GMAIL_BASE}/messages?q=in:inbox+newer_than:${daysBack}d&maxResults=50`,
      { headers: authHeader },
    )
    const listData = await listRes.json()
    const messages: { id: string }[] = listData.messages || []

    console.log(`Found ${messages.length} inbox message(s) (window: ${daysBack}d, day: ${dayOfWeek}).`)

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

    return new Response(JSON.stringify(result), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('fetch-emails error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
