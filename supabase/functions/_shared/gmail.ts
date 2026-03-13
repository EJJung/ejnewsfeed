/**
 * Shared Gmail OAuth + parsing utilities
 * Used by both fetch-emails and process-emails Edge Functions
 */

// ── OAuth ──────────────────────────────────────────────────────────────────

/** Exchange a refresh token for a short-lived access token */
export async function getAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (!data.access_token) {
    throw new Error(`Gmail token refresh failed: ${JSON.stringify(data)}`)
  }
  return data.access_token
}

// ── Message parsing ────────────────────────────────────────────────────────

/** Decode URL-safe base64 as used in Gmail API bodies */
export function decodeGmailBody(encoded: string): string {
  if (!encoded) return ''
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const binary = atob(normalized)
    // Decode UTF-8 properly
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

/** Walk a Gmail message payload tree and extract HTML + plain text */
export function extractEmailContent(payload: Record<string, unknown>): {
  html: string
  text: string
} {
  let html = ''
  let text = ''

  function walk(parts: Record<string, unknown>[]) {
    for (const part of parts) {
      const mime = (part.mimeType as string) || ''
      if (mime === 'text/html') {
        html = decodeGmailBody((part.body as Record<string, unknown>)?.data as string || '')
      } else if (mime === 'text/plain') {
        text = decodeGmailBody((part.body as Record<string, unknown>)?.data as string || '')
      } else if (Array.isArray(part.parts)) {
        walk(part.parts as Record<string, unknown>[])
      }
    }
  }

  if (Array.isArray(payload.parts)) {
    walk(payload.parts as Record<string, unknown>[])
  } else {
    const mime = (payload.mimeType as string) || ''
    const body = decodeGmailBody((payload.body as Record<string, unknown>)?.data as string || '')
    if (mime === 'text/html') html = body
    else if (mime === 'text/plain') text = body
  }

  return { html, text }
}

/** Get a header value from a Gmail message by name */
export function getHeader(message: Record<string, unknown>, name: string): string {
  const headers = ((message.payload as Record<string, unknown>)?.headers as Record<string, string>[]) || []
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || ''
}

/** Minimal HTML → plain text conversion for Claude prompt input */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 12000) // cap for Claude token safety
    .trim()
}
