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
