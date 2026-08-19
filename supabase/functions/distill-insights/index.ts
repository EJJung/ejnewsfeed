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
import { sendAlert } from '../_shared/alert.ts'

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

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  let mode: Mode
  try {
    const body = await req.json()
    mode = body.mode
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
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
      await sendAlert(supabase, 'distill-insights', `distill-insights (${mode}) crashed: ${msg}`)
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
    for (const c of rawCandidates) {
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

    return validated.slice(0, 3)
  } catch {
    console.error('Failed to parse Claude extraction JSON:', rawText.slice(0, 300))
    return []
  }
}

// ── Weekly mode ──────────────────────────────────────────────────────────

interface WeeklyDecision {
  promote: string[]
  merge: { candidate_id: string; into_insight_id: string }[]
  contest: { candidate_id: string; conflicts_with_insight_id: string }[]
  reject: string[]
}

interface InsightRow {
  id: string
  text: string
  status: string
  confidence?: number
}

async function runWeekly(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
): Promise<Record<string, { promoted: number; merged: number; contested: number; rejected: number }>> {
  const todayISO = new Date().toISOString().slice(0, 10)

  // NOTE: domains are processed concurrently below. This is safe today because
  // runDaily only ever writes single-element `domains` arrays (an insight
  // belongs to exactly one domain at creation time), so no two concurrent
  // domain branches touch the same insight row. The schema allows multi-domain
  // insights (`domains TEXT[]`); if a future phase ever creates one, revisit
  // this concurrency model (e.g. serialize or lock per-insight) to avoid two
  // domain branches racing to update the same row in one run.
  const settled = await Promise.allSettled(
    DOMAINS.map(async (domain) => {
      const categoryName = DOMAIN_TO_CATEGORY[domain]

      // No time-window filter here: any status='candidate' row is fair game,
      // so a skipped weekly run never orphans the prior week's candidates.
      // Capped and ordered oldest-first to bound prompt size and drain the
      // backlog in order, matching the `existing`-insights query's own cap.
      const { data: candidateRows } = await supabase
        .from('insights')
        .select('id, text, status, confidence')
        .eq('status', 'candidate')
        .contains('domains', [domain])
        .order('first_seen_at', { ascending: true })
        .limit(50)

      const candidates = (candidateRows || []) as InsightRow[]
      if (!candidates.length) return { domain, promoted: 0, merged: 0, contested: 0, rejected: 0 }

      const { data: existingRows } = await supabase
        .from('insights')
        .select('id, text, status')
        .in('status', ['active', 'contested'])
        .contains('domains', [domain])
        .order('created_at', { ascending: false })
        .limit(50)

      const existing = (existingRows || []) as InsightRow[]

      const decision = await classifyCandidates(anthropicKey, categoryName, candidates, existing)
      const counts = await applyWeeklyDecision(supabase, decision, todayISO, existing)
      console.log(`  ✓ ${domain}: promoted=${counts.promoted} merged=${counts.merged} contested=${counts.contested} rejected=${counts.rejected}`)
      return { domain, ...counts }
    }),
  )

  const results: Record<string, { promoted: number; merged: number; contested: number; rejected: number }> = {}
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') {
      results[s.value.domain] = { promoted: s.value.promoted, merged: s.value.merged, contested: s.value.contested, rejected: s.value.rejected }
    } else {
      console.error(`  ✗ Error processing domain ${DOMAINS[i]}: ${s.reason}`)
      results[DOMAINS[i]] = { promoted: 0, merged: 0, contested: 0, rejected: 0 }
    }
  }
  return results
}

async function classifyCandidates(
  apiKey: string,
  categoryName: string,
  candidates: InsightRow[],
  existing: InsightRow[],
): Promise<WeeklyDecision> {
  const existingBlock = existing.length
    ? existing.map((e) => `[${e.id}] (${e.status}) ${e.text}`).join('\n')
    : '(none yet)'
  const candidateBlock = candidates
    .map((c) => `[${c.id}] ${c.text} (confidence ${c.confidence ?? 'n/a'})`)
    .join('\n')

  const prompt = `You are curating a knowledge base of durable insights for ${categoryName}. Compare this week's newly extracted candidate insights against the currently active/contested insights, and classify each candidate.

Existing active/contested insights:
${existingBlock}

This week's candidates:
${candidateBlock}

For each candidate, decide exactly one:
- "promote": genuinely new, distinct, and well-supported enough to become an active insight
- "merge": restates or reinforces an existing insight — merge as additional evidence (needs into_insight_id from the existing list)
- "contest": conflicts with / contradicts an existing insight (needs conflicts_with_insight_id from the existing list)
- "reject": too weak, too narrow, or not durable enough to keep

Return ONLY a JSON object:
{
  "promote": ["candidate_id", ...],
  "merge": [{"candidate_id": "...", "into_insight_id": "..."}],
  "contest": [{"candidate_id": "...", "conflicts_with_insight_id": "..."}],
  "reject": ["candidate_id", ...]
}
Every candidate id must appear in exactly one bucket, using ids exactly as given in brackets above. No markdown, no explanation.`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
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
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const parsed = JSON.parse(cleaned) as Partial<WeeklyDecision>

  const decision: WeeklyDecision = {
    promote: parsed.promote || [],
    merge: parsed.merge || [],
    contest: parsed.contest || [],
    reject: parsed.reject || [],
  }

  // De-duplicate across buckets in case Claude puts the same candidate id in
  // more than one bucket. Priority order: promote > merge > contest > reject —
  // once an id is claimed by a higher-priority bucket, drop it from the rest,
  // so each candidate is processed (and counted) at most once.
  const seen = new Set<string>()
  for (const id of decision.promote) seen.add(id)
  decision.merge = decision.merge.filter((m) => {
    if (seen.has(m.candidate_id)) return false
    seen.add(m.candidate_id)
    return true
  })
  decision.contest = decision.contest.filter((c) => {
    if (seen.has(c.candidate_id)) return false
    seen.add(c.candidate_id)
    return true
  })
  decision.reject = decision.reject.filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })

  // Any candidate Claude didn't classify is treated as rejected, not silently dropped.
  const classifiedIds = new Set([
    ...decision.promote,
    ...decision.merge.map((m) => m.candidate_id),
    ...decision.contest.map((c) => c.candidate_id),
    ...decision.reject,
  ])
  for (const c of candidates) {
    if (!classifiedIds.has(c.id)) decision.reject.push(c.id)
  }

  return decision
}

