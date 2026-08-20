# Podcast Weekly Deep Dive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a weekly ~15–20 minute two-host audio dialogue, unattended every Monday, synthesized from that week's `insights` table changes (promoted/contested/reinforced) plus that week's top articles, and deliver it through the same private RSS feed the daily brief already uses.

**Architecture:** Extends the existing `generate-podcast` Edge Function with a `mode: 'daily' | 'weekly'` request body param (mirroring the `distill-insights` mode pattern already in this codebase), rather than a new function — the two modes share `pipeline_runs` logging, `sendAlert` failure handling, Storage upload, and `episodes` insert/update; only data gathering, script generation, and TTS turn-building differ. `_shared/tts.ts` gains a `synthesizeDialogue` export alongside the existing single-voice `synthesizeSpeech`, sharing an internal per-chunk synthesis helper. No schema changes (`episodes.kind='weekly'` already exists) and no changes to `podcast-feed` (it already serves all `kind` values).

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres (via SQL Editor — no migration tooling in this repo), Claude API (`claude-sonnet-4-6`), ElevenLabs TTS API.

## Global Constraints

- Claude model: `claude-sonnet-4-6` (matches every other edge function in this repo).
- Every external `fetch` call (Claude, ElevenLabs) MUST set an `AbortSignal.timeout(...)`.
- Reuse `supabase/functions/_shared/alert.ts`'s `sendAlert(supabase, jobName, message)` for failure alerts — do not write a new local copy.
- Every job logs to the existing `pipeline_runs` table, `job_name = 'generate-podcast'` (same value for both modes — mode is distinguished via `metadata.mode`, not a different `job_name`, so the existing watchdog exemption in `supabase/pg_cron_watchdog_exclude_podcast.sql` (keyed on `job_name <> 'generate-podcast'`) automatically covers weekly runs too — no change needed there).
- `episodes.status` CHECK values are exactly: `generating`, `ready`, `error`. `episodes.kind` CHECK values are exactly: `daily`, `weekly` — this plan inserts `weekly` rows for the first time; `daily` rows are unaffected.
- **Deliberate deviation from the daily-brief plan's constraint** ("neither `generate-podcast` nor `podcast-feed` takes a JSON request body"): `generate-podcast` now parses `req.json()` to read `mode`. Unlike `distill-insights` (which 400s if `mode` is missing/invalid), `generate-podcast` MUST default to `'daily'` on a missing/absent/invalid `mode` — the existing `podcast-daily-brief` pg_cron job sends `body := '{}'::jsonb` (no `mode` key at all) and must keep working unmodified. Do not make `mode` required or reject empty bodies.
- `synthesizeDialogue`'s per-turn ElevenLabs calls MUST be sequential (`for...of` with `await`), never concurrent — same reasoning as the daily brief's chunk sequencing (preserves buffer order for correct MP3 concatenation; avoids the concurrent-request rate-limit failures seen in the YouTube ingestion work).
- Weekly window is `now() - 7 days` to `now()` (a rolling 7-day window, not a calendar Monday-to-Monday span) — computed once per run as `weekStartISO`.
- `duration_seconds` is estimated as `round(word_count / 150 * 60)` across all turns' text — no audio-decoding dependency, same as daily.
- Storage bucket: `podcast-episodes` (existing, unchanged), object path `{episode_id}.mp3` (existing convention, unchanged).
- **Known unknowns, flagged not hidden:**
  - `ELEVENLABS_VOICE_ID_A` defaults in code to `ErXwobaYiN019PkySvjV` ("Antoni") and `ELEVENLABS_VOICE_ID_B` defaults to `21m00Tcm4TlvDq8ikWAM` ("Rachel") — two distinct stable ElevenLabs premade voice IDs, picked for audible contrast with each other and with the daily brief's `ELEVENLABS_VOICE_ID` ("Adam"). **Unverified by ear.** The implementer MUST listen to Task 1's first real synthesized episode and swap either voice ID (env var override, no code change needed) if the pairing doesn't work.
  - Per-episode ElevenLabs call count for a 15–20 min dialogue (potentially 60–100+ short turns) is unmeasured against EJ's account tier's rate limits. Task 1's live verification is the first real signal; if a call 429s, the fix is to add a short delay between turns, not to add retry-with-backoff speculatively (same guidance the daily-brief plan gave for its own chunk-level 429 risk).
- One new pair of secrets this plan depends on, which EJ must set (cannot be created by an agent — `ELEVENLABS_API_KEY` already exists from the daily brief and is reused as-is, no new key needed there):
  - `ELEVENLABS_VOICE_ID_A`, `ELEVENLABS_VOICE_ID_B` — optional; code defaults apply if unset (see above). Only need to be set explicitly if EJ wants different voices from the defaults.
  Set via `supabase secrets set ELEVENLABS_VOICE_ID_A=... ELEVENLABS_VOICE_ID_B=...` if overriding. If not set, Task 1's live verification proceeds using the code defaults — this is expected, not a blocker.
