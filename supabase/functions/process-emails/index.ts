/**
 * process-emails — Supabase Edge Function
 * =========================================
 * Reads unprocessed raw_emails rows, calls Claude to extract articles
 * and categorize them, saves to articles table, then generates
 * daily_summaries per category.
 *
 * Triggered by pg_cron at 14:10 UTC daily (10 minutes after fetch-emails).
 * Can also be invoked manually via HTTP POST.
 *
 * Uses EdgeRuntime.waitUntil() so the HTTP response returns quickly
 * while heavy Claude processing continues in the background.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { htmlToText } from '../_shared/gmail.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

// ── Alert helper ───────────────────────────────────────────────────────────
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
        job: 'process-emails',
        timestamp: new Date().toISOString(),
      }),
    })
  } catch { /* best-effort */ }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface Category {
  id: string
  name: string
  description: string | null
  color: string
}

interface RawEmail {
  id: string
  subject: string
  sender: string
  source_id: string | null
  received_at: string
  raw_html: string | null
  raw_text: string | null
}

interface ExtractedArticle {
  title: string
  url: string | null
  snippet: string
  category: string
  category_tags: string[]
  relevance_score: number
  signal_keywords_score: number
  published_at: string | null
}

interface ScoredArticle extends ExtractedArticle {
  _source_id: string | null
  _impact_score: number
}

// ── Impact scoring ─────────────────────────────────────────────────────────

// Signal weights — must sum to 1.0
const WEIGHTS = {
  source_authority:    0.25,
  story_reach:         0.20,
  signal_keywords:     0.20,
  cross_category:      0.15,
  personal_engagement: 0.20,
} as const

const TIER_SCORES: Record<string, number> = { A: 1.0, B: 0.6, C: 0.3 }

const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'in', 'of', 'to', 'is', 'it',
  'for', 'on', 'at', 'by', 'with', 'how', 'why', 'what', 'this',
  'that', 'are', 'has', 'have', 'was', 'will', 'its', 'be', 'as',
  'from', 'but', 'not', 'new', 'your',
])

async function getSourceAuthorityScore(
  supabase: ReturnType<typeof createClient>,
  sourceId: string | null,
  cache: Map<string, string>,
): Promise<number> {
  if (!sourceId) return TIER_SCORES.C
  if (!cache.has(sourceId)) {
    const { data } = await supabase
      .from('sources')
      .select('tier')
      .eq('id', sourceId)
      .maybeSingle()
    cache.set(sourceId, (data as { tier?: string } | null)?.tier || 'C')
  }
  return TIER_SCORES[cache.get(sourceId)!] ?? TIER_SCORES.C
}

