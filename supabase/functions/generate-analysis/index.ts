/**
 * generate-analysis — Supabase Edge Function
 * ============================================
 * Called on-demand from the dashboard when a user opens an article in Dive view.
 * Checks for a cached analysis first, generates one via Claude if missing,
 * saves it to article_analyses, then returns it.
 *
 * POST /functions/v1/generate-analysis
 * Body: { articleId: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

const INTEREST_AREAS = ['AI', 'Business', 'Entrepreneurship', 'IT', 'UX Design']

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  try {
    const { articleId } = await req.json()
    if (!articleId) {
      return new Response(JSON.stringify({ error: 'articleId is required' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

    // 1. Check for cached analysis first
    const { data: existing } = await supabase
      .from('article_analyses')
      .select('*')
      .eq('article_id', articleId)
      .single()

    if (existing) {
      return new Response(JSON.stringify({ ok: true, analysis: normalizeAnalysis(existing), cached: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // 2. Fetch the article to analyze
    const { data: article, error: articleErr } = await supabase
      .from('articles')
      .select(`
        id, title, url, snippet,
        categories ( name )
      `)
      .eq('id', articleId)
      .single()

    if (articleErr || !article) {
      return new Response(JSON.stringify({ error: 'Article not found' }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const categoryName = (article.categories as { name: string } | null)?.name || 'General'

    // 3. Generate analysis via Claude
    const analysis = await generateAnalysis(anthropicKey, article, categoryName)

    // 4. Save to article_analyses (cache for future views)
    const { error: insertErr } = await supabase
      .from('article_analyses')
      .insert({
        article_id:           articleId,
        key_points:           analysis.key_points,
        so_what:              analysis.so_what,
        implications:         analysis.implications,
        interest_connections: analysis.interest_connections,
        generated_at:         new Date().toISOString(),
      })

    if (insertErr) {
      console.error('Failed to cache analysis:', insertErr.message)
      // Still return the analysis even if caching failed
    }

    return new Response(JSON.stringify({ ok: true, analysis, cached: false }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('generate-analysis error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})

// ── Claude analysis generation ─────────────────────────────────────────────

async function generateAnalysis(
  apiKey: string,
  article: { title: string; url: string | null; snippet: string },
  categoryName: string,
) {
  const prompt = `You are a sharp analyst briefing a curious professional who follows AI, Business, Entrepreneurship, IT, and UX Design.

Analyze this article and return a JSON object with a deep, specific analysis. Be concrete — avoid generic statements that could apply to any article.

Article title: ${article.title}
Category: ${categoryName}
Summary: ${article.snippet}
${article.url ? `URL: ${article.url}` : ''}

Return ONLY a JSON object with these exact fields:

{
  "key_points": [
    "string — specific, concrete insight #1",
    "string — specific, concrete insight #2",
    "string — specific, concrete insight #3",
    "string — specific, concrete insight #4"
  ],
  "so_what": "string — 2-3 sentences on why this matters RIGHT NOW. What shifts does this signal? Be direct and specific, not generic.",
  "implications": "string — 2-3 sentences on what to watch for in the next 30-90 days. Name specific companies, trends, or metrics where possible.",
  "interest_connections": [
    {
      "category": "one of: ${INTEREST_AREAS.join(', ')}",
      "connection": "string — specific way this article connects to that interest area"
    }
  ]
}

Rules:
- key_points: 4 items, each 1-2 sentences, specific to THIS article
- interest_connections: 2-3 items, only include categories that genuinely connect
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
      max_tokens: 1024,
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
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    return JSON.parse(cleaned)
  } catch {
    console.error('Failed to parse Claude analysis JSON:', rawText.slice(0, 300))
    throw new Error('Claude returned invalid JSON')
  }
}

// ── Normalize DB row to consistent shape ───────────────────────────────────

function normalizeAnalysis(row: Record<string, unknown>) {
  return {
    key_points:           Array.isArray(row.key_points) ? row.key_points : JSON.parse(String(row.key_points || '[]')),
    so_what:              row.so_what,
    implications:         row.implications,
    interest_connections: Array.isArray(row.interest_connections) ? row.interest_connections : JSON.parse(String(row.interest_connections || '[]')),
  }
}