- Full spec: `docs/superpowers/specs/2026-08-20-podcast-weekly-deep-dive-design.md`.

---

### Task 1: `_shared/tts.ts` two-voice synthesis + `generate-podcast` weekly mode

**Files:**
- Modify: `supabase/functions/_shared/tts.ts` (full rewrite)
- Modify: `supabase/functions/generate-podcast/index.ts` (full rewrite)

**Interfaces:**
- Consumes: `sendAlert(supabase, jobName, message)` from `_shared/alert.ts` (existing, unchanged); `episodes`, `insights`, `insight_sources`, `open_questions`, `articles`, `pipeline_runs` tables (existing schema, unchanged).
- Produces: `synthesizeDialogue(turns: DialogueTurn[], apiKey: string, voiceIds: {A: string, B: string}): Promise<Uint8Array>` exported from `_shared/tts.ts`, where `DialogueTurn = {speaker: 'A'|'B', text: string}` (also exported from `_shared/tts.ts`). `generate-podcast`'s `Deno.serve` handler now branches on `mode` read from the request body.

- [ ] **Step 1: Rewrite `_shared/tts.ts`**

```typescript
/**
 * ElevenLabs text-to-speech helper — chunks a script to stay under
 * ElevenLabs' per-request character ceiling, synthesizes each chunk in
 * order, and concatenates the resulting MP3 buffers. Also supports
 * two-voice dialogue synthesis (one ElevenLabs call per speaker turn,
 * used by generate-podcast's weekly deep dive).
 */

const ELEVENLABS_TTS_API = 'https://api.elevenlabs.io/v1/text-to-speech'
const CHUNK_CHAR_LIMIT = 4500

export interface DialogueTurn {
  speaker: 'A' | 'B'
  text: string
}

export function chunkScript(script: string, limit = CHUNK_CHAR_LIMIT): string[] {
  const paragraphs = script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para
    if (candidate.length > limit && current) {
      chunks.push(current)
      current = para
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks
}

async function synthesizeChunk(text: string, apiKey: string, voiceId: string): Promise<Uint8Array> {
  const res = await fetch(`${ELEVENLABS_TTS_API}/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS error ${res.status}: ${await res.text()}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

function concatenateBuffers(buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const b of buffers) {
    merged.set(b, offset)
    offset += b.length
  }
  return merged
}

export async function synthesizeSpeech(
  script: string,
  apiKey: string,
  voiceId: string,
): Promise<Uint8Array> {
  const chunks = chunkScript(script)
  if (!chunks.length) throw new Error('synthesizeSpeech: script produced zero chunks')

  const buffers: Uint8Array[] = []
  for (const chunk of chunks) {
    buffers.push(await synthesizeChunk(chunk, apiKey, voiceId))
  }
  return concatenateBuffers(buffers)
}

export async function synthesizeDialogue(
  turns: DialogueTurn[],
  apiKey: string,
  voiceIds: { A: string; B: string },
): Promise<Uint8Array> {
  if (!turns.length) throw new Error('synthesizeDialogue: turns array is empty')

  const buffers: Uint8Array[] = []
  for (const turn of turns) {
    const voiceId = voiceIds[turn.speaker]
    const pieces = turn.text.length > CHUNK_CHAR_LIMIT ? chunkScript(turn.text) : [turn.text]
    for (const piece of pieces) {
      buffers.push(await synthesizeChunk(piece, apiKey, voiceId))
    }
  }
  return concatenateBuffers(buffers)
}
```

This is a refactor of the existing daily-brief file: `chunkScript` and `synthesizeSpeech` keep their exact prior signatures and behavior (the per-request fetch logic is extracted into the new internal `synthesizeChunk` helper, reused by both `synthesizeSpeech` and the new `synthesizeDialogue`). The daily brief's call site in `generate-podcast` needs no changes for this file.

- [ ] **Step 2: Rewrite `generate-podcast/index.ts`**

```typescript
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
import { synthesizeSpeech, synthesizeDialogue, type DialogueTurn } from '../_shared/tts.ts'

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
```

Note: the daily path's Storage-upload block is now factored into the shared `uploadEpisodeAudio` helper (used by both `generateDailyEpisode` and `generateWeeklyEpisode`) instead of being duplicated — this is a same-file refactor of code this task is already fully rewriting, not a separate cross-file change.

- [ ] **Step 3: Deploy**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy generate-podcast
```

Expected: `Deployed Functions on project oqxxmdyyfjgigfjtposv: generate-podcast`.

