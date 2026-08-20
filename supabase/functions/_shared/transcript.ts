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

  // Timeout bounds the sequential transcribe loop's worst case. The design
  // spec describes Supadata calls as "fast HTTP calls (~50-500ms)" in the
  // common case, so 10s is still 20-200x headroom over typical latency —
  // plenty of margin for real transient slowness — while keeping a
  // fully-degraded batch (every call timing out) at roughly
  // 15 * (10s + 1.1s pacing) ~= 166s (~2.8 min), safely under the 5-minute
  // EdgeRuntime background-execution ceiling. At 30s this same worst case
  // would run ~465s (~7.8 min), blowing past that ceiling.
  const res = await fetch(
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}&text=true`,
    { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(10_000) },
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
