# Podcast Daily Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a daily ~5–20 minute audio news brief, unattended each evening, from that day's `daily_summaries`, and deliver it as a private podcast-app RSS feed EJ can subscribe to once.

**Architecture:** Two new Edge Functions mirroring the existing pipeline's shape. `generate-podcast` (triggered by pg_cron after the evening `distill-insights` run) queries the day's `daily_summaries` + top articles per category, writes one continuous script via a single Claude call, synthesizes it via ElevenLabs TTS (chunked and concatenated), uploads the MP3 to Supabase Storage, and inserts an `episodes` row. `podcast-feed` serves those rows as a token-gated RSS 2.0 feed. Both follow the `pipeline_runs` logging + `sendAlert` failure pattern already used by `process-videos`/`distill-insights`.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres + Supabase Storage (via SQL Editor — no migration tooling in this repo), Claude API (`claude-sonnet-4-6`), ElevenLabs TTS API.

## Global Constraints

- Claude model: `claude-sonnet-4-6` (matches every other edge function in this repo).
- Every external `fetch` call (Claude, ElevenLabs) MUST set an `AbortSignal.timeout(...)`.
- Reuse `supabase/functions/_shared/alert.ts`'s `sendAlert(supabase, jobName, message)` for failure alerts — do not write a new local copy.
- Every job logs to the existing `pipeline_runs` table (`job_name` values: `generate-podcast`). Do not create a new run-log table.
- `episodes.status` CHECK values are exactly: `generating`, `ready`, `error`. `episodes.kind` CHECK values are exactly: `daily`, `weekly` — this plan only ever inserts `daily` rows (`kind` exists now so the future weekly deep-dive spec reuses this table without a migration).
- Neither `generate-podcast` nor `podcast-feed` takes a JSON request body — do not add `req.json()` parsing to either handler. `podcast-feed` reads its one parameter (`token`) from the query string.
- `generate-podcast` uses `EdgeRuntime.waitUntil` background-task pattern (matches `process-videos`) since script generation + TTS synthesis can run past a typical request timeout.
- **ElevenLabs TTS chunks are synthesized sequentially (`for...of` with `await`), never concurrently.** Order must be preserved for correct MP3 concatenation, and sequential calls avoid the kind of rate-limit failures Supadata produced under concurrent load in the YouTube ingestion work. Chunk limit: 4500 characters, split only on paragraph boundaries (`\n\n`), never mid-sentence.
- `duration_seconds` is estimated as `round(word_count / 150 * 60)` — no audio-decoding dependency. Do not add one.
- Storage bucket: `podcast-episodes`, public, object path is exactly `{episode_id}.mp3`.
- **`podcast-feed` MUST be deployed with `--no-verify-jwt`.** Every other function in this repo relies on Supabase's default JWT verification (callers send a Supabase anon/service-role key as `Authorization: Bearer ...` — true for every existing `pg_cron` job and every manual invocation in this repo's plans). A real podcast app fetching the RSS feed URL cannot send a Supabase key; it does a plain unauthenticated `GET`. Without `--no-verify-jwt`, Supabase's gateway would reject that request with 401 before `podcast-feed`'s own `token` query-param check ever runs, silently breaking the one thing this function exists to do. This is the only function in the repo that needs this flag — do not apply it to `generate-podcast` or anything else, since those are only ever called by `pg_cron` (which does send the anon key).
- "Today" is computed identically to `process-emails`: `new Date().toISOString().slice(0, 10)`. Article/category queries use the exact `.gte('published_at', '${date}T00:00:00.000Z').lte('published_at', '${date}T23:59:59.999Z')` range pattern already used in `process-emails/index.ts` — reuse this pattern, don't invent a different date-boundary approach.
- If `daily_summaries` has zero rows for today, `generate-podcast` must exit cleanly with `pipeline_runs.status = 'success'` and `metadata: { skipped: 'no_content', date: todayISO }` — this is not an error condition (e.g. a pipeline outage day).
- **Known unknowns, flagged not hidden:**
  - `ELEVENLABS_VOICE_ID` defaults in code to `pNInz6obpgDQGcFmaJgB` ("Adam", a stable ElevenLabs premade voice ID chosen for a clear, neutral news-narration tone) but is **unverified by ear** — the implementer MUST listen to Task 2's first real synthesized episode and swap the voice ID (env var override, no code change needed) if it doesn't suit a daily news brief.
  - ElevenLabs' exact per-character pricing/rate limits on EJ's account tier have not been checked against real usage — Task 2's live verification is the first real signal; if a request 429s, the fix is to widen the pacing (e.g. a short delay between chunks), not to add retry-with-backoff speculatively.
