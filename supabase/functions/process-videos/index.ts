/**
 * process-videos — Supabase Edge Function
 * ==========================================
 * Reads transcribed raw_videos rows, calls Claude to categorize and
 * summarize each one, and inserts an articles row per video —
 * content_type='youtube', full_content=transcript.
 *
 * Does NOT generate daily_summaries itself: process-emails' existing
 * gap-detection (queries articles.published_at with no content_type
 * filter) picks up video-sourced dates automatically on its next
 * scheduled run. See the plan's Global Constraints for why.
 *
 * Triggered by pg_cron (see supabase/pg_cron_youtube.sql).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendAlert } from '../_shared/alert.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

const TIER_SCORES: Record<string, number> = { A: 1.0, B: 0.6, C: 0.3 }

interface Category { id: string; name: string }

interface RawVideo {
  id: string
  youtube_video_id: string
  source_id: string | null
  title: string
  url: string | null
  thumbnail_url: string | null
  published_at: string | null
  duration_seconds: number | null
  transcript: string
}

interface VideoSummary {
  title: string
  snippet: string
  category: string
  category_tags: string[]
  relevance_score: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!

  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'process-videos', status: 'running' })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  const work = processAll(supabase, anthropicKey)
    .then(async (result) => {
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(), status: 'success', metadata: result,
        }).eq('id', runId)
      }
      return { ok: true, ...result }
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('process-videos fatal error:', err)
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(), status: 'error', error_message: msg,
        }).eq('id', runId)
      }
      await sendAlert(supabase, 'process-videos', `process-videos crashed: ${msg}`)
      return { ok: false, error: msg }
    })

  // @ts-ignore — Deno Deploy global
  if (typeof EdgeRuntime !== 'undefined') {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
    return new Response(
      JSON.stringify({ ok: true, message: 'process-videos started in background' }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  const result = await work
  return new Response(JSON.stringify(result), {
    status: (result as { ok: boolean }).ok === false ? 500 : 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})

async function processAll(supabase: ReturnType<typeof createClient>, anthropicKey: string) {
  const { data: categories, error: catErr } = await supabase.from('categories').select('id, name')
  if (catErr || !categories?.length) throw new Error(`Failed to load categories: ${catErr?.message ?? 'empty'}`)
  const categoryList = categories as Category[]
  const categoryNames = categoryList.map((c) => c.name)

  const { data: videos, error: videoErr } = await supabase
    .from('raw_videos')
    .select('id, youtube_video_id, source_id, title, url, thumbnail_url, published_at, duration_seconds, transcript')
    .eq('status', 'transcribed')
    .eq('processed', false)
    .order('published_at', { ascending: true })
    .limit(4)

  if (videoErr) throw new Error(`Failed to load transcribed videos: ${videoErr.message}`)
  const rows = (videos || []) as RawVideo[]
  if (!rows.length) return { videos_processed: 0, articles_saved: 0 }

  const tierCache = new Map<string, number>()
  const getSourceAuthority = async (sourceId: string | null): Promise<number> => {
    if (!sourceId) return TIER_SCORES.C
    if (!tierCache.has(sourceId)) {
      const { data } = await supabase.from('sources').select('tier').eq('id', sourceId).maybeSingle()
      tierCache.set(sourceId, TIER_SCORES[(data as { tier?: string } | null)?.tier || 'C'] ?? TIER_SCORES.C)
    }
    return tierCache.get(sourceId)!
  }

  const settled = await Promise.allSettled(
    rows.map(async (video) => {
      const summary = await summarizeVideo(anthropicKey, video.title, video.transcript, categoryNames)
      const catId = resolveCategoryId(categoryList, summary.category)
      const impactScore = await getSourceAuthority(video.source_id)

      const { error: insertErr } = await supabase.from('articles').insert({
        raw_email_id:         null,
        raw_video_id:         video.id,
        source_id:            video.source_id,
        content_type:         'youtube',
        title:                summary.title,
        url:                  video.url,
        snippet:              summary.snippet,
        full_content:         video.transcript,
        primary_category_id:  catId,
        category_tags:        summary.category_tags.length ? summary.category_tags : [summary.category],
        relevance_score:      summary.relevance_score,
        impact_score:         impactScore,
        duration_seconds:     video.duration_seconds,
        thumbnail_url:        video.thumbnail_url,
        published_at:         video.published_at,
      })
      if (insertErr) throw new Error(`Article insert failed for video ${video.youtube_video_id}: ${insertErr.message}`)

      await supabase.from('raw_videos').update({ processed: true, status: 'processed' }).eq('id', video.id)
      return true
    }),
  )

  let processed = 0
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') processed++
    else console.error(`  ✗ Error processing video ${rows[i].youtube_video_id}: ${s.reason}`)
  }

  return { videos_processed: processed, articles_saved: processed }
}

async function summarizeVideo(apiKey: string, rawTitle: string, transcript: string, categories: string[]): Promise<VideoSummary> {
  const prompt = `You are analyzing a YouTube video transcript for a personal knowledge feed.

Raw video title (often clickbait-shaped — clean it up): ${rawTitle}

Transcript:
<transcript>
${transcript}
</transcript>

Available interest categories: ${categories.join(', ')}

Return ONLY a JSON object:
{
  "title": string — a clear, clickbait-free headline capturing what the video is actually about,
  "snippet": string — 3-5 sentence summary of the video's substance,
  "category": string — the single best-fit category, must be exactly one of the available categories,
  "category_tags": string[] — all relevant categories (1-3 items, each one of the available categories),
  "relevance_score": number — float 0.0-1.0 indicating relevance to the category
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
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`)

  const data = await res.json()
  const rawText = (data.content?.[0]?.text || '').trim()
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  return JSON.parse(cleaned) as VideoSummary
}

function resolveCategoryId(categories: Category[], name: string): string {
  const lower = name.toLowerCase()
  const match = categories.find((c) => c.name.toLowerCase() === lower)
  return match?.id ?? categories[0].id
}
