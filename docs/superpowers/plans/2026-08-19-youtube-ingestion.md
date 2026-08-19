# YouTube Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest 8 subscribed YouTube channels as a new content lane — detect new uploads, filter by duration before spending any transcript credit, transcribe via a hosted API, categorize via Claude, and write them into `articles` exactly like newsletter-derived content, so `daily_summaries`, `distill-insights`, and the Knowledge view all treat a video as just another item.

**Architecture:** A new, parallel ingestion lane that never touches the existing newsletter lane (`fetch-emails`/`process-emails` are unmodified). `fetch-videos` is one Edge Function with three modes (`poll` | `enrich` | `transcribe`) — mirroring `distill-insights`' daily/weekly mode pattern — backed by a new `raw_videos` buffer table (mirrors `raw_emails`). A separate `process-videos` function turns a fully-transcribed video into one `articles` row. `pg_cron` drives all four stages every 4 hours, staggered 15 minutes apart.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres (via Supabase SQL Editor — no migration tooling in this repo), Claude API (`claude-sonnet-4-6`), YouTube channel RSS (free), YouTube Data API v3 (free tier, metadata only), Supadata (hosted transcript API, paid).

## Global Constraints

- Claude model: `claude-sonnet-4-6` (matches every other edge function in this repo).
- Every external `fetch` call (RSS, YouTube Data API, Supadata, Claude) MUST set an `AbortSignal.timeout(...)` — an unguarded fetch can hang forever (this is the exact bug fixed in `process-emails` earlier this session).
- Any loop that makes more than one slow external call per invocation (Claude, transcript API) MUST run those calls concurrently via `Promise.allSettled`, never a sequential `for`/`await` loop — the same 5-minute EdgeRuntime background-execution ceiling that bit `process-emails` applies here.
- Guard `await req.json()` in every `Deno.serve` handler with a try/catch returning 400 on parse failure (a lesson from this session's Knowledge View branch — bake it in from the start here rather than fixing it later).
- Reuse `supabase/functions/_shared/alert.ts`'s `sendAlert(supabase, jobName, message)` for failure alerts — do not write a new local copy.
- Every job logs to the existing `pipeline_runs` table (`job_name` values: `fetch-videos` with `metadata: {mode, ...}`, and `process-videos`) — do not create a new run-log table.
- `raw_videos.status` CHECK values are exactly: `pending`, `enriched`, `too_short`, `transcribed`, `no_captions`, `error`, `processed`.
- `sources.source_type` CHECK values are exactly: `newsletter`, `youtube`, `rss`, `podcast`. This plan only ever inserts `youtube` rows.
- `articles.content_type` CHECK values are exactly: `newsletter`, `web_article`, `youtube`, `podcast`. This plan only ever inserts `youtube` rows.
- `min_duration_seconds` defaults to `300` (5 minutes) per-source, not a hardcoded constant.
- `impact_score` for video articles is **source-authority-only** (per spec §6d decision (b)) — map the video's source `tier` (`A`/`B`/`C`) to `1.0`/`0.6`/`0.3`, nothing else. Do not port `process-emails`' full weighted `computeImpactScore` formula.
- Do **not** build the map-reduce transcript-chunking safety valve mentioned in the spec (§6d) — single Claude call per video, full transcript, no truncation. Claude Sonnet's context window comfortably fits even a multi-hour transcript; chunking is explicitly deferred until a real video actually trips a limit.
- `process-videos` does **not** duplicate `process-emails`' daily-summary generation logic. `process-emails`' existing gap-detection (`articles.select('published_at')` with no `content_type` filter, already running every invocation) will pick up video-sourced article dates automatically on its next scheduled run — this is an intentional reliance on existing, unmodified behavior, not a gap. Do not add summary-generation code to `process-videos`.
- Two secrets this plan depends on — `YOUTUBE_DATA_API_KEY` and `SUPADATA_API_KEY` — do not exist yet as Supabase secrets and require the user to sign up for the respective services and obtain the keys themselves (account creation is outside what an agent can do). Tasks 4 and 5's live verification is blocked until these are set via `supabase secrets set <NAME>=<value>` (either the user runs this themselves, or hands the value to whoever's executing this plan to run it). Treat this exactly like this session's "SQL needs manual application" blockers: write and deploy the code regardless, report `NEEDS_CONTEXT` for the specific verification step that needs the key, and move on.
- **Known unknown, flagged not hidden:** Supadata's exact HTTP response shape for "no captions available" has not been verified against the real API (the spec's own Step 0 test videos don't guarantee hitting that case). Task 5's code guesses `404` as the no-captions signal — the implementer MUST verify this against a real video with captions disabled during live testing and adjust the check if Supadata's actual behavior differs. Do not silently ship an unverified guess as if it were confirmed.
- Full spec: `docs/superpowers/specs/2026-08-19-youtube-ingestion-design.md`.

---

### Task 1: Schema migration

**Files:**
- Create: `supabase/youtube_ingestion_schema.sql`

**Interfaces:**
- Produces: `sources.source_type/youtube_channel_id/feed_url/min_duration_seconds/last_polled_at` columns; `raw_videos` table with columns `id, youtube_video_id, source_id, title, description, url, thumbnail_url, published_at, duration_seconds, transcript, transcript_lang, status, attempts, error_message, processed, created_at`; `articles.content_type/raw_video_id/duration_seconds/thumbnail_url` columns — every later task reads/writes these exact names.

