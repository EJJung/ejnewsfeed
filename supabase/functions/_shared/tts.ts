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