- Two secrets this plan depends on do not exist yet as Supabase secrets and require EJ to obtain/generate them — they cannot be created by an agent:
  - `ELEVENLABS_API_KEY` — from EJ's existing ElevenLabs account (Profile → API Keys).
  - `PODCAST_FEED_TOKEN` — any random string EJ generates (e.g. `openssl rand -hex 24`) and keeps private; it's the feed URL's only gate.
  Set both via `supabase secrets set ELEVENLABS_API_KEY=... PODCAST_FEED_TOKEN=...` before Task 2/3's live verification steps. If not yet set when a task reaches its verify step, deploy the code regardless, report `NEEDS_CONTEXT` for that specific verification step, and move on — do not skip writing/deploying the code.
- Full spec: `docs/superpowers/specs/2026-08-20-podcast-daily-brief-design.md`.

---

### Task 1: Schema + Storage bucket migration

**Files:**
- Create: `supabase/podcast_schema.sql`

**Interfaces:**
- Produces: `episodes` table with columns `id, kind, title, script, audio_url, duration_seconds, published_at, status, error_message, created_at` — every later task reads/writes these exact names. Also produces the `podcast-episodes` Storage bucket (public).

- [ ] **Step 1: Write the schema SQL file**

```sql
-- ============================================================
-- EJ Newsfeed — Podcast Daily Brief Schema
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- episodes is populated by the generate-podcast Edge Function and read
-- by podcast-feed to build the RSS feed. kind is included now so a
-- future weekly deep-dive spec reuses this table without a migration;
-- only 'daily' rows are produced today.
-- ============================================================

CREATE TABLE episodes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily','weekly')),
  title            TEXT NOT NULL,
  script           TEXT NOT NULL,
  audio_url        TEXT,
  duration_seconds INT,
  published_at     TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'generating'
                   CHECK (status IN ('generating','ready','error')),
  error_message    TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_episodes_published ON episodes(published_at DESC) WHERE status = 'ready';

ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_all_episodes" ON episodes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── Storage bucket for episode audio ─────────────────────────────────────
-- Public bucket: object paths are unguessable episode UUIDs, and the feed
-- itself is token-gated (see podcast-feed function) — same trust model as
-- the RSS feed, not real access control. Public buckets serve objects via
-- /storage/v1/object/public/... without going through RLS, so no
-- storage.objects policy is needed for read access.

INSERT INTO storage.buckets (id, name, public)
VALUES ('podcast-episodes', 'podcast-episodes', true)
ON CONFLICT (id) DO NOTHING;

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'episodes' ORDER BY ordinal_position;

SELECT id, name, public FROM storage.buckets WHERE id = 'podcast-episodes';
```

- [ ] **Step 2: Apply the SQL manually**

Open the Supabase SQL Editor for project `oqxxmdyyfjgigfjtposv` and run the contents of `supabase/podcast_schema.sql`. This cannot be done via the CLI in this repo (no migration tooling) — it must be pasted and run in the editor, same as every other `supabase/*.sql` file here.

- [ ] **Step 3: Verify from the repo**

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

