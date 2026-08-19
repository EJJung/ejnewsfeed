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

async function runPoll(supabase: ReturnType<typeof createClient>): Promise<{ sources_polled: number; videos_inserted: number; videos_failed: number }> {
  const { data: sources, error } = await supabase
    .from('sources')
    .select('id, youtube_channel_id, min_duration_seconds, last_polled_at')
    .eq('source_type', 'youtube')
    .eq('active', true)

  if (error) throw new Error(`Failed to load YouTube sources: ${error.message}`)
  const rows = (sources || []) as SourceRow[]

  const settled = await Promise.allSettled(rows.map((source) => pollOneChannel(supabase, source)))

  let videosInserted = 0
  let videosFailed = 0
  let sourcesWithFailures = 0
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') {
      videosInserted += s.value.inserted
      videosFailed += s.value.failed
      if (s.value.failed > 0) sourcesWithFailures++
    } else {
      console.error(`  ✗ Error polling source ${rows[i].id}: ${s.reason}`)
    }
  }

  if (videosFailed > 0) {
    await sendAlert(
      supabase,
      'fetch-videos',
      `fetch-videos poll completed with ${videosFailed} insert failure(s) across ${sourcesWithFailures} source(s) — check Edge Function logs`,
    )
  }

  return { sources_polled: rows.length, videos_inserted: videosInserted, videos_failed: videosFailed }
}

async function pollOneChannel(supabase: ReturnType<typeof createClient>, source: SourceRow): Promise<{ inserted: number; failed: number }> {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${source.youtube_channel_id}`
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`RSS fetch failed for ${source.youtube_channel_id}: ${res.status}`)

  const xml = await res.text()
  const entries = parseYouTubeFeed(xml)

  const rssResult = await insertNewVideos(supabase, source.id, entries)
  let inserted = rssResult.inserted
  let failed = rssResult.failed

  // Overflow check: a full 15-entry window whose oldest item is still newer
  // than our last poll means the window didn't reach back far enough —
  // some uploads between last_polled_at and now may have been missed.
  const oldest = entries.length ? entries[entries.length - 1] : null
  const overflowSuspected = entries.length >= 15 && oldest && source.last_polled_at && new Date(oldest.publishedAt) > new Date(source.last_polled_at)

  let backfillOk = true
  if (overflowSuspected) {
    const backfillResult = await backfillViaDataApi(supabase, source)
    inserted += backfillResult.inserted
    failed += backfillResult.failed
    backfillOk = backfillResult.ok
  }

  if (!overflowSuspected || backfillOk) {
    await supabase.from('sources').update({ last_polled_at: new Date().toISOString() }).eq('id', source.id)
  } else {
    console.error(`  ✗ Overflow backfill failed for source ${source.id} — leaving last_polled_at unchanged so recovery is retried on the next poll`)
  }

  return { inserted, failed }
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

async function insertNewVideos(supabase: ReturnType<typeof createClient>, sourceId: string, entries: FeedEntry[]): Promise<{ inserted: number; failed: number }> {
  let inserted = 0
  let failed = 0
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
      failed++
      console.error(`  ✗ Failed to insert video ${entry.videoId}: ${error.message}`)
    }
  }
  return { inserted, failed }
}

async function backfillViaDataApi(supabase: ReturnType<typeof createClient>, source: SourceRow): Promise<{ inserted: number; failed: number; ok: boolean }> {
  const apiKey = Deno.env.get('YOUTUBE_DATA_API_KEY')
  if (!apiKey) {
    console.error(`  ✗ Overflow detected for source ${source.id} but YOUTUBE_DATA_API_KEY is not set — skipping backfill`)
    return { inserted: 0, failed: 0, ok: false }
  }

  const uploadsPlaylistId = 'UU' + source.youtube_channel_id.slice(2)
  const lastPolled = source.last_polled_at ? new Date(source.last_polled_at) : null

  let inserted = 0
  let failed = 0
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
      return { inserted, failed, ok: false }
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
    const pageResult = await insertNewVideos(supabase, source.id, entries)
    inserted += pageResult.inserted
    failed += pageResult.failed

    const oldestOnPage = items.length ? new Date(items[items.length - 1].snippet.publishedAt) : null
    pageToken = data.nextPageToken
    if (!pageToken || !oldestOnPage || (lastPolled && oldestOnPage <= lastPolled)) break
  }

  return { inserted, failed, ok: true }
}

// ── Enrich mode (Task 4) ─────────────────────────────────────────────────

async function runEnrich(_supabase: ReturnType<typeof createClient>): Promise<Record<string, unknown>> {
  throw new Error('enrich mode not implemented yet')
}

// ── Transcribe mode (Task 5) ─────────────────────────────────────────────

async function runTranscribe(_supabase: ReturnType<typeof createClient>): Promise<Record<string, unknown>> {
  throw new Error('transcribe mode not implemented yet')
}
