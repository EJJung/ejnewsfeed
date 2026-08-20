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