r = sb.table('episodes').select('*').limit(1).execute()
print('episodes table reachable, 0 rows expected:', r.data)
"
```

Expected: `episodes table reachable, 0 rows expected: []` with no error. If the table doesn't exist, Step 2 wasn't applied — go back and run it.

- [ ] **Step 4: Commit**

```bash
git add supabase/podcast_schema.sql
git commit -m "feat: add episodes table and podcast-episodes storage bucket"
```

---

### Task 2: `_shared/tts.ts` + `generate-podcast` — script generation and audio synthesis

**Files:**
- Create: `supabase/functions/_shared/tts.ts`
- Create: `supabase/functions/generate-podcast/index.ts`

**Interfaces:**
- Consumes: `sendAlert(supabase, jobName, message)` from `_shared/alert.ts` (existing); `episodes` table from Task 1; `daily_summaries`, `categories`, `articles` tables (existing schema).
- Produces: `chunkScript(script: string, limit?: number): string[]` and `synthesizeSpeech(script: string, apiKey: string, voiceId: string): Promise<Uint8Array>` from `_shared/tts.ts` — the future weekly deep-dive spec is expected to reuse `synthesizeSpeech`. `generate-podcast`'s HTTP contract: `POST /functions/v1/generate-podcast` with no body, `{"ok":true,"message":"generate-podcast started in background"}` immediate response, real result written to `pipeline_runs`/`episodes`.

- [ ] **Step 1: Write `_shared/tts.ts`**

```ts
/**
 * ElevenLabs text-to-speech helper — chunks a script to stay under
 * ElevenLabs' per-request character ceiling, synthesizes each chunk in
 * order, and concatenates the resulting MP3 buffers.
 */

const ELEVENLABS_TTS_API = 'https://api.elevenlabs.io/v1/text-to-speech'
const CHUNK_CHAR_LIMIT = 4500

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

export async function synthesizeSpeech(
  script: string,
  apiKey: string,
  voiceId: string,
): Promise<Uint8Array> {
  const chunks = chunkScript(script)
  if (!chunks.length) throw new Error('synthesizeSpeech: script produced zero chunks')

  const buffers: Uint8Array[] = []
  for (const chunk of chunks) {
    const res = await fetch(`${ELEVENLABS_TTS_API}/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: chunk,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      throw new Error(`ElevenLabs TTS error ${res.status}: ${await res.text()}`)
    }
    buffers.push(new Uint8Array(await res.arrayBuffer()))
  }

  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const b of buffers) {
    merged.set(b, offset)
    offset += b.length
  }
  return merged
}
```

- [ ] **Step 2: Write `generate-podcast/index.ts`**

```ts
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
  const script = (data.content?.[0]?.text || '').trim()
  if (!script) throw new Error('Claude returned an empty script')
  return script
}
```

- [ ] **Step 3: Deploy**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy generate-podcast
```

Expected: `Deployed Functions on project oqxxmdyyfjgigfjtposv: generate-podcast`.

- [ ] **Step 4: Set secrets (if not already set — see Global Constraints)**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase secrets set ELEVENLABS_API_KEY=<EJ's key from ElevenLabs dashboard>
```

If this hasn't been provided, report `NEEDS_CONTEXT: ELEVENLABS_API_KEY` and continue to Step 5 anyway — deploying doesn't require the secret to exist yet, only invoking does.

- [ ] **Step 5: Invoke and verify**

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
}, data=b'{}')
with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.status, resp.read().decode())
"
```

Expected: `200 {"ok":true,"message":"generate-podcast started in background"}`.

Then poll for completion and inspect:

```bash
cd pipeline && python3 -c "
import os, time
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

for _ in range(24):
    rows = sb.table('pipeline_runs').select('*').eq('job_name', 'generate-podcast').order('started_at', desc=True).limit(1).execute()
    r = rows.data[0]
    if r['completed_at']:
        print('run:', r['status'], r['metadata'], r.get('error_message'))
        break
    time.sleep(10)
else:
    print('TIMEOUT still running')

