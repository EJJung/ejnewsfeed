/**
 * generate-podcast — Supabase Edge Function
 * ==========================================
 * mode='daily' (default): turns the day's daily_summaries into a single
 * spoken-word script, synthesizes it via ElevenLabs TTS (one voice).
 * mode='weekly': turns the week's insights-table changes (promoted,
 * contested, reinforced) plus that week's top articles into a two-host
 * dialogue, synthesized via ElevenLabs TTS (two voices, one call per turn).
 * Both modes upload the resulting audio to Storage and insert an episodes
 * row that podcast-feed serves as RSS.
 *
 * Triggered by pg_cron (see supabase/pg_cron_podcast.sql):
 * daily ~5 min after distill-insights' daily run, weekly ~15 min after
 * distill-insights' weekly run.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendAlert } from '../_shared/alert.ts'
import { synthesizeSpeech, synthesizeDialogue, checkQuota, type DialogueTurn } from '../_shared/tts.ts'

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

// Domain slugs (generic, used by insights.domains) map to this project's
// existing categories.name values (see pipeline/audit_pipeline.py CATEGORIES).
// Duplicated from distill-insights/index.ts's own local copy — each edge
// function in this repo is deployed independently and only shares code via
// _shared/, so this small mapping is kept local rather than introducing a
// new cross-function import.
const DOMAIN_TO_CATEGORY: Record<string, string> = {
  ai: 'AI',
  it: 'IT',
  entrepreneurship: 'Entrepreneurship',
  business: 'Business',
  ux: 'UX Design',
}
const WEEKLY_DOMAINS = Object.keys(DOMAIN_TO_CATEGORY)

type Mode = 'daily' | 'weekly'

interface Category { id: string; name: string }
interface DailySummaryRow { category_id: string; summary: string; article_count: number }
interface ArticleRow { title: string; snippet: string | null }
interface ScriptSection { category: string; summary: string; articleCount: number; bulletList: string }

interface WeeklyContestedInsight { text: string; supporting: string[]; contradicting: string[] }
interface WeeklyOpenQuestion { question: string; whyItMatters: string | null }
interface WeeklyDomainSection {
  domain: string
  promoted: string[]
  contested: WeeklyContestedInsight[]
  reinforced: string[]
  openQuestions: WeeklyOpenQuestion[]
  colorArticles: ArticleRow[]
  rejectedCount: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  let mode: Mode = 'daily'
  try {
    const body = await req.json()
    if (body && (body.mode === 'daily' || body.mode === 'weekly')) mode = body.mode
  } catch {
    // No body, or invalid JSON — default to 'daily'. This is deliberate:
    // the existing podcast-daily-brief pg_cron job sends body := '{}'::jsonb
    // (no mode key), and must keep working unmodified.
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!
  const elevenLabsKey = Deno.env.get('ELEVENLABS_API_KEY')!
  const voiceId = Deno.env.get('ELEVENLABS_VOICE_ID') || 'pNInz6obpgDQGcFmaJgB'
  const voiceIdA = Deno.env.get('ELEVENLABS_VOICE_ID_A') || 'ErXwobaYiN019PkySvjV'
  const voiceIdB = Deno.env.get('ELEVENLABS_VOICE_ID_B') || '21m00Tcm4TlvDq8ikWAM'

  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'generate-podcast', status: 'running', metadata: { mode } })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  const work = (mode === 'weekly'
    ? generateWeeklyEpisode(supabase, anthropicKey, elevenLabsKey, { A: voiceIdA, B: voiceIdB })
    : generateDailyEpisode(supabase, anthropicKey, elevenLabsKey, voiceId)
  )
    .then(async (result) => {
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(), status: 'success', metadata: { mode, ...result },
        }).eq('id', runId)
      }
      return { ok: true, mode, ...result }
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`generate-podcast (${mode}) fatal error:`, err)
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(), status: 'error', error_message: msg, metadata: { mode },
        }).eq('id', runId)
      }
      await sendAlert(supabase, 'generate-podcast', `generate-podcast (${mode}) crashed: ${msg}`)
      return { ok: false, error: msg }
    })

  // @ts-ignore — Deno Deploy global
  if (typeof EdgeRuntime !== 'undefined') {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
    return new Response(
      JSON.stringify({ ok: true, message: `generate-podcast (${mode}) started in background` }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  const result = await work
  return new Response(JSON.stringify(result), {
    status: (result as { ok: boolean }).ok === false ? 500 : 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})

// ── Daily mode (unchanged behavior, renamed from generateEpisode) ──────────

async function generateDailyEpisode(
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

  const script = await writeDailyScript(anthropicKey, sections)
  const wordCount = script.trim().split(/\s+/).filter(Boolean).length
  const durationSeconds = Math.round((wordCount / WORDS_PER_MINUTE) * 60)

  const quota = await checkQuota(elevenLabsKey, script.length)
  if (!quota.sufficient) {
    await sendAlert(
      supabase,
      'generate-podcast',
      `generate-podcast (daily) skipped: ElevenLabs quota too low (${quota.remaining} chars remaining, need ~${quota.required})`,
    )
    return { skipped: 'insufficient_elevenlabs_quota', remaining: quota.remaining, required: quota.required }
  }

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
    const { audioUrl } = await uploadEpisodeAudio(supabase, episodeId, audioBytes)

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

async function writeDailyScript(apiKey: string, sections: ScriptSection[]): Promise<string> {
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

// ── Weekly mode ──────────────────────────────────────────────────────────

async function generateWeeklyEpisode(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  elevenLabsKey: string,
  voiceIds: { A: string; B: string },
) {
  const now = new Date()
  const weekStartISO = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const todayISO = now.toISOString().slice(0, 10)

  // Most recent distill-insights weekly run's per-domain rejected counts
  // (for "N candidates didn't hold up" framing — count only, no full text).
  const { data: recentRuns } = await supabase
    .from('pipeline_runs')
    .select('metadata, started_at')
    .eq('job_name', 'distill-insights')
    .order('started_at', { ascending: false })
    .limit(5)
  const lastWeeklyRun = ((recentRuns || []) as { metadata: Record<string, unknown> | null }[])
    .find((r) => r.metadata?.mode === 'weekly')
  const domainResults = (lastWeeklyRun?.metadata?.domain_results || {}) as Record<string, { rejected?: number }>

  const sections: WeeklyDomainSection[] = []
  let totalSignals = 0

  for (const domain of WEEKLY_DOMAINS) {
    const categoryName = DOMAIN_TO_CATEGORY[domain]

    const { data: promotedRows } = await supabase
      .from('insights')
      .select('id, text')
      .contains('domains', [domain])
      .eq('status', 'active')
      .gte('updated_at', weekStartISO)
    const promoted = (promotedRows || []) as { id: string; text: string }[]

    const { data: contestedRows } = await supabase
      .from('insights')
      .select('id, text')
      .contains('domains', [domain])
      .eq('status', 'contested')
      .gte('updated_at', weekStartISO)

    const contested: WeeklyContestedInsight[] = []
    for (const row of (contestedRows || []) as { id: string; text: string }[]) {
      const { data: sourceLinks } = await supabase
        .from('insight_sources')
        .select('article_id, relation')
        .eq('insight_id', row.id)
      const links = (sourceLinks || []) as { article_id: string; relation: string }[]
      const articleIds = links.map((l) => l.article_id)

      const titleById: Record<string, string> = {}
      if (articleIds.length) {
        const { data: linkedArticles } = await supabase
          .from('articles')
          .select('id, title')
          .in('id', articleIds)
        for (const a of (linkedArticles || []) as { id: string; title: string }[]) {
          titleById[a.id] = a.title
        }
      }
      contested.push({
        text: row.text,
        supporting: links.filter((l) => l.relation === 'supporting').map((l) => titleById[l.article_id]).filter(Boolean),
        contradicting: links.filter((l) => l.relation === 'contradicting').map((l) => titleById[l.article_id]).filter(Boolean),
      })
    }

    const { data: reinforcedRows } = await supabase
      .from('insights')
      .select('id, text')
      .contains('domains', [domain])
      .eq('last_confirmed_at', todayISO)
    const reinforced = (reinforcedRows || []) as { id: string; text: string }[]

    const { data: openQuestionRows } = await supabase
      .from('open_questions')
      .select('question, why_it_matters')
      .contains('domains', [domain])
      .eq('status', 'open')
    const openQuestions = ((openQuestionRows || []) as { question: string; why_it_matters: string | null }[])
      .map((q) => ({ question: q.question, whyItMatters: q.why_it_matters }))

    const { data: articles } = await supabase
      .from('articles')
      .select('title, snippet')
      .contains('category_tags', [categoryName])
      .gte('published_at', weekStartISO)
      .order('impact_score', { ascending: false, nullsFirst: false })
      .limit(3)
    const colorArticles = (articles || []) as ArticleRow[]

    totalSignals += promoted.length + contested.length + reinforced.length + openQuestions.length

    sections.push({
      domain: categoryName,
      promoted: promoted.map((p) => p.text),
      contested,
      reinforced: reinforced.map((r) => r.text),
      openQuestions,
      colorArticles,
      rejectedCount: domainResults[domain]?.rejected || 0,
    })
  }

  if (totalSignals === 0) {
    return { skipped: 'no_content', week_start: weekStartISO }
  }

  const turns = await writeDialogueScript(anthropicKey, sections)
  const wordCount = turns.reduce((sum, t) => sum + t.text.trim().split(/\s+/).filter(Boolean).length, 0)
  const durationSeconds = Math.round((wordCount / WORDS_PER_MINUTE) * 60)

  const totalChars = turns.reduce((sum, t) => sum + t.text.length, 0)
  const quota = await checkQuota(elevenLabsKey, totalChars)
  if (!quota.sufficient) {
    await sendAlert(
      supabase,
      'generate-podcast',
      `generate-podcast (weekly) skipped: ElevenLabs quota too low (${quota.remaining} chars remaining, need ~${quota.required})`,
    )
    return { skipped: 'insufficient_elevenlabs_quota', remaining: quota.remaining, required: quota.required }
  }

  const [year, month, day] = todayISO.split('-').map(Number)
  const title = `EJ Weekly Deep Dive — ${MONTHS[month - 1]} ${day}, ${year}`

  const { data: episodeRow, error: episodeErr } = await supabase
    .from('episodes')
    .insert({ kind: 'weekly', title, script: JSON.stringify(turns), status: 'generating' })
    .select('id')
    .single()
  if (episodeErr || !episodeRow) throw new Error(`Failed to create episode row: ${episodeErr?.message ?? 'no row returned'}`)
  const episodeId = (episodeRow as { id: string }).id

  try {
    const audioBytes = await synthesizeDialogue(turns, elevenLabsKey, voiceIds)
    const { audioUrl } = await uploadEpisodeAudio(supabase, episodeId, audioBytes)

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

    return { episode_id: episodeId, word_count: wordCount, duration_seconds: durationSeconds, turn_count: turns.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await supabase.from('episodes').update({ status: 'error', error_message: msg }).eq('id', episodeId)
    throw err
  }
}

async function writeDialogueScript(apiKey: string, sections: WeeklyDomainSection[]): Promise<DialogueTurn[]> {
  const sectionText = sections
    .map((s) => {
      const parts: string[] = [`## ${s.domain}`]
      if (s.promoted.length) {
        parts.push(`Newly promoted insights this week:\n${s.promoted.map((t) => `- ${t}`).join('\n')}`)
      }
      if (s.contested.length) {
        parts.push(
          `Contested insights (real disagreement between sources):\n` +
          s.contested.map((c) =>
            `- "${c.text}"\n  Supporting: ${c.supporting.join('; ') || '(none listed)'}\n  Contradicting: ${c.contradicting.join('; ') || '(none listed)'}`,
          ).join('\n'),
        )
      }
      if (s.reinforced.length) {
        parts.push(`Reinforced this week (still holding, got new supporting evidence):\n${s.reinforced.map((t) => `- ${t}`).join('\n')}`)
      }
      if (s.openQuestions.length) {
        parts.push(
          `Open questions:\n` +
          s.openQuestions.map((q) => `- ${q.question}${q.whyItMatters ? ` (${q.whyItMatters})` : ''}`).join('\n'),
        )
      }
      if (s.rejectedCount > 0) {
        parts.push(`${s.rejectedCount} other candidate insight(s) this week didn't hold up (rejected) — mention only in passing if at all.`)
      }
      if (s.colorArticles.length) {
        parts.push(
          `This week's top articles for concrete examples:\n` +
          s.colorArticles.map((a) => `- ${a.title}${a.snippet ? ': ' + a.snippet : ''}`).join('\n'),
        )
      }
      return parts.join('\n\n')
    })
    .filter((section) => section.split('\n\n').length > 1) // drop domains with only the "## Name" header, nothing else
    .join('\n\n---\n\n')

  const prompt = `You are writing the dialogue script for a weekly audio deep-dive podcast for EJ, a listener who tracks AI, IT, entrepreneurship, business, and UX trends.

Below is this week's material from EJ's knowledge base, one section per domain with activity:

${sectionText}

Write a two-host dialogue between peer co-hosts "A" and "B" — real back-and-forth, both can introduce points and both can push back, not a host-plus-expert dynamic.

Structure: open with the week's headline trend across all domains → work through the contested insights as genuine disagreement (one host can raise the supporting side, the other the contradicting side, and they can actually disagree about which is more convincing) → touch reinforced insights briefly → close on the open questions worth EJ's attention. Skip a domain entirely if it has nothing substantive this week rather than padding it.

Length is driven by content, not a target: typically 2200-3000 words total across all turns. Do not pad to reach a length and do not cut real substance to stay short.

Each turn is ONE short conversational beat, 1-4 sentences — not an alternating essay. Write for the ear: short sentences, no visual references, no markdown, no meta-commentary like "welcome back" or "that's all for this week" bookending — just the substance, start to finish.

Return ONLY a JSON object of this exact shape, no markdown fences, no explanation:
{"turns": [{"speaker": "A", "text": "..."}, {"speaker": "B", "text": "..."}, ...]}`

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`)

  const data = await res.json()
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude response was truncated by max_tokens — dialogue may be incomplete')
  }
  const rawText = (data.content?.[0]?.text || '').trim()

  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`Claude returned invalid JSON for dialogue turns: ${rawText.slice(0, 300)}`)
  }

  const rawTurns = (parsed as { turns?: unknown[] } | null)?.turns
  if (!Array.isArray(rawTurns) || !rawTurns.length) {
    throw new Error('Claude returned zero dialogue turns')
  }

  const turns: DialogueTurn[] = []
  for (const t of rawTurns) {
    const item = t as Partial<DialogueTurn> | null | undefined
    if ((item?.speaker === 'A' || item?.speaker === 'B') && typeof item.text === 'string' && item.text.trim()) {
      turns.push({ speaker: item.speaker, text: item.text.trim() })
    }
  }
  if (!turns.length) throw new Error('Claude returned zero valid dialogue turns after validation')

  return turns
}

// ── Shared storage upload (both modes) ──────────────────────────────────────

async function uploadEpisodeAudio(
  supabase: ReturnType<typeof createClient>,
  episodeId: string,
  audioBytes: Uint8Array,
): Promise<{ audioUrl: string }> {
  const storagePath = `${episodeId}.mp3`
  const { error: uploadErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, audioBytes, { contentType: 'audio/mpeg', upsert: true })
  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

  const { data: publicUrlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath)
  return { audioUrl: publicUrlData.publicUrl }
}
