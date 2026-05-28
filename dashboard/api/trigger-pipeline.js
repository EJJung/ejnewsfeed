/**
 * Vercel Serverless Function — /api/trigger-pipeline
 * ====================================================
 * Manually fires a Supabase Edge Function (fetch-emails or process-emails).
 * Protected by a shared secret stored in Vercel environment variables.
 *
 * Environment variables required (set in Vercel project settings):
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (full access)
 *   PIPELINE_ADMIN_SECRET     — arbitrary secret password for the admin UI
 *
 * Request:
 *   POST /api/trigger-pipeline
 *   Authorization: Bearer <PIPELINE_ADMIN_SECRET>
 *   Content-Type: application/json
 *   { "job": "fetch-emails" | "process-emails", "params": { ...optional overrides } }
 *
 * Response:
 *   { ok: true, job, result: { ...edge function response } }   — on success
 *   { ok: false, error: "..." }                                — on failure
 */

export default async function handler(req, res) {
  // CORS headers for same-origin dashboard calls
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  // ── Auth check ──────────────────────────────────────────────────────────────
  const adminSecret = process.env.PIPELINE_ADMIN_SECRET
  if (!adminSecret) {
    return res.status(500).json({ ok: false, error: 'PIPELINE_ADMIN_SECRET not configured on server' })
  }

  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (token !== adminSecret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — wrong admin secret' })
  }

  // ── Validate job ────────────────────────────────────────────────────────────
  const VALID_JOBS = ['fetch-emails', 'process-emails']
  const { job, params = {} } = req.body || {}

  if (!job || !VALID_JOBS.includes(job)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid job "${job}". Must be one of: ${VALID_JOBS.join(', ')}`,
    })
  }

  // ── Fire the Edge Function ──────────────────────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ ok: false, error: 'Supabase credentials not configured on server' })
  }

  try {
    const edgeRes = await fetch(`${supabaseUrl}/functions/v1/${job}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(params),
    })

    const text = await edgeRes.text()
    let result
    try { result = JSON.parse(text) } catch { result = { raw: text } }

    return res.status(edgeRes.ok ? 200 : 502).json({
      ok: edgeRes.ok,
      job,
      status: edgeRes.status,
      result,
    })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