eps = sb.table('episodes').select('id, kind, title, status, audio_url, duration_seconds, error_message').order('created_at', desc=True).limit(1).execute()
print('latest episode:', eps.data)
"
```

Expected: run `status: success`; latest episode `status: 'ready'` with a non-null `audio_url` (or, if today's `daily_summaries` is empty, run `status: success` with `metadata: {'skipped': 'no_content', ...}` and no new episode row — both are correct outcomes, not failures).

If `ELEVENLABS_API_KEY` wasn't set (Step 4 `NEEDS_CONTEXT`), this step will show `status: error` with an error message about the missing/invalid key — that's expected until the secret is provided; re-run this step once it is. Once a `'ready'` episode exists, actually open `audio_url` in a browser and listen to at least the first minute — confirm it sounds right and that ElevenLabs' response didn't 429 mid-synthesis (if it did, see Global Constraints' note on pacing).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/tts.ts supabase/functions/generate-podcast/index.ts
git commit -m "feat: add generate-podcast edge function, script + TTS synthesis"
```

---

### Task 3: `podcast-feed` — RSS delivery

**Files:**
- Create: `supabase/functions/podcast-feed/index.ts`

**Interfaces:**
- Consumes: `episodes` table (Task 1), `PODCAST_FEED_TOKEN` secret.
- Produces: `GET /functions/v1/podcast-feed?token=<PODCAST_FEED_TOKEN>` → RSS 2.0 XML, `Content-Type: application/rss+xml`.

- [ ] **Step 1: Write `podcast-feed/index.ts`**

```ts
/**
 * podcast-feed — Supabase Edge Function
 * ==========================================
 * Serves the episodes table as an RSS 2.0 + iTunes-namespace feed so any
 * podcast app can subscribe. Gated by a static token query param — not
 * real auth, just keeps the feed off crawlers/search (see design spec §6).
 *
 * GET /functions/v1/podcast-feed?token=<PODCAST_FEED_TOKEN>
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface EpisodeRow {
  id: string
  title: string
  audio_url: string
  duration_seconds: number | null
  published_at: string
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  const expectedToken = Deno.env.get('PODCAST_FEED_TOKEN')

  if (!expectedToken || token !== expectedToken) {
    return new Response('Forbidden', { status: 403 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: episodes, error } = await supabase
    .from('episodes')
    .select('id, title, audio_url, duration_seconds, published_at')
    .eq('status', 'ready')
    .order('published_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('podcast-feed query error:', error)
    return new Response('Internal Server Error', { status: 500 })
  }

  const xml = buildRssXml((episodes || []) as EpisodeRow[])
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  })
})

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatItunesDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

function buildRssXml(episodes: EpisodeRow[]): string {
  const items = episodes
    .map((ep) => `
    <item>
      <title>${escapeXml(ep.title)}</title>
      <enclosure url="${escapeXml(ep.audio_url)}" type="audio/mpeg" />
      <guid isPermaLink="false">${ep.id}</guid>
      <pubDate>${new Date(ep.published_at).toUTCString()}</pubDate>
      <itunes:duration>${formatItunesDuration(ep.duration_seconds ?? 0)}</itunes:duration>
    </item>`)
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>EJ Daily Brief</title>
    <description>A daily audio brief distilled from EJ's knowledge feed.</description>
    <language>en-us</language>
    <itunes:explicit>false</itunes:explicit>${items}
  </channel>
</rss>`
}
```

- [ ] **Step 2: Deploy with JWT verification disabled**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy podcast-feed --no-verify-jwt
```

Expected: `Deployed Functions on project oqxxmdyyfjgigfjtposv: podcast-feed`. This is the one function in the repo deployed this way — see Global Constraints for why.

- [ ] **Step 3: Set the feed token secret and save it locally for testing**