- [ ] **Step 1: Write the schema SQL file**

```sql
-- ============================================================
-- EJ Newsfeed — YouTube Ingestion Schema
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- Adds YouTube as a source type alongside newsletters. raw_videos
-- mirrors raw_emails as the ingestion buffer; articles gains
-- content_type + video-specific columns so a video row looks just
-- like any other article to daily_summaries/distill-insights/the
-- Knowledge view.
-- ============================================================

-- ── sources: describe non-email sources ─────────────────────────────────────

ALTER TABLE sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'newsletter'
  CHECK (source_type IN ('newsletter','youtube','rss','podcast'));
ALTER TABLE sources ADD COLUMN youtube_channel_id   TEXT UNIQUE;
ALTER TABLE sources ADD COLUMN feed_url             TEXT;
ALTER TABLE sources ADD COLUMN min_duration_seconds INT NOT NULL DEFAULT 300;
ALTER TABLE sources ADD COLUMN last_polled_at       TIMESTAMPTZ;

-- ── raw_videos: ingestion buffer (mirrors raw_emails) ───────────────────────

CREATE TABLE raw_videos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_video_id  TEXT UNIQUE NOT NULL,
  source_id         UUID REFERENCES sources(id),
  title             TEXT NOT NULL,
  description       TEXT,
  url               TEXT,
  thumbnail_url     TEXT,
  published_at      TIMESTAMPTZ,
  duration_seconds  INT,
  transcript        TEXT,
  transcript_lang   TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','enriched','too_short','transcribed',
                                      'no_captions','error','processed')),
  attempts          INT NOT NULL DEFAULT 0,
  error_message     TEXT,
  processed         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_raw_videos_status    ON raw_videos(status) WHERE processed = false;
CREATE INDEX idx_raw_videos_published ON raw_videos(published_at DESC);

ALTER TABLE raw_videos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_raw_videos" ON raw_videos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── articles: mark content type ──────────────────────────────────────────────

ALTER TABLE articles ADD COLUMN content_type TEXT NOT NULL DEFAULT 'newsletter'
  CHECK (content_type IN ('newsletter','web_article','youtube','podcast'));
ALTER TABLE articles ADD COLUMN raw_video_id     UUID REFERENCES raw_videos(id);
ALTER TABLE articles ADD COLUMN duration_seconds INT;
ALTER TABLE articles ADD COLUMN thumbnail_url    TEXT;

CREATE INDEX idx_articles_content_type ON articles(content_type);

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'sources' AND column_name IN
  ('source_type','youtube_channel_id','feed_url','min_duration_seconds','last_polled_at')
ORDER BY column_name;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'raw_videos' ORDER BY ordinal_position;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'articles' AND column_name IN
  ('content_type','raw_video_id','duration_seconds','thumbnail_url')
ORDER BY column_name;
```

- [ ] **Step 2: Apply the SQL manually**

This repo has no migration tooling — paste the full contents of `supabase/youtube_ingestion_schema.sql` into `https://supabase.com/dashboard/project/oqxxmdyyfjgigfjtposv/sql/new` and run it. The three verification `SELECT`s should return: 5 rows (sources columns), 15 rows (raw_videos columns), 4 rows (articles columns).

- [ ] **Step 3: Verify from the repo**

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

r = sb.table('raw_videos').select('*').limit(1).execute()
print('raw_videos -> OK, rows:', len(r.data))

s = sb.table('sources').select('source_type, youtube_channel_id, min_duration_seconds').limit(1).execute()
print('sources new columns -> OK')

a = sb.table('articles').select('content_type, raw_video_id, duration_seconds, thumbnail_url').limit(1).execute()
print('articles new columns -> OK')
"
```

Expected: all three print `-> OK` with no exceptions.

- [ ] **Step 4: Commit**

```bash
git add supabase/youtube_ingestion_schema.sql
git commit -m "feat: add YouTube ingestion schema (raw_videos, sources/articles columns)"
```

---

### Task 2: Seed YouTube channel sources

**Files:**
- Create: `supabase/youtube_sources_seed.sql`

**Interfaces:**
- Consumes: `sources` table from Task 1.
- Produces: 8 `sources` rows with `source_type='youtube'` — Task 3's poll mode queries exactly these.

- [ ] **Step 1: Write the seed SQL file**

```sql
-- ============================================================
-- EJ Newsfeed — YouTube Channel Sources Seed
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- The 8 channels from the design spec §2 (Lex Fridman excluded —
-- off-domain, 3-5hr episodes). ON CONFLICT makes this safe to re-run.
-- ============================================================

