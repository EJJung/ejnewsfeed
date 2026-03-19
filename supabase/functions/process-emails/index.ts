/**
 * process-emails — Supabase Edge Function
 * =========================================
 * Reads unprocessed raw_emails rows, calls Claude to extract articles
 * and categorize them, saves to articles table, then generates
 * daily_summaries per category.
 *
 * Triggered by pg_cron at 7:10am UTC Mon–Fri (10 minutes after fetch-emails).
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
  relevance_score: number
  published_at: string | null
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

  // Kick off background work and return immediately
  const work = processAll(supabase, anthropicKey)

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
) {
  // 1. Load all categories (we'll need them for ID lookup)
  const { data: categories, error: catErr } = await supabase
    .from('categories')
    .select('id, name, description, color')

  if (catErr || !categories?.length) {
    throw new Error(`Failed to load categories: ${catErr?.message ?? 'empty'}`)
  }

  const categoryList = categories as Category[]
  const categoryNames = categoryList.map((c) => c.name)

  // 2. Fetch unprocessed emails
  const { data: emails, error: emailErr } = await supabase
    .from('raw_emails')
    .select('id, subject, sender, source_id, received_at, raw_html, raw_text')
    .eq('processed', false)
    .order('received_at', { ascending: true })
    .limit(15) // process up to 15 per run — keeps Claude calls within time budget so summary generation always runs

  if (emailErr) throw new Error(`Failed to fetch raw_emails: ${emailErr.message}`)

  const rawEmails = (emails || []) as RawEmail[]
  console.log(`Processing ${rawEmails.length} unprocessed email(s).`)

  let totalArticlesSaved = 0
  const processedEmailIds: string[] = []

  // 3. Process each email
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

      // Extract articles via Claude
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

      // Save each article
      for (const article of extracted) {
        const catId = resolveCategoryId(categoryList, article.category)

        const { error: insertErr } = await supabase.from('articles').insert({
          raw_email_id:        email.id,
          source_id:           email.source_id,
          title:               article.title,
          url:                 article.url || null,
          snippet:             article.snippet,
          primary_category_id: catId,
          category_tags:       [article.category],
          relevance_score:     article.relevance_score,
          published_at:        article.published_at || email.received_at,
        })

        if (insertErr) {
          console.error(`  ✗ Failed to save article "${article.title}": ${insertErr.message}`)
        } else {
          totalArticlesSaved++
        }
      }

      // Mark email processed
      await supabase.from('raw_emails').update({ processed: true }).eq('id', email.id)
      processedEmailIds.push(email.id)

      console.log(
        `  ✓ Processed: ${email.subject?.slice(0, 50)} — ${extracted.length} article(s)`,
      )
    } catch (err) {
      // Leave processed=false so it will retry next run
      console.error(`  ✗ Error processing email ${email.id}: ${err}`)
    }
  }

  // 4. Generate daily summaries for today
  const today = new Date().toISOString().slice(0, 10)
  const summaryCount = await generateDailySummaries(
    supabase,
    anthropicKey,
    categoryList,
    today,
  )

  const result = {
    ok: true,
    emails_processed: processedEmailIds.length,
    articles_saved: totalArticlesSaved,
    summaries_generated: summaryCount,
    date: today,
  }
  console.log('process-emails complete:', result)
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
- category: string — must be exactly one of the available categories
- relevance_score: number — float from 0.0 to 1.0 indicating relevance to the category
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

async function generateDailySummaries(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  categories: Category[],
  date: string,
): Promise<number> {
  let summaryCount = 0

  for (const category of categories) {
    // Fetch today's articles for this category
    const { data: articles } = await supabase
      .from('articles')
      .select('title, snippet, url')
      .eq('primary_category_id', category.id)
      .gte('created_at', `${date}T00:00:00.000Z`)
      .lte('created_at', `${date}T23:59:59.999Z`)
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
    )

    // Upsert so re-running updates the summary
    const { error } = await supabase
      .from('daily_summaries')
      .upsert(
        {
          date,
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
      console.log(`  ✓ Summary for ${category.name}: ${articles.length} articles`)
    }
  }

  return summaryCount
}

async function generateCategorySummary(
  apiKey: string,
  categoryName: string,
  bulletList: string,
  articleCount: number,
): Promise<string> {
  const prompt = `You are a senior analyst writing a morning briefing for a busy professional.

Summarize today's ${categoryName} news in 2–3 sentences. Be specific, insightful, and highlight the most important themes or developments.

Today's ${categoryName} articles (${articleCount} total):
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