```bash
cd /Users/ejjung/Dev/ejnewsfeed
TOKEN=$(openssl rand -hex 24)
supabase secrets set PODCAST_FEED_TOKEN=$TOKEN
echo "PODCAST_FEED_TOKEN=$TOKEN" >> pipeline/.env
echo "Generated token: $TOKEN"
```

If EJ wants to choose/record the token themselves rather than a generated one, use their value for both the `secrets set` call and the `pipeline/.env` line instead. Report `NEEDS_CONTEXT: PODCAST_FEED_TOKEN` if this can't be run yet, and continue.

- [ ] **Step 4: Invoke and verify — with NO Authorization header, matching how a real podcast app calls it**

```bash
cd pipeline && python3 -c "
import os, urllib.request, urllib.error
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb_url = os.environ['SUPABASE_URL']
token = os.environ['PODCAST_FEED_TOKEN']

# Deliberately no Authorization/apikey header — this is what proves
# --no-verify-jwt actually took effect and a real podcast app can reach it.
req = urllib.request.Request(f'{sb_url}/functions/v1/podcast-feed?token={token}')
with urllib.request.urlopen(req, timeout=15) as resp:
    body = resp.read().decode()
    print(resp.status, resp.headers.get('Content-Type'))
    print(body[:500])

# Wrong token must still be rejected by our own check, not Supabase's gateway
try:
    urllib.request.urlopen(
        urllib.request.Request(f'{sb_url}/functions/v1/podcast-feed?token=wrong'), timeout=15,
    )
    print('FAIL: wrong token was not rejected')
except urllib.error.HTTPError as e:
    print('wrong token correctly rejected:', e.code)
"
```

Expected: first request `200 application/rss+xml; charset=utf-8` with valid-looking RSS XML containing a `<channel>` and, if Task 2 produced a `'ready'` episode, one `<item>` with an `<enclosure>` pointing at the Storage URL. Second request: `wrong token correctly rejected: 403`. If the first request instead comes back `401` from Supabase's gateway (not our function's own 403 body), `--no-verify-jwt` didn't take — re-run Step 2's deploy command and confirm the CLI output doesn't warn about JWT verification.

Once confirmed, add the real feed URL (`https://oqxxmdyyfjgigfjtposv.supabase.co/functions/v1/podcast-feed?token=<real token>`) to a podcast app and confirm the episode shows up and plays.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/podcast-feed/index.ts
git commit -m "feat: add podcast-feed edge function, private RSS delivery"
```

---

### Task 4: Schedule via pg_cron

**Files:**
- Create: `supabase/pg_cron_podcast.sql`

**Interfaces:**
- Consumes: `generate-podcast` function (Task 2), `_pipeline_config` table (existing, keys `supabase_url`/`supabase_anon_key`).

- [ ] **Step 1: Write the cron SQL file**

```sql
-- ============================================================
-- EJ Newsfeed — pg_cron Schedule for Podcast Daily Brief
-- Run in Supabase SQL Editor → New Query
-- (Requires pg_cron and pg_net already enabled from pg_cron.sql)
-- ============================================================
--
-- Fires 5 minutes after distill-insights' daily run (22:30 UTC), so the
-- brief reflects the full day including that run's freshly-extracted
-- insights context. All times UTC.
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

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'podcast-daily-brief';
```

- [ ] **Step 2: Apply manually**

Open the Supabase SQL Editor and run the contents of `supabase/pg_cron_podcast.sql`. Confirm the final `SELECT` shows one row: `podcast-daily-brief`, `35 22 * * *`, `active = true`.

- [ ] **Step 3: Commit**

```bash
git add supabase/pg_cron_podcast.sql
git commit -m "feat: schedule generate-podcast daily brief via pg_cron"
```

---

## After this plan lands

Update `knowledge-center-plan.md`'s Phase 2 entry and its §1 AI stack decision line (OpenAI → ElevenLabs for TTS) once this ships — matching how Phase 1a's YouTube entry was updated in-place after that work completed. Not a task here since it's documentation bookkeeping on a different file, not part of this feature's own deliverable.