INSERT INTO sources (name, source_type, youtube_channel_id, website_url, min_duration_seconds, active)
VALUES
  ('Lenny''s Podcast',   'youtube', 'UC6t1O76G0jYXOAoYCm153dA', 'https://www.youtube.com/channel/UC6t1O76G0jYXOAoYCm153dA', 300, true),
  ('Dwarkesh Patel',     'youtube', 'UCXl4i9dYBrFOabk0xGmbkRA', 'https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA', 300, true),
  ('Matt Wolfe',         'youtube', 'UChpleBmo18P08aKCIgti38g', 'https://www.youtube.com/channel/UChpleBmo18P08aKCIgti38g', 300, true),
  ('Riley Brown',        'youtube', 'UCMcoud_ZW7cfxeIugBflSBw', 'https://www.youtube.com/channel/UCMcoud_ZW7cfxeIugBflSBw', 300, true),
  ('Matt Pocock',        'youtube', 'UCswG6FSbgZjbWtdf_hMLaow', 'https://www.youtube.com/channel/UCswG6FSbgZjbWtdf_hMLaow', 300, true),
  ('Two Minute Papers',  'youtube', 'UCbfYPyITQ-7l4upoX8nvctg', 'https://www.youtube.com/channel/UCbfYPyITQ-7l4upoX8nvctg', 300, true),
  ('Hamel Husain',       'youtube', 'UC__dUuqF5w4OnbW221JxmKg', 'https://www.youtube.com/channel/UC__dUuqF5w4OnbW221JxmKg', 300, true),
  ('AI Engineer',        'youtube', 'UCLKPca3kwwd-B59HNr-_lvA', 'https://www.youtube.com/channel/UCLKPca3kwwd-B59HNr-_lvA', 300, true)
ON CONFLICT (youtube_channel_id) DO NOTHING;

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT name, youtube_channel_id, min_duration_seconds, active
FROM sources WHERE source_type = 'youtube' ORDER BY name;
```

- [ ] **Step 2: Apply manually**

Paste into `https://supabase.com/dashboard/project/oqxxmdyyfjgigfjtposv/sql/new` and run. The verification `SELECT` should return 8 rows.

- [ ] **Step 3: Verify from the repo**

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
rows = sb.table('sources').select('name, youtube_channel_id').eq('source_type', 'youtube').execute()
print(f'{len(rows.data)} YouTube source(s):')
for r in rows.data:
    print(' -', r['name'], r['youtube_channel_id'])