async function applyWeeklyDecision(
  supabase: ReturnType<typeof createClient>,
  decision: WeeklyDecision,
  todayISO: string,
  existing: InsightRow[],
): Promise<{ promoted: number; merged: number; contested: number; rejected: number }> {
  let promoted = 0, merged = 0, contested = 0, rejected = 0
  const existingIds = new Set(existing.map((e) => e.id))
  const invalidTargetRejects: string[] = []

  if (decision.promote.length) {
    const { error } = await supabase.from('insights').update({ status: 'active', updated_at: new Date().toISOString() }).in('id', decision.promote)
    if (!error) promoted = decision.promote.length
  }

  for (const { candidate_id, into_insight_id } of decision.merge) {
    if (!existingIds.has(into_insight_id)) {
      console.error(`  ✗ merge: candidate ${candidate_id} references invalid/hallucinated into_insight_id ${into_insight_id} (not among existing insights shown to Claude); rejecting candidate instead`)
      invalidTargetRejects.push(candidate_id)
      continue
    }

    const { data: sources } = await supabase.from('insight_sources').select('article_id, relation').eq('insight_id', candidate_id)
    for (const src of (sources || []) as { article_id: string; relation: string }[]) {
      await supabase.from('insight_sources').upsert(
        { insight_id: into_insight_id, article_id: src.article_id, relation: 'supporting' },
        { onConflict: 'insight_id,article_id' },
      )
    }
    const { error: candidateError } = await supabase.from('insights').update({ status: 'superseded', superseded_by: into_insight_id, updated_at: new Date().toISOString() }).eq('id', candidate_id)
    const { error: targetError } = await supabase.from('insights').update({ last_confirmed_at: todayISO, updated_at: new Date().toISOString() }).eq('id', into_insight_id)

    if (candidateError || targetError) {
      console.error(`  ✗ merge: update failed for candidate ${candidate_id} -> into ${into_insight_id}:`, candidateError?.message, targetError?.message)
      continue
    }
    merged++
  }

  for (const { candidate_id, conflicts_with_insight_id } of decision.contest) {
    if (!existingIds.has(conflicts_with_insight_id)) {
      console.error(`  ✗ contest: candidate ${candidate_id} references invalid/hallucinated conflicts_with_insight_id ${conflicts_with_insight_id} (not among existing insights shown to Claude); rejecting candidate instead`)
      invalidTargetRejects.push(candidate_id)
      continue
    }

    const { data: sources } = await supabase.from('insight_sources').select('article_id').eq('insight_id', candidate_id)
    for (const src of (sources || []) as { article_id: string }[]) {
      await supabase.from('insight_sources').upsert(
        { insight_id: conflicts_with_insight_id, article_id: src.article_id, relation: 'contradicting' },
        { onConflict: 'insight_id,article_id' },
      )
    }
    const { error: targetError } = await supabase.from('insights').update({ status: 'contested', updated_at: new Date().toISOString() }).eq('id', conflicts_with_insight_id)
    const { error: candidateError } = await supabase.from('insights').update({ status: 'superseded', superseded_by: conflicts_with_insight_id, updated_at: new Date().toISOString() }).eq('id', candidate_id)

    if (targetError || candidateError) {
      console.error(`  ✗ contest: update failed for candidate ${candidate_id} vs ${conflicts_with_insight_id}:`, targetError?.message, candidateError?.message)
      continue
    }
    contested++
  }

  const rejectIds = [...decision.reject, ...invalidTargetRejects]
  if (rejectIds.length) {
    const { error } = await supabase.from('insights').update({ status: 'rejected', updated_at: new Date().toISOString() }).in('id', rejectIds)
    if (!error) rejected = decision.reject.length + invalidTargetRejects.length
  }

  return { promoted, merged, contested, rejected }
}
