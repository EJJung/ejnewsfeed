/**
 * generate-trends — Supabase Edge Function
 * ==========================================
 * Generates weekly / monthly / quarterly / yearly trend summaries
 * by synthesizing lower-level summaries via Claude.
 *
 * POST /functions/v1/generate-trends
 * Body: { periodType: 'weekly' | 'monthly' | 'quarterly' | 'yearly' }
 *
 * Schedule (pg_cron):
 *   weekly    — every Monday    7:30am ET = 12:30 UTC
 *   monthly   — 1st of month    7:30am ET = 12:30 UTC
 *   quarterly — Jan/Apr/Jul/Oct 7:30am ET = 12:30 UTC
 *   yearly    — Jan 1st         7:30am ET = 12:30 UTC
 *
 * Also handles cleanup of expired summaries (per retention policy).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

type PeriodType = 'weekly' | 'monthly' | 'quarterly' | 'yearly'

interface PeriodInfo {
  label: string        // '2026-W11', '2026-03', '2026-Q1', '2026'
  start: string        // ISO date string
  end: string          // ISO date string
}

interface Category {
  id: string
  name: string
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { periodType } = await req.json() as { periodType: PeriodType }

    if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(periodType)) {
      return new Response(JSON.stringify({ error: 'Invalid periodType' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

    // @ts-ignore
    const work = processAndCleanup(supabase, anthropicKey, periodType)
    // @ts-ignore
    if (typeof EdgeRuntime !== 'undefined') {
      // @ts-ignore
      EdgeRuntime.waitUntil(work)
      return new Response(
        JSON.stringify({ ok: true, message: `${periodType} trends generation started` }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const result = await work
    return new Response(JSON.stringify(result), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('generate-trends error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})

// ── Core logic ─────────────────────────────────────────────────────────────

async function processAndCleanup(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  periodType: PeriodType,
) {
  const period = getPreviousPeriod(periodType)
  console.log(`Generating ${periodType} trend for ${period.label} (${period.start} → ${period.end})`)

  // Load categories
  const { data: categories } = await supabase
    .from('categories')
    .select('id, name')

  if (!categories?.length) throw new Error('No categories found')

  let generated = 0

  for (const category of categories as Category[]) {
    // Skip if already generated (idempotent)
    const { data: existing } = await supabase
      .from('trend_summaries')
      .select('id')
      .eq('period_type', periodType)
      .eq('period_label', period.label)
      .eq('category_id', category.id)
      .single()

    if (existing) {
      console.log(`  ↷ Already exists: ${category.name} ${period.label}`)
      continue
    }

    // Fetch source summaries
    const sourceSummaries = await fetchSourceSummaries(supabase, periodType, period, category.id)

    if (!sourceSummaries.length) {
      console.log(`  – No source data for ${category.name} ${period.label}, skipping`)
      continue
    }

    const totalArticles = sourceSummaries.reduce((sum, s) => sum + (s.article_count || 0), 0)

    // Generate trend narrative via Claude
    const { summary, key_themes } = await generateTrendNarrative(
      anthropicKey,
      periodType,
      period,
      category.name,
      sourceSummaries,
      totalArticles,
    )

    // Save to trend_summaries
    const { error } = await supabase.from('trend_summaries').insert({
      period_type:   periodType,
      period_label:  period.label,
      period_start:  period.start,
      period_end:    period.end,
      category_id:   category.id,
      summary,
      article_count: totalArticles,
      key_themes,
      generated_at:  new Date().toISOString(),
    })

    if (error) {
      console.error(`  ✗ Failed to save ${category.name} ${period.label}: ${error.message}`)
    } else {
      generated++
      console.log(`  ✓ ${category.name} ${period.label}: ${totalArticles} articles, ${sourceSummaries.length} sources`)
    }
  }

  // Run retention cleanup
  const deleted = await runCleanup(supabase, periodType)

  return { ok: true, period: period.label, generated, deleted }
}

// ── Fetch source summaries ─────────────────────────────────────────────────

async function fetchSourceSummaries(
  supabase: ReturnType<typeof createClient>,
  periodType: PeriodType,
  period: PeriodInfo,
  categoryId: string,
): Promise<{ label: string; summary: string; article_count: number }[]> {
  if (periodType === 'weekly') {
    // Fetch daily_summaries for Mon–Fri of this week
    const { data } = await supabase
      .from('daily_summaries')
      .select('date, summary, article_count')
      .eq('category_id', categoryId)
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date', { ascending: true })
    return (data || []).map(r => ({
      label: r.date,
      summary: r.summary,
      article_count: r.article_count || 0,
    }))
  } else {
    // Fetch lower-level trend_summaries
    const sourceType: PeriodType = periodType === 'monthly'
      ? 'weekly'
      : periodType === 'quarterly'
        ? 'monthly'
        : 'quarterly'

    const { data } = await supabase
      .from('trend_summaries')
      .select('period_label, summary, article_count')
      .eq('period_type', sourceType)
      .eq('category_id', categoryId)
      .gte('period_start', period.start)
      .lte('period_end', period.end)
      .order('period_start', { ascending: true })
    return (data || []).map(r => ({
      label: r.period_label,
      summary: r.summary,
      article_count: r.article_count || 0,
    }))
  }
}

// ── Claude trend narrative ─────────────────────────────────────────────────

async function generateTrendNarrative(
  apiKey: string,
  periodType: PeriodType,
  period: PeriodInfo,
  categoryName: string,
  sources: { label: string; summary: string; article_count: number }[],
  totalArticles: number,
): Promise<{ summary: string; key_themes: string[] }> {
  const periodLabel = {
    weekly:    'week',
    monthly:   'month',
    quarterly: 'quarter',
    yearly:    'year',
  }[periodType]

  const sourceBlock = sources
    .map(s => `[${s.label}] (${s.article_count} articles)\n${s.summary}`)
    .join('\n\n')

  const prompt = `You are an analyst writing a trend summary for a professional who tracks ${categoryName}.

Synthesize the following ${periodLabel} of ${categoryName} coverage into a trend narrative.
Period: ${period.start} to ${period.end} (${period.label})
Total articles: ${totalArticles}

Source summaries:
<sources>
${sourceBlock}
</sources>

Return ONLY a JSON object with these fields:
{
  "summary": "string — 3-4 sentences. Identify the dominant trend(s), how thinking evolved across the period, and what it signals for the near future. Be specific and analytical, not just descriptive.",
  "key_themes": ["theme 1", "theme 2", "theme 3"]
}

Rules:
- summary: flowing prose, no bullet points, 80-120 words
- key_themes: 3-5 short phrases (2-5 words each) capturing the main recurring topics
- No markdown, no code fences — raw JSON only`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Claude API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  const raw = (data.content?.[0]?.text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    return JSON.parse(raw)
  } catch {
    // Fallback if Claude returns bad JSON
    return {
      summary: raw.slice(0, 500),
      key_themes: [],
    }
  }
}

// ── Retention cleanup ──────────────────────────────────────────────────────

async function runCleanup(
  supabase: ReturnType<typeof createClient>,
  periodType: PeriodType,
): Promise<number> {
  // Retention: weekly=52w, monthly=24mo, quarterly=36mo, yearly=never
  const cutoffMap: Partial<Record<PeriodType, string>> = {
    weekly:    new Date(Date.now() - 52 * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    monthly:   subtractMonths(new Date(), 24).toISOString().slice(0, 10),
    quarterly: subtractMonths(new Date(), 36).toISOString().slice(0, 10),
  }

  const cutoff = cutoffMap[periodType]
  if (!cutoff) return 0  // yearly: never delete

  const { data, error } = await supabase
    .from('trend_summaries')
    .delete()
    .eq('period_type', periodType)
    .lt('period_end', cutoff)
    .select('id')

  if (error) {
    console.error(`Cleanup error for ${periodType}:`, error.message)
    return 0
  }

  const count = data?.length || 0
  if (count > 0) console.log(`  🗑 Cleaned up ${count} expired ${periodType} summaries`)
  return count
}

// ── Period calculation ─────────────────────────────────────────────────────

/** Returns the most recently COMPLETED period before today */
function getPreviousPeriod(type: PeriodType): PeriodInfo {
  const now = new Date()

  if (type === 'weekly') {
    // Last Mon–Fri (triggered on Monday, so "previous" = last week)
    const dayOfWeek = now.getDay() // 0=Sun, 1=Mon...
    const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
    const lastMonday = new Date(now)
    lastMonday.setDate(now.getDate() - daysToLastMonday - 7)
    const lastFriday = new Date(lastMonday)
    lastFriday.setDate(lastMonday.getDate() + 4)
    const weekNum = getISOWeek(lastMonday)
    return {
      label: `${lastMonday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`,
      start: toDateStr(lastMonday),
      end:   toDateStr(lastFriday),
    }
  }

  if (type === 'monthly') {
    // Last complete month (triggered on 1st)
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 0)
    return {
      label: `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`,
      start: toDateStr(lastMonth),
      end:   toDateStr(lastDayOfMonth),
    }
  }

  if (type === 'quarterly') {
    // Last complete quarter
    const month = now.getMonth() // 0-indexed
    const currentQ = Math.floor(month / 3) + 1
    const prevQ = currentQ === 1 ? 4 : currentQ - 1
    const prevQYear = currentQ === 1 ? now.getFullYear() - 1 : now.getFullYear()
    const qStartMonth = (prevQ - 1) * 3
    const qStart = new Date(prevQYear, qStartMonth, 1)
    const qEnd   = new Date(prevQYear, qStartMonth + 3, 0)
    return {
      label: `${prevQYear}-Q${prevQ}`,
      start: toDateStr(qStart),
      end:   toDateStr(qEnd),
    }
  }

  // yearly — last complete year (triggered Jan 1)
  const prevYear = now.getFullYear() - 1
  return {
    label: String(prevYear),
    start: `${prevYear}-01-01`,
    end:   `${prevYear}-12-31`,
  }
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function subtractMonths(d: Date, months: number): Date {
  const result = new Date(d)
  result.setMonth(result.getMonth() - months)
  return result
}

/** ISO 8601 week number */
function getISOWeek(d: Date): number {
  const date = new Date(d)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7)
  const week1 = new Date(date.getFullYear(), 0, 4)
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7)
}