"
```

Expected: 8 rows printed, matching the names/IDs above.

- [ ] **Step 4: Commit**

```bash
git add supabase/youtube_sources_seed.sql
git commit -m "feat: seed 8 YouTube channel sources"
```

---

### Task 3: `fetch-videos` — poll mode

**Files:**
- Create: `supabase/functions/fetch-videos/index.ts`

**Interfaces:**
- Consumes: `sendAlert` from `../_shared/alert.ts`; `sources` (Task 2) and `raw_videos` (Task 1) tables.
- Produces: `POST /functions/v1/fetch-videos` with body `{ mode: 'poll' }`. `runEnrich`/`runTranscribe` are stubs in this task — Tasks 4 and 5 replace them, in the same file.

- [ ] **Step 1: Write the poll-mode implementation**

```typescript
/**
 * fetch-videos — Supabase Edge Function
 * ========================================
 * poll:       RSS-poll subscribed YouTube channels, insert new uploads
 *             into raw_videos as 'pending'. Free, fast.
 * enrich:     look up duration via YouTube Data API, gate on
 *             sources.min_duration_seconds before any transcript spend.
 * transcribe: fetch transcripts for enriched videos via a hosted API.
 *
 * POST /functions/v1/fetch-videos
 * Body: { mode: 'poll' | 'enrich' | 'transcribe' }
 *
 * Schedule (pg_cron): every 4 hours, staggered — poll :00, enrich :10,
 * transcribe :25 (see supabase/pg_cron_youtube.sql).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { XMLParser } from 'https://esm.sh/fast-xml-parser@4'
import { sendAlert } from '../_shared/alert.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type Mode = 'poll' | 'enrich' | 'transcribe'

interface SourceRow {
  id: string
  youtube_channel_id: string
  min_duration_seconds: number
  last_polled_at: string | null
}

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

  if (mode !== 'poll' && mode !== 'enrich' && mode !== 'transcribe') {
    return new Response(JSON.stringify({ ok: false, error: 'mode must be "poll", "enrich", or "transcribe"' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: runRow } = await supabase
    .from('pipeline_runs')
    .insert({ job_name: 'fetch-videos', status: 'running', metadata: { mode } })
    .select('id')
    .single()
  const runId: string | null = (runRow as { id: string } | null)?.id ?? null

  const work = (mode === 'poll' ? runPoll(supabase) : mode === 'enrich' ? runEnrich(supabase) : runTranscribe(supabase))
    .then(async (result) => {
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(),
          status: 'success',
          metadata: { mode, ...result },
        }).eq('id', runId)
      }
      return { ok: true, mode, ...result }
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`fetch-videos (${mode}) fatal error:`, err)
      if (runId) {
        await supabase.from('pipeline_runs').update({
          completed_at: new Date().toISOString(),
          status: 'error',
          error_message: msg,
          metadata: { mode },
        }).eq('id', runId)
      }
      await sendAlert(supabase, 'fetch-videos', `fetch-videos (${mode}) crashed: ${msg}`)
      return { ok: false, error: msg }
    })

  // @ts-ignore — Deno Deploy global
  if (typeof EdgeRuntime !== 'undefined') {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
    return new Response(
      JSON.stringify({ ok: true, message: `fetch-videos (${mode}) started in background` }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  const result = await work
  return new Response(JSON.stringify(result), {
    status: (result as { ok: boolean }).ok === false ? 500 : 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})

// ── Poll mode ────────────────────────────────────────────────────────────

interface FeedEntry {
  videoId: string
  title: string
  description: string
  thumbnailUrl: string | null
  publishedAt: string
}

async function runPoll(supabase: ReturnType<typeof createClient>): Promise<{ sources_polled: number; videos_inserted: number }> {
  const { data: sources, error } = await supabase
    .from('sources')
    .select('id, youtube_channel_id, min_duration_seconds, last_polled_at')
    .eq('source_type', 'youtube')
    .eq('active', true)

  if (error) throw new Error(`Failed to load YouTube sources: ${error.message}`)
  const rows = (sources || []) as SourceRow[]

  const settled = await Promise.allSettled(rows.map((source) => pollOneChannel(supabase, source)))

  let videosInserted = 0
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') {
      videosInserted += s.value
    } else {
      console.error(`  ✗ Error polling source ${rows[i].id}: ${s.reason}`)
    }
  }

  return { sources_polled: rows.length, videos_inserted: videosInserted }
}

async function pollOneChannel(supabase: ReturnType<typeof createClient>, source: SourceRow): Promise<number> {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${source.youtube_channel_id}`
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`RSS fetch failed for ${source.youtube_channel_id}: ${res.status}`)

  const xml = await res.text()
  const entries = parseYouTubeFeed(xml)

  let inserted = await insertNewVideos(supabase, source.id, entries)

  // Overflow check: a full 15-entry window whose oldest item is still newer
  // than our last poll means the window didn't reach back far enough —
  // some uploads between last_polled_at and now may have been missed.
  const oldest = entries.length ? entries[entries.length - 1] : null
  if (entries.length >= 15 && oldest && source.last_polled_at && new Date(oldest.publishedAt) > new Date(source.last_polled_at)) {
    const backfilled = await backfillViaDataApi(supabase, source)
    inserted += backfilled
  }

  await supabase.from('sources').update({ last_polled_at: new Date().toISOString() }).eq('id', source.id)

  return inserted
}

// Parses a YouTube channel Atom feed. NOTE: fast-xml-parser's exact output
// shape (array-vs-object collapsing for a single <entry>, attribute key
// naming) has not been exercised against a live feed yet — verify this
// during Step 3's live test and adjust field access below if the actual
// parsed structure differs from what's assumed here.
function parseYouTubeFeed(xml: string): FeedEntry[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const feed = parser.parse(xml)
  const rawEntries = feed?.feed?.entry
  const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : []

  return entries.map((entry: Record<string, unknown>) => {
    const mediaGroup = (entry['media:group'] || {}) as Record<string, unknown>
    const thumbnail = (mediaGroup['media:thumbnail'] || {}) as Record<string, unknown>
    return {
      videoId: String(entry['yt:videoId'] ?? ''),
      title: String(entry['title'] ?? ''),
      description: String(mediaGroup['media:description'] ?? ''),
      thumbnailUrl: (thumbnail['@_url'] as string) ?? null,
      publishedAt: String(entry['published'] ?? ''),
    }
  }).filter((e) => e.videoId)
}

async function insertNewVideos(supabase: ReturnType<typeof createClient>, sourceId: string, entries: FeedEntry[]): Promise<number> {
  let inserted = 0
  for (const entry of entries) {
    const { error } = await supabase.from('raw_videos').insert({
      youtube_video_id: entry.videoId,
      source_id: sourceId,
      title: entry.title,
      description: entry.description,
      url: `https://www.youtube.com/watch?v=${entry.videoId}`,
      thumbnail_url: entry.thumbnailUrl,
      published_at: entry.publishedAt || null,
      status: 'pending',
    })
    // A unique-violation on youtube_video_id means we've already seen this
    // video — that's expected steady-state behavior, not a failure.
    if (!error) inserted++
    else if (!error.message.includes('duplicate key')) {
      console.error(`  ✗ Failed to insert video ${entry.videoId}: ${error.message}`)
    }
  }
  return inserted
}

async function backfillViaDataApi(supabase: ReturnType<typeof createClient>, source: SourceRow): Promise<number> {
  const apiKey = Deno.env.get('YOUTUBE_DATA_API_KEY')
  if (!apiKey) {
    console.error(`  ✗ Overflow detected for source ${source.id} but YOUTUBE_DATA_API_KEY is not set — skipping backfill`)
    return 0
  }

  const uploadsPlaylistId = 'UU' + source.youtube_channel_id.slice(2)
  const lastPolled = source.last_polled_at ? new Date(source.last_polled_at) : null

  let inserted = 0
  let pageToken: string | undefined
  for (let page = 0; page < 5; page++) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems')
    url.searchParams.set('part', 'contentDetails,snippet')
    url.searchParams.set('playlistId', uploadsPlaylistId)
    url.searchParams.set('maxResults', '50')
    url.searchParams.set('key', apiKey)
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      console.error(`  ✗ playlistItems backfill failed for ${source.id}: ${res.status}`)
      break
    }
    const data = await res.json()
    const items = (data.items || []) as Array<{ contentDetails: { videoId: string }; snippet: { title: string; description: string; publishedAt: string; thumbnails?: { default?: { url: string } } } }>

    const entries: FeedEntry[] = items.map((item) => ({
      videoId: item.contentDetails.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnailUrl: item.snippet.thumbnails?.default?.url ?? null,
      publishedAt: item.snippet.publishedAt,
    }))
    inserted += await insertNewVideos(supabase, source.id, entries)

    const oldestOnPage = items.length ? new Date(items[items.length - 1].snippet.publishedAt) : null
    pageToken = data.nextPageToken
    if (!pageToken || !oldestOnPage || (lastPolled && oldestOnPage <= lastPolled)) break
  }

  return inserted
}

// ── Enrich mode (Task 4) ─────────────────────────────────────────────────

async function runEnrich(_supabase: ReturnType<typeof createClient>): Promise<Record<string, unknown>> {
  throw new Error('enrich mode not implemented yet')
}

// ── Transcribe mode (Task 5) ─────────────────────────────────────────────

async function runTranscribe(_supabase: ReturnType<typeof createClient>): Promise<Record<string, unknown>> {
  throw new Error('transcribe mode not implemented yet')
}
```

- [ ] **Step 2: Deploy**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy fetch-videos
```

Expected: `Deployed Functions on project oqxxmdyyfjgigfjtposv: fetch-videos`.

- [ ] **Step 3: Invoke poll mode and verify**

```bash
cd pipeline && python3 -c "
import os, urllib.request, json
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path('.') / '.env')
url = os.environ['SUPABASE_URL'] + '/functions/v1/fetch-videos'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
req = urllib.request.Request(url, method='POST', headers={
    'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'apikey': key,
}, data=json.dumps({'mode': 'poll'}).encode())
with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.status, resp.read().decode())
"
```

Expected: `200 {"ok":true,"message":"fetch-videos (poll) started in background"}`.

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
    rows = sb.table('pipeline_runs').select('*').eq('job_name', 'fetch-videos').order('started_at', desc=True).limit(1).execute()
    r = rows.data[0]
    if r['completed_at']:
        print('run:', r['status'], r['metadata'])
        break
    time.sleep(5)
else:
    print('TIMEOUT still running')

videos = sb.table('raw_videos').select('youtube_video_id, title, status, published_at').order('published_at', desc=True).limit(20).execute()
print(f'{len(videos.data)} raw_videos row(s):')
for v in videos.data:
    print(' -', v['status'], v['published_at'], '|', v['title'][:60])
"
```

Expected: run `status: success`, `sources_polled: 8`. Some number of `raw_videos` rows with `status='pending'` should appear (each of the 8 channels' recent uploads). **If the parsed titles/video IDs look wrong or empty, `parseYouTubeFeed`'s assumed field names don't match `fast-xml-parser`'s real output — fix the field access based on what actually came back before proceeding.** Invoke poll mode a second time and confirm `videos_inserted: 0` (idempotent — no duplicates from the `youtube_video_id` unique constraint).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/fetch-videos/index.ts
git commit -m "feat: add fetch-videos edge function, RSS poll mode with overflow backfill"
```

---

### Task 4: `fetch-videos` — enrich mode

**Files:**
- Modify: `supabase/functions/fetch-videos/index.ts` (replace the `runEnrich` stub from Task 3)

**Interfaces:**
- Consumes: `SourceRow`-shaped data, `createClient`, `sendAlert` already in the file from Task 3.
- Produces: working `mode: 'enrich'` request path.

- [ ] **Step 1: Replace the `runEnrich` stub**

```typescript
// ── Enrich mode ──────────────────────────────────────────────────────────

function parseISO8601Duration(iso: string): number {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!match) return 0
  const [, h, m, s] = match
  return (parseInt(h || '0', 10) * 3600) + (parseInt(m || '0', 10) * 60) + parseInt(s || '0', 10)
}

async function runEnrich(supabase: ReturnType<typeof createClient>): Promise<{ enriched: number; too_short: number; errored: number }> {
  const apiKey = Deno.env.get('YOUTUBE_DATA_API_KEY')
  if (!apiKey) throw new Error('YOUTUBE_DATA_API_KEY is not set')

  const { data: pending, error: pendingErr } = await supabase
    .from('raw_videos')
    .select('id, youtube_video_id, source_id')
    .eq('status', 'pending')
    .limit(50)

  if (pendingErr) throw new Error(`Failed to load pending videos: ${pendingErr.message}`)
  const rows = (pending || []) as Array<{ id: string; youtube_video_id: string; source_id: string | null }>

  if (!rows.length) return { enriched: 0, too_short: 0, errored: 0 }

  const { data: sources } = await supabase
    .from('sources')
    .select('id, min_duration_seconds')
    .eq('source_type', 'youtube')
  const minDurationBySource = new Map(
    ((sources || []) as Array<{ id: string; min_duration_seconds: number }>).map((s) => [s.id, s.min_duration_seconds]),
  )

  const ids = rows.map((r) => r.youtube_video_id).join(',')
  const url = new URL('https://www.googleapis.com/youtube/v3/videos')
  url.searchParams.set('part', 'contentDetails,snippet')
  url.searchParams.set('id', ids)
  url.searchParams.set('key', apiKey)

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`videos.list failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const items = (data.items || []) as Array<{ id: string; contentDetails: { duration: string } }>
  const durationByVideoId = new Map(items.map((item) => [item.id, parseISO8601Duration(item.contentDetails.duration)]))

  let enriched = 0, tooShort = 0, errored = 0
  for (const row of rows) {
    const duration = durationByVideoId.get(row.youtube_video_id)
    if (duration === undefined) {
      await supabase.from('raw_videos').update({ status: 'error', error_message: 'video not found via Data API (deleted or private)' }).eq('id', row.id)
      errored++
      continue
    }
    const minDuration = (row.source_id && minDurationBySource.get(row.source_id)) ?? 300
    if (duration < minDuration) {
      await supabase.from('raw_videos').update({ status: 'too_short', duration_seconds: duration }).eq('id', row.id)
      tooShort++
    } else {
      await supabase.from('raw_videos').update({ status: 'enriched', duration_seconds: duration }).eq('id', row.id)
      enriched++
    }
  }

  return { enriched, too_short: tooShort, errored }
}
```

- [ ] **Step 2: Deploy**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy fetch-videos
```

- [ ] **Step 3: Invoke enrich mode and verify**

**Prerequisite:** `YOUTUBE_DATA_API_KEY` must be set as a Supabase secret (`supabase secrets set YOUTUBE_DATA_API_KEY=<value>`) before this step can run for real — per the Global Constraints, this requires the user to have created a Google Cloud API key first. If it isn't set yet, deploy anyway (Step 2 doesn't need it), then invoke and expect a `status: error` run with `error_message: "YOUTUBE_DATA_API_KEY is not set"` — report that as the outcome and treat it the same as this session's other external-dependency blockers, not a code defect.

```bash
cd pipeline && python3 -c "
import os, urllib.request, json
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path('.') / '.env')
url = os.environ['SUPABASE_URL'] + '/functions/v1/fetch-videos'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
req = urllib.request.Request(url, method='POST', headers={
    'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'apikey': key,
}, data=json.dumps({'mode': 'enrich'}).encode())
with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.status, resp.read().decode())
"
```

Then poll `pipeline_runs` (same pattern as Task 3 Step 3) and inspect:

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
rows = sb.table('raw_videos').select('title, status, duration_seconds').in_('status', ['enriched', 'too_short', 'error']).execute()
print(f'{len(rows.data)} enriched/too_short/error row(s):')
for r in rows.data:
    print(' -', r['status'], r['duration_seconds'], '|', r['title'][:60])
"
```

Expected (if the API key is set): `pipeline_runs` shows `status: success`; `raw_videos` rows have moved from `pending` to `enriched`/`too_short`/`error` with `duration_seconds` populated, and the split roughly matches the design's expectation that the 5-minute gate discards close to half of raw uploads (small sample sizes won't hit that ratio precisely — just confirm the mechanism works, not the exact split).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/fetch-videos/index.ts
git commit -m "feat: add fetch-videos enrich mode, duration-gate before transcript spend"
```

---

### Task 5: `_shared/transcript.ts` + `fetch-videos` — transcribe mode

**Files:**
- Create: `supabase/functions/_shared/transcript.ts`
- Modify: `supabase/functions/fetch-videos/index.ts` (replace the `runTranscribe` stub from Task 3, add an import)

**Interfaces:**
- Produces: `getTranscript(videoId: string): Promise<{ text: string; lang: string | null }>`, throws `NoCaptionsError` on missing captions — both exported from `_shared/transcript.ts` for `fetch-videos` to import.

- [ ] **Step 1: Write `_shared/transcript.ts`**

```typescript
/**
 * Shared transcript helper — abstracts the hosted transcript API behind
 * getTranscript(videoId), so swapping vendors (Supadata -> TranscriptAPI or
 * similar) is one file and one secret (TRANSCRIPT_PROVIDER), per the design
 * spec §4c. Only Supadata is implemented; TRANSCRIPT_PROVIDER is a seam,
 * not a working multi-provider switch yet.
 */

