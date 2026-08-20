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