- [ ] **Step 4: Set voice secrets (optional — see Global Constraints)**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase secrets set ELEVENLABS_VOICE_ID_A=<voice id> ELEVENLABS_VOICE_ID_B=<voice id>
```

Skip this step if using the code defaults (`ErXwobaYiN019PkySvjV` / `21m00Tcm4TlvDq8ikWAM`) — that's expected and fine for first verification.

- [ ] **Step 5: Invoke weekly mode and verify**

```bash
cd pipeline && python3 -c "
import os, urllib.request, json
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path('.') / '.env')
url = os.environ['SUPABASE_URL'] + '/functions/v1/generate-podcast'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
req = urllib.request.Request(url, method='POST', headers={
    'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'apikey': key,
}, data=json.dumps({'mode': 'weekly'}).encode())
with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.status, resp.read().decode())
"
```

Expected: `200 {"ok":true,"message":"generate-podcast (weekly) started in background"}`.

Then poll for completion and inspect:

```bash
cd pipeline && python3 -c "
import os, time
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

for _ in range(30):
    rows = sb.table('pipeline_runs').select('*').eq('job_name', 'generate-podcast').order('started_at', desc=True).limit(3).execute()
    weekly = next((r for r in rows.data if (r.get('metadata') or {}).get('mode') == 'weekly'), None)
    if weekly and weekly['completed_at']:
        print('run:', weekly['status'], weekly['metadata'], weekly.get('error_message'))
        break
    time.sleep(15)
else:
    print('TIMEOUT still running')

eps = sb.table('episodes').select('id, kind, title, status, audio_url, duration_seconds, error_message').eq('kind', 'weekly').order('created_at', desc=True).limit(1).execute()
print('latest weekly episode:', eps.data)
"
```

Expected: run `status: success`; latest weekly episode `status: 'ready'` with a non-null `audio_url` (or, if the knowledge layer has zero promoted/contested/reinforced insights and zero open questions right now — plausible this early per the spec's §8 risk note — run `status: success` with `metadata: {'skipped': 'no_content', ...}` and no new weekly episode row; both are correct outcomes, not failures. If it skips, this step cannot fully verify TTS/audio — note that in your report and re-run this step once the knowledge layer has accumulated some weekly activity, ideally after a real Monday `distill-insights` weekly run).

Once a `'ready'` weekly episode exists, open its `audio_url` in a browser and listen to at least the first two minutes — confirm two distinct voices alternate (not one voice reading both parts), the pacing sounds like dialogue rather than monologue, and ElevenLabs didn't 429 mid-synthesis (if it did, see Global Constraints' note on turn-count/rate limits).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/tts.ts supabase/functions/generate-podcast/index.ts
git commit -m "feat: add weekly deep dive mode to generate-podcast, two-voice TTS synthesis"
```

---

### Task 2: Schedule weekly mode via pg_cron

**Files:**
- Modify: `supabase/pg_cron_podcast.sql` (full rewrite)

**Interfaces:**
- Consumes: `generate-podcast` function with `mode='weekly'` support (Task 1), `_pipeline_config` table (existing, keys `supabase_url`/`supabase_anon_key`).

- [ ] **Step 1: Rewrite the cron SQL file**

```sql
-- ============================================================
-- EJ Newsfeed — pg_cron Schedule for Podcast Generation
-- Run in Supabase SQL Editor → New Query
-- (Requires pg_cron and pg_net already enabled from pg_cron.sql)
-- ============================================================
--
-- Daily brief fires 5 minutes after distill-insights' daily run (22:30
-- UTC). Weekly deep dive fires 15 minutes after distill-insights' weekly
-- run (Mondays 13:00 UTC), so it reflects that run's freshly-applied
-- promote/merge/contest/reject decisions. All times UTC.
-- ============================================================

SELECT cron.schedule(
  'podcast-daily-brief',
  '35 22 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/generate-podcast',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'podcast-weekly-deep-dive',
  '15 13 * * 1',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/generate-podcast',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"weekly"}'::jsonb
    );
  $$
);

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname IN ('podcast-daily-brief', 'podcast-weekly-deep-dive')
ORDER BY jobname;
```

`cron.schedule()` upserts by job name, so re-running the existing `podcast-daily-brief` block is a safe no-op re-application, not a duplicate.

- [ ] **Step 2: Apply manually**

Open the Supabase SQL Editor and run the contents of `supabase/pg_cron_podcast.sql`. Confirm the final `SELECT` shows two rows: `podcast-daily-brief` (`35 22 * * *`, `active = true`) and `podcast-weekly-deep-dive` (`15 13 * * 1`, `active = true`).

- [ ] **Step 3: Commit**

```bash
git add supabase/pg_cron_podcast.sql
git commit -m "feat: schedule generate-podcast weekly deep dive via pg_cron"
```

---

## After this plan lands

Update `knowledge-center-plan.md`'s Phase 2 entry (weekly deep dive line, currently `⏸️ not started`) once this ships and has run for at least one real Monday — matching how the daily brief's and Phase 1a's entries were updated in-place after those shipped. Not a task here since it's documentation bookkeeping on a different file, not part of this feature's own deliverable.