export interface TranscriptResult {
  text: string
  lang: string | null
}

export class NoCaptionsError extends Error {}

export async function getTranscript(videoId: string): Promise<TranscriptResult> {
  const provider = Deno.env.get('TRANSCRIPT_PROVIDER') || 'supadata'
  if (provider !== 'supadata') {
    throw new Error(`Unknown TRANSCRIPT_PROVIDER: ${provider}`)
  }
  return getSupadataTranscript(videoId)
}

// NOTE: Supadata's exact response shape for "no captions available" has not
// been verified against a real video with captions disabled — this treats a
// 404 status as the no-captions signal as a best guess. Verify this during
// live testing (Task 5, Step 3) and adjust if the real API behaves
// differently (e.g. a 200 with an empty/error field instead of a 404).
async function getSupadataTranscript(videoId: string): Promise<TranscriptResult> {
  const apiKey = Deno.env.get('SUPADATA_API_KEY')
  if (!apiKey) throw new Error('SUPADATA_API_KEY is not set')

  const res = await fetch(
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}&text=true`,
    { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(30_000) },
  )

  if (res.status === 404) {
    throw new NoCaptionsError(`No captions available for video ${videoId}`)
  }
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Supadata API error ${res.status}: ${body}`)
  }

  const data = await res.json()
  if (!data.content) {
    throw new NoCaptionsError(`Supadata returned no transcript content for video ${videoId}`)
  }
  return { text: data.content as string, lang: (data.lang as string) || null }
}
```

- [ ] **Step 2: Replace the `runTranscribe` stub in `fetch-videos/index.ts`**

Add the import near the top of the file, alongside the existing `sendAlert` import:

```typescript
import { getTranscript, NoCaptionsError } from '../_shared/transcript.ts'
```

Replace the stub:

```typescript
// ── Transcribe mode ──────────────────────────────────────────────────────

