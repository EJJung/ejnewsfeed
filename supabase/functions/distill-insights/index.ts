/**
 * distill-insights — Supabase Edge Function
 * ============================================
 * Daily: extracts 0-3 candidate insights per domain from that day's
 * top-impact_score articles.
 * Weekly: classifies the week's candidates against existing active
 * insights (promote / merge / contest / reject) and applies the result.
 *
 * POST /functions/v1/distill-insights
 * Body: { mode: 'daily' | 'weekly' }
 *
 * Schedule (pg_cron): daily 22:30 UTC, weekly Monday 13:00 UTC.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

// Domain slugs (generic, used by insights.domains) map to this project's
// existing categories.name values (see pipeline/audit_pipeline.py CATEGORIES).
const DOMAIN_TO_CATEGORY: Record<string, string> = {
  ai: 'AI',
  it: 'IT',
  entrepreneurship: 'Entrepreneurship',
  business: 'Business',
  ux: 'UX Design',
}
const DOMAINS = Object.keys(DOMAIN_TO_CATEGORY)

type Mode = 'daily' | 'weekly'

interface ArticleRow {
  id: string
  title: string
  snippet: string | null
  url: string | null
}

interface CandidateInsight {
  text: string
  confidence: number
  source_indices: number[]
}

// ── Alert helper (same pattern as process-emails) ───────────────────────────
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
        job: 'distill-insights',
        timestamp: new Date().toISOString(),
      }),
    })
  } catch { /* best-effort */ }
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { mode } = await req.json() as { mode: Mode }
  if (mode !== 'daily' && mode !== 'weekly') {
    return new Response(JSON.stringify({ ok: false, error: 'mode must be "daily" or "weekly"' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'distill-insights', status: 'running', metadata: { mode } })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  const work = (mode === 'daily' ? runDaily(supabase, anthropicKey) : runWeekly(supabase, anthropicKey))
    .then(async (domain_results) => {
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(),
          status: 'success',
          metadata: { mode, domain_results },
        }).eq('id', runId)
      }
      return { ok: true, mode, domain_results }
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('distill-insights fatal error:', err)
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(),
          status: 'error',
          error_message: msg,
          metadata: { mode },
        }).eq('id', runId)
      }
      await sendAlert(supabase, `distill-insights (${mode}) crashed: ${msg}`)
      return { ok: false, error: msg }
    })

  // @ts-ignore — Deno Deploy global
  if (typeof EdgeRuntime !== 'undefined') {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
    return new Response(
      JSON.stringify({ ok: true, message: `distill-insights (${mode}) started in background` }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  const result = await work
  return new Response(JSON.stringify(result), {
    status: (result as { ok: boolean }).ok === false ? 500 : 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})

// ── Daily mode ─────────────────────────────────────────────────────────────

async function runDaily(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
): Promise<Record<string, { candidates_created: number }>> {
  const todayISO = new Date().toISOString().slice(0, 10)

  const settled = await Promise.allSettled(
    DOMAINS.map(async (domain) => {
      const categoryName = DOMAIN_TO_CATEGORY[domain]

      const { data: articles } = await supabase
        .from('articles')
        .select('id, title, snippet, url')
        .contains('category_tags', [categoryName])
        .gte('published_at', `${todayISO}T00:00:00.000Z`)
        .lte('published_at', `${todayISO}T23:59:59.999Z`)
        .order('impact_score', { ascending: false, nullsFirst: false })
        .limit(8)

      const rows = (articles || []) as ArticleRow[]
      if (!rows.length) return { domain, candidates_created: 0 }

      const candidates = await extractCandidateInsights(anthropicKey, categoryName, rows)

      let created = 0
      for (const c of candidates) {
        const { data: inserted, error } = await supabase.from('insights').insert({
          text: c.text,
          domains: [domain],
          confidence: c.confidence,
          status: 'candidate',
          first_seen_at: todayISO,
        }).select('id').single()

        if (error || !inserted) {
          console.error(`  ✗ Failed to insert candidate insight for ${domain}:`, error?.message)
          continue
        }

        const sourceRows = c.source_indices
          .map((i) => rows[i - 1])
          .filter((a): a is ArticleRow => Boolean(a))
          .map((a) => ({ insight_id: (inserted as { id: string }).id, article_id: a.id, relation: 'supporting' }))

        if (sourceRows.length) {
          const { error: sourcesError } = await supabase.from('insight_sources').insert(sourceRows)
          if (sourcesError) {
            console.error(`  ✗ Failed to insert insight_sources for insight ${(inserted as { id: string }).id} (${domain}):`, sourcesError.message)
          }
        }
        created++
      }

      console.log(`  ✓ ${domain}: ${created} candidate insight(s) from ${rows.length} articles`)
      return { domain, candidates_created: created }
    }),
  )

  const results: Record<string, { candidates_created: number }> = {}
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') {
      results[s.value.domain] = { candidates_created: s.value.candidates_created }
    } else {
      console.error(`  ✗ Error processing domain ${DOMAINS[i]}: ${s.reason}`)
      results[DOMAINS[i]] = { candidates_created: 0 }
    }
  }
  return results
}

async function extractCandidateInsights(
  apiKey: string,
  categoryName: string,
  articles: ArticleRow[],
): Promise<CandidateInsight[]> {
  const articleList = articles
    .map((a, i) => `${i + 1}. ${a.title}${a.snippet ? ': ' + a.snippet : ''}`)
    .join('\n')

  const prompt = `You are analyzing today's top ${categoryName} articles to extract durable, non-obvious insights for a knowledge base.

Articles:
${articleList}

Extract 0-3 candidate insights — durable claims or findings worth remembering weeks from now, not restatements of a single headline. Skip routine news with no lasting signal; it's fine to return an empty array.

Return ONLY a JSON array, each item:
{
  "text": string — one clear sentence stating the claim,
  "confidence": number 0.0-1.0 — how well-supported this claim is by the given articles,
  "source_indices": number[] — 1-based indices into the article list above that support this claim
}
No markdown, no explanation — raw JSON only.`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Claude API error ${res.status}: ${errBody}`)
  }

  const data = await res.json()
  const rawText = (data.content?.[0]?.text || '').trim()

  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const parsed = JSON.parse(cleaned)
    const rawCandidates: unknown[] = Array.isArray(parsed) ? parsed : []

    let dropped = 0
    const validated: CandidateInsight[] = []
    for (const c of rawCandidates.slice(0, 3)) {
      const item = c as Partial<CandidateInsight> | null | undefined
      const text = item?.text
      const confidence = item?.confidence

      if (typeof text !== 'string' || !text.trim() || typeof confidence !== 'number' || !Number.isFinite(confidence)) {
        dropped++
        continue
      }

      validated.push({
        text,
        confidence: Math.min(Math.max(confidence, 0), 1),
        source_indices: Array.isArray(item?.source_indices) ? item.source_indices : [],
      })
    }

    if (dropped > 0) {
      console.error(`Dropped ${dropped} candidate insight(s) with invalid shape from Claude response`)
    }

    return validated
  } catch {
    console.error('Failed to parse Claude extraction JSON:', rawText.slice(0, 300))
    return []
  }
}

// ── Weekly mode (Task 3) ─────────────────────────────────────────────────────

async function runWeekly(
  _supabase: ReturnType<typeof createClient>,
  _anthropicKey: string,
): Promise<Record<string, unknown>> {
  throw new Error('weekly mode not implemented yet')
}