function titleKeywords(title: string): Set<string> {
  const words = (title.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
  return new Set(words.filter((w) => !TITLE_STOPWORDS.has(w)))
}

/**
 * For each article, count how many distinct sources cover an overlapping
 * story (2+ significant title keywords in common). Reach mapping:
 *   1 source → 0.2, 2 sources → 0.6, 3+ sources → 1.0
 */
function computeStoryReachScores(articles: ScoredArticle[]): number[] {
  const kwSets = articles.map((a) => titleKeywords(a.title || ''))
  const reach: number[] = []

  for (let i = 0; i < articles.length; i++) {
    if (kwSets[i].size === 0) {
      reach.push(0.2)
      continue
    }
    const matching = new Set<string>([articles[i]._source_id || `_self_${i}`])
    for (let j = 0; j < articles.length; j++) {
      if (i === j) continue
      let overlap = 0
      for (const w of kwSets[i]) {
        if (kwSets[j].has(w)) {
          overlap++
          if (overlap >= 2) break
        }
      }
      if (overlap >= 2) matching.add(articles[j]._source_id || `_other_${j}`)
    }
    const n = matching.size
    reach.push(n >= 3 ? 1.0 : n === 2 ? 0.6 : 0.2)
  }
  return reach
}

/**
 * Returns 0.1–1.0 based on EJ's historical high-signal actions
 * (read_full, saved, chat_started) for articles from this source.
 * Defaults to 0.5 until at least 10 interactions exist.
 */
async function getPersonalEngagementScore(
  supabase: ReturnType<typeof createClient>,
  sourceId: string | null,
): Promise<number> {
  if (!sourceId) return 0.5
  try {
    const { data } = await supabase
      .from('user_interactions')
      .select('action, article:articles!inner(source_id)')
      .eq('article.source_id', sourceId)
    const interactions = (data || []) as Array<{ action: string }>
    if (interactions.length < 10) return 0.5
    const highSignal = interactions.filter((i) =>
      i.action === 'read_full' || i.action === 'saved' || i.action === 'chat_started',
    ).length
    const ratio = Math.min(Math.max(highSignal / interactions.length, 0.1), 1.0)
    return Math.round(ratio * 1000) / 1000
  } catch {
    return 0.5
  }
}

function computeImpactScore(params: {
  signalKeywords: number
  sourceAuthority: number
  reach: number
  personal: number
  categoryTags: string[]
}): number {
  const { signalKeywords, sourceAuthority, reach, personal, categoryTags } = params
  const crossCat = categoryTags.length > 0
    ? Math.min((categoryTags.length - 1) / 2.0, 1.0)
    : 0.0
  const raw =
    WEIGHTS.source_authority    * sourceAuthority +
    WEIGHTS.story_reach         * reach +
    WEIGHTS.signal_keywords     * signalKeywords +
    WEIGHTS.cross_category      * crossCat +
    WEIGHTS.personal_engagement * personal
  return Math.round(Math.min(Math.max(raw, 0.0), 1.0) * 1000) / 1000
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

  // ── Open a pipeline_runs record ──────────────────────────────────────────
  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'process-emails', status: 'running' })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  // Kick off background work and return immediately
  const work = processAll(supabase, anthropicKey, runId)

  // @ts-ignore — Deno Deploy global
  if (typeof EdgeRuntime !== 'undefined') {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
    return new Response(
      JSON.stringify({ ok: true, message: 'Processing started in background' }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  // Local dev: await normally
  try {
    const result = await work
    return new Response(JSON.stringify(result), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('process-emails error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})

// ── Core processing logic ──────────────────────────────────────────────────

async function processAll(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  runId: string | null,
) {
  const finishRun = async (patch: Record<string, unknown>) => {
    if (!runId) return
    await supabase
      .from('pipeline_runs')
      .update({ completed_at: new Date().toISOString(), ...patch })
      .eq('id', runId)
  }
  // 1. Load all categories (we'll need them for ID lookup)
  const { data: categories, error: catErr } = await supabase
    .from('categories')
    .select('id, name, description, color')

  if (catErr || !categories?.length) {
    const msg = `Failed to load categories: ${catErr?.message ?? 'empty'}`
    await finishRun({ status: 'error', error_message: msg })
    await sendAlert(supabase, msg)
    throw new Error(msg)
  }

  const categoryList = categories as Category[]
  const categoryNames = categoryList.map((c) => c.name)

  // Compute today's date once — used for email scoping and summary generation
  const todayDate = new Date()
  const todayISO  = todayDate.toISOString().slice(0, 10)

  // 2. Fetch unprocessed emails received today (UTC 00:00–23:59)
  // Scoping to today ensures we never process stale backlog emails from previous
  // days and keeps each invocation's workload predictable (only today's newsletters).
  const todayStart = `${todayISO}T00:00:00.000Z`
  const todayEnd   = `${todayISO}T23:59:59.999Z`

  const { data: emails, error: emailErr } = await supabase
    .from('raw_emails')
    .select('id, subject, sender, source_id, received_at, raw_html, raw_text')
    .eq('processed', false)
    .gte('received_at', todayStart)
    .lte('received_at', todayEnd)
    .order('received_at', { ascending: true }) // oldest-first within today so earlier newsletters are processed first
    .limit(2) // process up to 2 per run — 5 was hitting the 150s EdgeRuntime timeout before articles could be saved

  if (emailErr) {
    const msg = `Failed to fetch raw_emails: ${emailErr.message}`
    await finishRun({ status: 'error', error_message: msg })
    await sendAlert(supabase, msg)
    throw new Error(msg)
  }

  const rawEmails = (emails || []) as RawEmail[]
  console.log(`Processing ${rawEmails.length} unprocessed email(s).`)

  let totalArticlesSaved = 0
  const processedEmailIds: string[] = []

  // Track all unique published dates encountered during this run.
  // Used to detect and backfill any recent dates that have articles but no summary.
  const affectedDates = new Set<string>()

  // ── Phase 1: Extract articles from every email ──────────────────────────
  // Collect everything before computing reach scores (which need the full set).
  const extractionResults: Array<{ articles: ScoredArticle[]; email: RawEmail }> = []

  for (const email of rawEmails) {
    try {
      const bodyText = email.raw_html
        ? htmlToText(email.raw_html)
        : (email.raw_text || '').slice(0, 12000).trim()

      if (!bodyText) {
        console.log(`  ⚠ Skipping empty email: ${email.subject?.slice(0, 60)}`)
        await supabase.from('raw_emails').update({ processed: true }).eq('id', email.id)
        continue
      }

      const extracted = await extractArticles(
        anthropicKey,
        email.subject,
        email.sender,
        bodyText,
        categoryNames,
      )

      if (!extracted.length) {
        console.log(`  – No articles found in: ${email.subject?.slice(0, 60)}`)
        await supabase.from('raw_emails').update({ processed: true }).eq('id', email.id)
        continue
      }

      const scored: ScoredArticle[] = extracted.map((a) => ({
        ...a,
        _source_id: email.source_id,
        _impact_score: 0.5,
      }))
      extractionResults.push({ articles: scored, email })
      console.log(
        `  → Extracted ${extracted.length} from: ${email.subject?.slice(0, 50)}`,
      )
    } catch (err) {
      console.error(`  ✗ Error extracting email ${email.id}: ${err}`)
    }
  }

  // ── Phase 2: Compute impact scores ──────────────────────────────────────
  const allArticles: ScoredArticle[] = extractionResults.flatMap((r) => r.articles)

  if (allArticles.length > 0) {
    console.log(`Scoring impact for ${allArticles.length} article(s)…`)
    const tierCache = new Map<string, string>()
    const reachScores = computeStoryReachScores(allArticles)

    // Memoize personal-engagement lookups by source_id within this run.
    const personalCache = new Map<string, number>()
    const getPersonal = async (sid: string | null): Promise<number> => {
      const key = sid || '__null__'
      if (!personalCache.has(key)) {
        personalCache.set(key, await getPersonalEngagementScore(supabase, sid))
      }
      return personalCache.get(key)!
    }

    for (let i = 0; i < allArticles.length; i++) {
      const art = allArticles[i]
      const authority = await getSourceAuthorityScore(supabase, art._source_id, tierCache)
      const personal  = await getPersonal(art._source_id)
      const keyword   = Number.isFinite(art.signal_keywords_score)
        ? Math.min(Math.max(art.signal_keywords_score, 0), 1)
        : 0.5
      const tags = (art.category_tags && art.category_tags.length)
        ? art.category_tags
        : (art.category ? [art.category] : [])

      art._impact_score = computeImpactScore({
        signalKeywords: keyword,
        sourceAuthority: authority,
        reach: reachScores[i],
        personal,
        categoryTags: tags,
      })
    }
  }

  // ── Phase 3: Save articles and mark emails processed ───────────────────
  for (const { articles, email } of extractionResults) {
    try {
      for (const article of articles) {
        const catId = resolveCategoryId(categoryList, article.category)
        const publishedAt = sanitisePublishedAt(article.published_at, email.received_at)
        const tags = (article.category_tags && article.category_tags.length)
          ? article.category_tags
          : [article.category]

        try {
          const { error: insertErr } = await supabase.from('articles').insert({
            raw_email_id:        email.id,
            source_id:           email.source_id,
            title:               article.title,
            url:                 article.url || null,
            snippet:             article.snippet,
            primary_category_id: catId,
            category_tags:       tags,
            relevance_score:     article.relevance_score,
            impact_score:        article._impact_score,
            published_at:        publishedAt,
          })

          if (insertErr) {
            console.error(`  ✗ Article insert failed for "${article.title}":`, JSON.stringify(insertErr))
          } else {
            totalArticlesSaved++
            affectedDates.add(publishedAt.slice(0, 10))
          }
        } catch (e) {
          console.error(`  ✗ Article insert exception for "${article.title}":`, (e as Error).message)
        }
      }

      await supabase.from('raw_emails').update({ processed: true }).eq('id', email.id)
      processedEmailIds.push(email.id)
      console.log(`  ✓ Saved ${articles.length} from: ${email.subject?.slice(0, 50)}`)
    } catch (err) {
      // Leave processed=false so it will retry next run
      console.error(`  ✗ Error saving email ${email.id}: ${err}`)
    }
  }

  // 4. Generate daily summaries for today.
  //
  // The pipeline now runs every day, so we always generate a single daily
  // summary for today. No Monday weekend-rollup needed — each day stands alone.
  //
  // Gap self-heal: also check the past 7 days for any date that has articles
  // but no summary (caused by a failed run or EdgeRuntime timeout) and backfill
  // those too while we have the budget.
  const sevenDaysAgo = new Date(todayDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const [{ data: existingSummaries }, { data: recentArticleDates }] = await Promise.all([
    supabase.from('daily_summaries').select('date').gte('date', sevenDaysAgo),
    supabase.from('articles').select('published_at').gte('published_at', `${sevenDaysAgo}T00:00:00Z`),
  ])
  const summaryDateSet = new Set((existingSummaries || []).map((s: { date: string }) => s.date))
  for (const row of (recentArticleDates || [])) {
    const d = (row as { published_at: string }).published_at?.slice(0, 10)
    if (d && !summaryDateSet.has(d)) {
      console.log(`  📋 Gap detected: ${d} has articles but no summary — adding to queue`)
      affectedDates.add(d)
    }
  }

  // Always include today so a summary is generated even if no new emails arrived
  // this particular invocation (the summary guarantee pass relies on this).
  const datesToSummarise = new Set([todayISO, ...affectedDates])
  console.log(`Generating summaries for: ${[...datesToSummarise].sort().join(', ')}`)

  let summaryCount = 0

  for (const date of datesToSummarise) {
    summaryCount += await generateDailySummaries(
      supabase, anthropicKey, categoryList, date, date,
    )
  }

  const result = {
    ok: true,
    emails_processed: processedEmailIds.length,
    articles_saved: totalArticlesSaved,
    summaries_generated: summaryCount,
    date: todayISO,
  }
  console.log('process-emails complete:', result)

  // Determine status: partial if emails queued but none processed this run
  const status = totalArticlesSaved === 0 && processedEmailIds.length === 0
    ? 'partial'
    : 'success'

  await finishRun({
    status,
    emails_processed: processedEmailIds.length,
    articles_saved: totalArticlesSaved,
    summaries_generated: summaryCount,
    metadata: { date: todayISO },
  })

  // Alert if Claude produced no articles and there were emails to process
  if (status === 'partial') {
    await sendAlert(
      supabase,
      `process-emails ran but saved 0 articles on ${todayISO}. ` +
      `Check Edge Function logs — Claude API may be rate-limited or emails had no extractable content.`,
    )
  }

  return result
}

// ── Article extraction via Claude ──────────────────────────────────────────

async function extractArticles(
  apiKey: string,
  subject: string,
  sender: string,
  bodyText: string,
  categories: string[],
): Promise<ExtractedArticle[]> {
  const prompt = `You are a newsletter parser. Extract all distinct news articles or stories from this newsletter email.

Newsletter subject: ${subject}
Sender: ${sender}

Newsletter body:
<newsletter>
${bodyText}
</newsletter>

Available interest categories: ${categories.join(', ')}

For each distinct article or story you find, output a JSON object. Return a JSON array (even if only 1 item). If no relevant articles are found, return an empty array [].

Each article object must have these exact fields:
- title: string — clear, concise headline
- url: string | null — the article URL if present, otherwise null
- snippet: string — 1–3 sentence summary of the article
- category: string — the single best-fit category, must be exactly one of the available categories
- category_tags: string[] — all relevant categories (1–3 items, each one of the available categories)
- relevance_score: number — float from 0.0 to 1.0 indicating relevance to the category
- signal_keywords_score: number — 0.0 to 1.0, objective newsworthiness of the event itself.
    Score 0.8–1.0: major funding round / acquisition / IPO, significant product launch by a major player,
                   important regulation or policy change, notable research breakthrough, large-scale layoffs.
    Score 0.4–0.7: meaningful but not landmark — mid-stage startup news, useful tool releases, industry trends.
    Score 0.0–0.3: opinion pieces, predictions, how-to guides, roundups, listicles.
- published_at: string | null — ISO date string if mentioned, otherwise null

Respond ONLY with the JSON array, no markdown, no explanation.`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Claude API error ${res.status}: ${errBody}`)
  }

  const data = await res.json()
  const rawText = (data.content?.[0]?.text || '').trim()

  try {
    // Strip markdown code fences if Claude wrapped the JSON
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    console.error('Failed to parse Claude extraction JSON:', rawText.slice(0, 300))
    return []
  }
}

// ── Daily summary generation ───────────────────────────────────────────────

/**
 * Generate (or regenerate) daily summaries for a date range.
 * Normally startDate === endDate (single day).
 * Pass a wider range to backfill a multi-day gap.
 */
async function generateDailySummaries(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  categories: Category[],
  startDate: string,  // beginning of article window (inclusive)
  endDate: string,    // end of article window and storage date (inclusive)
): Promise<number> {
  const isWeekendRollup = startDate !== endDate
  let summaryCount = 0

  for (const category of categories) {
    const { data: articles } = await supabase
      .from('articles')
      .select('title, snippet, url')
      .eq('primary_category_id', category.id)
      .gte('published_at', `${startDate}T00:00:00.000Z`)
      .lte('published_at', `${endDate}T23:59:59.999Z`)
      .order('impact_score', { ascending: false, nullsFirst: false })
      .order('relevance_score', { ascending: false })
      .limit(20)

    if (!articles?.length) continue

    const bulletList = articles
      .map((a, i) => `${i + 1}. ${a.title}${a.snippet ? ': ' + a.snippet : ''}`)
      .join('\n')

    const summaryText = await generateCategorySummary(
      anthropicKey,
      category.name,
      bulletList,
      articles.length,
      isWeekendRollup,
    )

    // Upsert under endDate so the summary appears on the correct day.
    const { error } = await supabase
      .from('daily_summaries')
      .upsert(
        {
          date:          endDate,
          category_id:   category.id,
          summary:       summaryText,
          article_count: articles.length,
          generated_at:  new Date().toISOString(),
        },
        { onConflict: 'date,category_id' },
      )

    if (error) {
      console.error(`  ✗ Failed to save summary for ${category.name}: ${error.message}`)
    } else {
      summaryCount++
      console.log(`  ✓ Summary [${startDate}→${endDate}] ${category.name}: ${articles.length} articles`)
    }
  }

  return summaryCount
}

async function generateCategorySummary(
  apiKey: string,
  categoryName: string,
  bulletList: string,
  articleCount: number,
  isWeekendRollup = false,
): Promise<string> {
  const period = isWeekendRollup ? 'this weekend and Monday' : 'today'
  const label  = isWeekendRollup ? 'Weekend + Monday' : "Today's"
  const prompt = `You are a senior analyst writing a morning briefing for a busy professional.

Summarize ${period}'s ${categoryName} news in 2–3 sentences. Be specific, insightful, and highlight the most important themes or developments.

${label} ${categoryName} articles (${articleCount} total):
${bulletList}

Write a concise synthesis paragraph — no bullet points, no headers, just flowing prose. Aim for 60–100 words.`

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
    const errBody = await res.text()
    console.error(`Claude summary error ${res.status}: ${errBody}`)
    return `${articleCount} articles processed today in ${categoryName}.`
  }

  const data = await res.json()
  return (data.content?.[0]?.text || '').trim()
}

// ── Utilities ──────────────────────────────────────────────────────────────

/** Find a category UUID by name (case-insensitive, falls back to first category) */
function resolveCategoryId(categories: Category[], name: string): string {
  const lower = name.toLowerCase()
  const match = categories.find((c) => c.name.toLowerCase() === lower)
  return match?.id ?? categories[0].id
}

/**
 * Validate and sanitise an article's extracted published_at date.
 *
 * Claude sometimes extracts dates that appear *inside* the newsletter body
 * (e.g. "join our webinar on March 26") rather than the email's actual delivery
 * date. This function rejects those implausible values and falls back to the
 * email's received_at timestamp, which is always reliable.
 *
 * Rejects if:
 *  - extracted is null / unparseable
 *  - extracted is more than 1 day in the future relative to received_at
 *    (catches forward-referenced event / webinar dates)
 *  - extracted is more than 30 days before received_at
 *    (catches deep historical references unlikely to be the real publish date)
 */
function sanitisePublishedAt(extracted: string | null, emailReceivedAt: string): string {
  if (!extracted) return emailReceivedAt
  try {
    const d = new Date(extracted)
    if (isNaN(d.getTime())) return emailReceivedAt
    const received = new Date(emailReceivedAt)
    const oneDayMs = 24 * 60 * 60 * 1000
    if (d.getTime() > received.getTime() + oneDayMs) {
      console.log(`  ⚠ published_at ${extracted} is future-dated vs received ${emailReceivedAt} — using received_at`)
      return emailReceivedAt
    }
    if (d.getTime() < received.getTime() - 30 * oneDayMs) {
      console.log(`  ⚠ published_at ${extracted} is >30d before received — using received_at`)
      return emailReceivedAt
    }
    return d.toISOString()
  } catch {
    return emailReceivedAt
  }
}