const MAX_ATTEMPTS = 4

async function runTranscribe(supabase: ReturnType<typeof createClient>): Promise<{ transcribed: number; no_captions: number; retried: number; errored: number }> {
  const { data: rows, error } = await supabase
    .from('raw_videos')
    .select('id, youtube_video_id, attempts')
    .eq('status', 'enriched')
    .lt('attempts', MAX_ATTEMPTS)
    .order('published_at', { ascending: true })
    .limit(15)

  if (error) throw new Error(`Failed to load enriched videos: ${error.message}`)
  const videos = (rows || []) as Array<{ id: string; youtube_video_id: string; attempts: number }>

  const settled = await Promise.allSettled(
    videos.map(async (video) => {
      try {
        const { text, lang } = await getTranscript(video.youtube_video_id)
        await supabase.from('raw_videos').update({
          transcript: text, transcript_lang: lang, status: 'transcribed',
        }).eq('id', video.id)
        return 'transcribed' as const
      } catch (err) {
        if (err instanceof NoCaptionsError) {
          await supabase.from('raw_videos').update({ status: 'no_captions' }).eq('id', video.id)
          return 'no_captions' as const
        }
        const nextAttempts = video.attempts + 1
        const msg = err instanceof Error ? err.message : String(err)
        if (nextAttempts >= MAX_ATTEMPTS) {
          await supabase.from('raw_videos').update({ status: 'error', attempts: nextAttempts, error_message: msg }).eq('id', video.id)
          await sendAlert(supabase, 'fetch-videos', `Video ${video.youtube_video_id} failed transcription after ${MAX_ATTEMPTS} attempts: ${msg}`)
          return 'errored' as const
        }
        await supabase.from('raw_videos').update({ attempts: nextAttempts }).eq('id', video.id)
        return 'retried' as const
      }
    }),
  )

  const counts = { transcribed: 0, no_captions: 0, retried: 0, errored: 0 }
  for (const s of settled) {
    if (s.status === 'fulfilled') counts[s.value]++
    else console.error(`  ✗ Unexpected transcribe error: ${s.reason}`)
  }
  return counts
}
```

- [ ] **Step 3: Deploy and verify**

**Prerequisite:** `SUPADATA_API_KEY` must be set as a Supabase secret before this can run for real (same external-dependency pattern as Task 4 — if not set, expect and report a clean `error_message: "SUPADATA_API_KEY is not set"` run rather than treating it as a code defect).

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy fetch-videos
```

