/**
 * generate-podcast — Supabase Edge Function
 * ==========================================
 * Turns the day's daily_summaries into a single spoken-word script,
 * synthesizes it via ElevenLabs TTS, uploads the audio to Storage, and
 * inserts an episodes row that podcast-feed serves as RSS.
 *
 * Triggered by pg_cron ~5 min after distill-insights' daily run
 * (see supabase/pg_cron_podcast.sql).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendAlert } from '../_shared/alert.ts'
import { synthesizeSpeech } from '../_shared/tts.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-6'
const STORAGE_BUCKET = 'podcast-episodes'
const WORDS_PER_MINUTE = 150

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface Category { id: string; name: string }
interface DailySummaryRow { category_id: string; summary: string; article_count: number }
interface ArticleRow { title: string; snippet: string | null }
interface ScriptSection { category: string; summary: string; articleCount: number; bulletList: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!
  const elevenLabsKey = Deno.env.get('ELEVENLABS_API_KEY')!
  const voiceId = Deno.env.get('ELEVENLABS_VOICE_ID') || 'pNInz6obpgDQGcFmaJgB'

  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'generate-podcast', status: 'running' })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  const work = generateEpisode(supabase, anthropicKey, elevenLabsKey, voiceId)
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
      console.error('generate-podcast fatal error:', err)
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(), status: 'error', error_message: msg,
        }).eq('id', runId)
      }
      await sendAlert(supabase, 'generate-podcast', `generate-podcast crashed: ${msg}`)
      return { ok: false, error: msg }
    })

  // @ts-ignore — Deno Deploy global
  if (typeof EdgeRuntime !== 'undefined') {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
    return new Response(
      JSON.stringify({ ok: true, message: 'generate-podcast started in background' }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  const result = await work
  return new Response(JSON.stringify(result), {
    status: (result as { ok: boolean }).ok === false ? 500 : 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})

async function generateEpisode(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  elevenLabsKey: string,
  voiceId: string,
) {
  const todayISO = new Date().toISOString().slice(0, 10)

  const { data: categories, error: catErr } = await supabase.from('categories').select('id, name')
  if (catErr || !categories?.length) throw new Error(`Failed to load categories: ${catErr?.message ?? 'empty'}`)
  const categoryList = categories as Category[]

  const { data: summaries, error: sumErr } = await supabase
    .from('daily_summaries')
    .select('category_id, summary, article_count')
    .eq('date', todayISO)
  if (sumErr) throw new Error(`Failed to load daily_summaries: ${sumErr.message}`)
  const summaryRows = (summaries || []) as DailySummaryRow[]

  if (!summaryRows.length) {
    return { skipped: 'no_content', date: todayISO }
  }

  const sections: ScriptSection[] = []
  for (const row of summaryRows) {
    const category = categoryList.find((c) => c.id === row.category_id)
    if (!category) continue

    const { data: articles } = await supabase
      .from('articles')
      .select('title, snippet')
      .eq('primary_category_id', category.id)
      .gte('published_at', `${todayISO}T00:00:00.000Z`)
      .lte('published_at', `${todayISO}T23:59:59.999Z`)
      .order('impact_score', { ascending: false, nullsFirst: false })
      .order('relevance_score', { ascending: false })
      .limit(3)

    const topArticles = (articles || []) as ArticleRow[]
    const bulletList = topArticles
      .map((a) => `- ${a.title}${a.snippet ? ': ' + a.snippet : ''}`)
      .join('\n')

    sections.push({
      category: category.name,
      summary: row.summary,
      articleCount: row.article_count,
      bulletList,
    })
  }

  const script = await writeScript(anthropicKey, sections)
  const wordCount = script.trim().split(/\s+/).filter(Boolean).length
  const durationSeconds = Math.round((wordCount / WORDS_PER_MINUTE) * 60)

  const [year, month, day] = todayISO.split('-').map(Number)
  const title = `EJ Daily Brief — ${MONTHS[month - 1]} ${day}, ${year}`

  const { data: episodeRow, error: episodeErr } = await supabase
    .from('episodes')
    .insert({ kind: 'daily', title, script, status: 'generating' })
    .select('id')
    .single()
  if (episodeErr || !episodeRow) throw new Error(`Failed to create episode row: ${episodeErr?.message ?? 'no row returned'}`)
  const episodeId = (episodeRow as { id: string }).id

  try {
    const audioBytes = await synthesizeSpeech(script, elevenLabsKey, voiceId)

    const storagePath = `${episodeId}.mp3`
    const { error: uploadErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, audioBytes, { contentType: 'audio/mpeg', upsert: true })
    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

    const { data: publicUrlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath)
    const audioUrl = publicUrlData.publicUrl

    const { error: updateErr } = await supabase
      .from('episodes')
      .update({
        audio_url: audioUrl,
        duration_seconds: durationSeconds,
        published_at: new Date().toISOString(),
        status: 'ready',
      })
      .eq('id', episodeId)
    if (updateErr) throw new Error(`Failed to finalize episode row: ${updateErr.message}`)

    return { episode_id: episodeId, word_count: wordCount, duration_seconds: durationSeconds }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await supabase.from('episodes').update({ status: 'error', error_message: msg }).eq('id', episodeId)
    throw err
  }
}

async function writeScript(apiKey: string, sections: ScriptSection[]): Promise<string> {
  const sectionText = sections
    .map((s) =>
      `## ${s.category} (${s.articleCount} articles today)\n` +
      `Synthesized summary: ${s.summary}\n` +
      `Top stories:\n${s.bulletList || '(no individual articles above the top-3 cut)'}`,
    )
    .join('\n\n')

  const prompt = `You are writing the script for a daily audio news brief for EJ, a listener who tracks AI, entrepreneurship, business, and UX trends.

Below is today's synthesized material, one section per active category:

${sectionText}

Write ONE continuous spoken-word script covering all of this — not separate category blocks with headers, a real news-brief voice with natural transitions between topics. Lead with the single highest-impact story across ALL categories, not necessarily the first category listed. Skip a category entirely if it has nothing substantive to say rather than padding it.

Length is driven by content, not a target: typically 700-3000 words. Do not pad to reach a length and do not cut real substance to stay short.

Write for the ear, not the eye: short sentences, no visual references ("as shown above"), no markdown formatting, no headers, no meta-commentary like "in today's episode" or "that's it for today" bookending — just the substance, start to finish. Output ONLY the script text, nothing else.`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`)

  const data = await res.json()
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude response was truncated by max_tokens — script may be incomplete')
  }
  const script = (data.content?.[0]?.text || '').trim()
  if (!script) throw new Error('Claude returned an empty script')
  return script
}