Invoke transcribe mode (same request pattern as Tasks 3-4, `{"mode": "transcribe"}`), poll `pipeline_runs`, then inspect:

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
rows = sb.table('raw_videos').select('title, status, transcript_lang').in_('status', ['transcribed', 'no_captions']).execute()
print(f'{len(rows.data)} transcribed/no_captions row(s):')
for r in rows.data:
    print(' -', r['status'], r.get('transcript_lang'), '|', r['title'][:60])

# spot-check one transcript actually has content
one = sb.table('raw_videos').select('title, transcript').eq('status', 'transcribed').limit(1).execute()
if one.data:
    print('sample transcript length:', len(one.data[0]['transcript'] or ''))
"
```

Expected: at least one row reaches `status='transcribed'` with a non-trivial transcript length (hundreds+ characters). **If any real video legitimately has captions disabled, use it to confirm whether the 404-based `NoCaptionsError` detection in `_shared/transcript.ts` is actually correct — adjust the status-code/response-shape check per the Global Constraints' flagged unknown if Supadata's real behavior differs.**

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/transcript.ts supabase/functions/fetch-videos/index.ts
git commit -m "feat: add fetch-videos transcribe mode via Supadata"
```

---

### Task 6: `process-videos` — transcript → `articles` row

**Files:**
- Create: `supabase/functions/process-videos/index.ts`

**Interfaces:**
- Consumes: `sendAlert` from `../_shared/alert.ts`; `raw_videos` rows with `status='transcribed'`; `categories` and `sources` tables.
- Produces: `POST /functions/v1/process-videos`, no body required. Inserts `articles` rows with `content_type='youtube'`.

- [ ] **Step 1: Write the implementation**

```typescript
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
```

- [ ] **Step 2: Deploy**

```bash
cd /Users/ejjung/Dev/ejnewsfeed && supabase functions deploy process-videos
```

- [ ] **Step 3: Invoke and verify**

Requires at least one `raw_videos` row at `status='transcribed'` from Task 5. If Task 5 was blocked on `SUPADATA_API_KEY`, this task's live invoke will legitimately process 0 videos — report that plainly (`NEEDS_CONTEXT`, same pattern) rather than fabricating a result.

```bash
cd pipeline && python3 -c "
import os, urllib.request
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path('.') / '.env')
url = os.environ['SUPABASE_URL'] + '/functions/v1/process-videos'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
req = urllib.request.Request(url, method='POST', headers={
    'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'apikey': key,
}, data=b'{}')
with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.status, resp.read().decode())
"
```

Poll `pipeline_runs` (job_name='process-videos'), then inspect:

```bash
cd pipeline && python3 -c "
import os
from dotenv import load_dotenv
from supabase import create_client
from pathlib import Path

load_dotenv(Path('.') / '.env')
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
rows = sb.table('articles').select('title, snippet, content_type, category_tags, impact_score, duration_seconds').eq('content_type', 'youtube').execute()
print(f'{len(rows.data)} video article(s):')
for r in rows.data:
    print(' -', r['title'], '|', r['category_tags'], '| impact:', r['impact_score'], '| dur:', r['duration_seconds'])
"
```

Expected: `status: success`; each processed video produced one `articles` row with `content_type='youtube'`, a cleaned (non-clickbait) title, sensible category tags, and `impact_score` matching the source's tier mapping (0.3/0.6/1.0 — check the source's `tier` column to confirm the right value was used).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/process-videos/index.ts
git commit -m "feat: add process-videos edge function, transcript to articles row"
```

---

### Task 7: Schedule via pg_cron

**Files:**
- Create: `supabase/pg_cron_youtube.sql`

**Interfaces:**
- Consumes: `_pipeline_config` keys `supabase_url`/`supabase_anon_key` (already populated); the deployed `fetch-videos` (Tasks 3-5) and `process-videos` (Task 6) functions.

- [ ] **Step 1: Write the cron SQL file**

```sql
-- ============================================================
-- EJ Newsfeed — pg_cron Schedule for YouTube Ingestion
-- Run in Supabase SQL Editor → New Query
-- (Requires pg_cron and pg_net already enabled from pg_cron.sql)
-- ============================================================
--
-- Every 4 hours, staggered 15 minutes apart per stage — tighter than
-- the newsletter lane's 2x/day because AI Engineer's RSS window is
-- only ~1 day deep during conference dumps. All times UTC.
-- ============================================================

SELECT cron.schedule(
  'youtube-poll',
  '0 */4 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-videos',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"poll"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'youtube-enrich',
  '10 */4 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-videos',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"enrich"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'youtube-transcribe',
  '25 */4 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/fetch-videos',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT value FROM _pipeline_config WHERE key = 'supabase_anon_key')
      ),
      body    := '{"mode":"transcribe"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'youtube-process',
  '45 */4 * * *',
  $$
    SELECT net.http_post(
      url     := (SELECT value FROM _pipeline_config WHERE key = 'supabase_url')
                 || '/functions/v1/process-videos',
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
WHERE jobname IN ('youtube-poll', 'youtube-enrich', 'youtube-transcribe', 'youtube-process')
ORDER BY jobname;
```

- [ ] **Step 2: Apply manually**

Paste into `https://supabase.com/dashboard/project/oqxxmdyyfjgigfjtposv/sql/new` and run. The verification `SELECT` should return 4 jobs, all `active = true`.

- [ ] **Step 3: Commit**

```bash
git add supabase/pg_cron_youtube.sql
git commit -m "feat: schedule YouTube ingestion (poll/enrich/transcribe/process) via pg_cron"
```

---

### Task 8: Dashboard — video badge and thumbnail on `ArticleCard`

**Files:**
- Modify: `dashboard/src/components/ArticleCard.jsx`

**Interfaces:**
- Consumes: `article.content_type`, `article.thumbnail_url`, `article.duration_seconds` — already present on every `articles` row fetched by `ScanView.jsx`'s existing `select('*', ...)` query (no query change needed, confirmed: the `*` picks up Task 1's new columns automatically).

- [ ] **Step 1: Add a thumbnail and duration/video badge**

Read the current file first — this edit adds a thumbnail image and a small badge without restructuring the card's existing layout, save button, or Dive button.

At the top of the component function, after the existing `timeAgo` calculation, add a duration formatter and a video-content check:

```jsx
const isVideo = article.content_type === 'youtube'
const durationLabel = article.duration_seconds
  ? `${Math.floor(article.duration_seconds / 60)}m`
  : null
```

Change the outer card `<div className="flex items-start gap-3">` block to include a thumbnail when `isVideo` and a thumbnail URL exists, immediately before the existing `<div className="flex-1 min-w-0" ...>` block:

```jsx
{isVideo && article.thumbnail_url && (
  <img
    src={article.thumbnail_url}
    alt=""
    className="w-16 h-16 rounded-lg object-cover shrink-0"
    onClick={() => onArticleClick(article)}
  />
)}
```

In the metadata row (`<div className="flex items-center gap-2 mt-2">`, which currently shows `article.source`, `timeAgo`, and secondary category tags), add a video/duration indicator right after the `article.source` span:

```jsx
{isVideo && (
  <>
    <span className="text-gray-300 text-xs">·</span>
    <span className="text-xs text-gray-400 flex items-center gap-1">
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
      </svg>
      {durationLabel}
    </span>
  </>
)}
```

Keep every other existing element (save button, Dive button, secondary category tags) unchanged.

- [ ] **Step 2: Verify in a browser**

No automated test suite exists for `dashboard/`. Verify live, same pattern as the Knowledge view task:

```bash
cd dashboard && npm run build
```

Expected: succeeds with no errors (this is the only available compile check).

Start the dev server (`npm run dev`), sign in, and check the Morning Briefing / a category view once at least one video `articles` row exists (from Task 6). Confirm: a thumbnail renders on video cards, a duration badge (`XXm`) shows next to the source name, and non-video (newsletter) cards are completely unaffected (no thumbnail, no duration badge, unchanged layout). Stop the dev server when done.

If no video articles exist yet in the live database (Tasks 4-6 blocked on API keys), this step cannot be fully exercised — report `DONE_WITH_CONCERNS` noting the build succeeded and the JSX was self-reviewed against `ArticleCard.jsx`'s existing structure, but live rendering against a real video article is still owed once the ingestion lane has produced at least one.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/ArticleCard.jsx
git commit -m "feat: show thumbnail and duration badge for video articles"
```
