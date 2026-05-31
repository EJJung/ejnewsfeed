/**
 * AdminView — Pipeline control panel
 * ====================================
 * Lets EJ manually trigger fetch-emails or process-emails,
 * and shows the last 20 pipeline run records from Supabase.
 *
 * Auth: prompts for PIPELINE_ADMIN_SECRET (stored in localStorage
 * so you only need to enter it once per browser).
 */

import { useState, useEffect, useCallback } from 'react'
import { supabase, isMockMode } from '../lib/supabase.js'

const LS_SECRET_KEY = 'ej_pipeline_admin_secret'

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso) {
  if (!iso) return '—'
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
  return `${Math.round(diff / 86400)}d ago`
}

function StatusBadge({ status }) {
  const styles = {
    success: 'bg-emerald-900/40 text-emerald-400 border border-emerald-800',
    error:   'bg-red-900/40 text-red-400 border border-red-800',
    running: 'bg-blue-900/40 text-blue-400 border border-blue-800',
    partial: 'bg-amber-900/40 text-amber-400 border border-amber-800',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status] || 'bg-gray-800 text-gray-400'}`}>
      {status}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AdminView() {
  const [secret, setSecret]           = useState(() => localStorage.getItem(LS_SECRET_KEY) || '')
  const [secretInput, setSecretInput] = useState('')
  const [runs, setRuns]               = useState([])
  const [loading, setLoading]         = useState(false)
  const [triggering, setTriggering]   = useState(null) // 'fetch-emails' | 'process-emails'
  const [lastResult, setLastResult]   = useState(null)
  const [requests, setRequests]       = useState([])
  const [requestsLoading, setRequestsLoading] = useState(false)

  // Load pipeline_runs from Supabase
  const loadRuns = useCallback(async () => {
    if (isMockMode) return
    setLoading(true)
    const { data } = await supabase
      .from('pipeline_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(20)
    setRuns(data || [])
    setLoading(false)
  }, [])

  // Load signup requests
  const loadRequests = useCallback(async () => {
    if (isMockMode) return
    setRequestsLoading(true)
    const { data } = await supabase
      .from('signup_requests')
      .select('*')
      .order('created_at', { ascending: false })
    setRequests(data || [])
    setRequestsLoading(false)
  }, [])

  async function updateRequestStatus(id, status) {
    await supabase.from('signup_requests').update({ status, updated_at: new Date().toISOString() }).eq('id', id)
    loadRequests()
  }

  useEffect(() => { loadRuns(); loadRequests() }, [loadRuns, loadRequests])

  // ── Secret auth ─────────────────────────────────────────────────────────────

  function handleSaveSecret(e) {
    e.preventDefault()
    localStorage.setItem(LS_SECRET_KEY, secretInput.trim())
    setSecret(secretInput.trim())
    setSecretInput('')
  }

  // ── Trigger ─────────────────────────────────────────────────────────────────

  async function triggerJob(job, params = {}) {
    if (!secret) return
    setTriggering(job)
    setLastResult(null)
    try {
      // Call Supabase edge function directly — avoids Vercel's 10s serverless
      // timeout which kills background fetches before they complete.
      const { data, error } = await supabase.functions.invoke(job, {
        body: { ...params, adminSecret: secret },
      })
      const ok = !error
      setLastResult({ job, ok, data: error ? { error: String(error) } : data })
      // Poll for the pipeline_runs row as the edge function runs
      setTimeout(loadRuns, 5000)
      setTimeout(loadRuns, 15000)
      setTimeout(loadRuns, 30000)
      setTimeout(loadRuns, 60000)
    } catch (err) {
      setLastResult({ job, ok: false, data: { error: String(err) } })
    } finally {
      setTriggering(null)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Pipeline Admin</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manually trigger Supabase Edge Functions and monitor run history.
          </p>
        </div>

        {/* Secret setup */}
        {!secret && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
            <p className="text-sm font-medium text-amber-800 mb-3">Enter your admin secret to enable triggers</p>
            <form onSubmit={handleSaveSecret} className="flex gap-2">
              <input
                type="password"
                value={secretInput}
                onChange={e => setSecretInput(e.target.value)}
                placeholder="PIPELINE_ADMIN_SECRET"
                className="flex-1 px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <button
                type="submit"
                disabled={!secretInput.trim()}
                className="px-4 py-2 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                Save
              </button>
            </form>
          </div>
        )}

        {secret && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            Admin secret saved
            <button
              onClick={() => { localStorage.removeItem(LS_SECRET_KEY); setSecret('') }}
              className="text-gray-400 hover:text-gray-600 underline ml-1"
            >
              clear
            </button>
          </div>
        )}

        {/* Trigger buttons */}
        <div className="grid grid-cols-2 gap-4">
          <TriggerCard
            title="Fetch Emails"
            description="Pull new emails from Gmail into raw_emails"
            job="fetch-emails"
            icon={
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            }
            triggering={triggering}
            disabled={!secret}
            onTrigger={triggerJob}
          />
          <TriggerCard
            title="Process Emails"
            description="Extract articles and generate daily summaries"
            job="process-emails"
            icon={
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            }
            triggering={triggering}
            disabled={!secret}
            onTrigger={triggerJob}
          />
        </div>

        {/* Fetch-emails override options */}
        {secret && <FetchOverrides onTrigger={triggerJob} triggering={triggering} />}

        {/* Last trigger result */}
        {lastResult && (
          <div className={`rounded-xl p-4 text-sm font-mono whitespace-pre-wrap break-all border ${
            lastResult.ok
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}>
            <div className="font-semibold mb-1">{lastResult.ok ? '✓' : '✗'} {lastResult.job}</div>
            {JSON.stringify(lastResult.data, null, 2)}
          </div>
        )}

        {/* Signup requests */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">Access Requests</h2>
            <button onClick={loadRequests} disabled={requestsLoading} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
              {requestsLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          {isMockMode ? (
            <p className="text-sm text-gray-400">Connect Supabase to see requests.</p>
          ) : requests.length === 0 && !requestsLoading ? (
            <p className="text-sm text-gray-400">No access requests.</p>
          ) : (
            <div className="space-y-2">
              {requests.map(req => (
                <div key={req.id} className="bg-white border border-gray-100 rounded-lg px-4 py-3 flex items-center gap-3 text-sm">
                  <StatusBadge status={req.status} />
                  <span className="flex-1 text-gray-800 truncate">{req.email}</span>
                  <span className="text-xs text-gray-400 shrink-0">{relativeTime(req.created_at)}</span>
                  {req.status === 'pending' && (
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => updateRequestStatus(req.id, 'approved')}
                        className="text-xs px-2 py-1 bg-emerald-100 text-emerald-700 rounded-md hover:bg-emerald-200 transition-colors font-medium"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => updateRequestStatus(req.id, 'rejected')}
                        className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors font-medium"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Run history */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">Run History</h2>
            <button
              onClick={loadRuns}
              disabled={loading}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {isMockMode ? (
            <p className="text-sm text-gray-400">Connect Supabase to see run history.</p>
          ) : runs.length === 0 && !loading ? (
            <p className="text-sm text-gray-400">No pipeline runs found.</p>
          ) : (
            <div className="space-y-2">
              {runs.map(run => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TriggerCard({ title, description, job, icon, triggering, disabled, onTrigger }) {
  const isRunning = triggering === job
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-gray-700">
        {icon}
        <span className="font-medium text-sm">{title}</span>
      </div>
      <p className="text-xs text-gray-400 flex-1">{description}</p>
      <button
        onClick={() => onTrigger(job)}
        disabled={disabled || !!triggering}
        className={`w-full py-2 px-3 text-sm font-medium rounded-lg transition-colors ${
          disabled
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : isRunning
              ? 'bg-blue-600 text-white cursor-wait'
              : 'bg-gray-900 text-white hover:bg-gray-700'
        }`}
      >
        {isRunning ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Running…
          </span>
        ) : 'Run Now'}
      </button>
    </div>
  )
}

function FetchOverrides({ onTrigger, triggering }) {
  const [daysBack, setDaysBack] = useState('')
  const [query, setQuery]       = useState('')

  function handleCustomFetch(e) {
    e.preventDefault()
    const params = {}
    if (daysBack) params.daysBack = parseInt(daysBack, 10)
    if (query)    params.query    = query.trim()
    onTrigger('fetch-emails', params)
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Fetch Overrides</h3>
      <form onSubmit={handleCustomFetch} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Days back</label>
            <input
              type="number"
              min="1" max="30"
              value={daysBack}
              onChange={e => setDaysBack(e.target.value)}
              placeholder="default: 2 (Mon: 4)"
              className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Gmail query</label>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="e.g. in:inbox after:2026/05/20"
              className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={!!triggering}
          className="self-start px-4 py-1.5 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
        >
          Run Fetch with overrides
        </button>
      </form>
    </div>
  )
}

function RunRow({ run }) {
  const duration = run.completed_at && run.started_at
    ? Math.round((new Date(run.completed_at) - new Date(run.started_at)) / 1000)
    : null

  return (
    <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 flex items-center gap-3 text-sm">
      <StatusBadge status={run.status} />
      <span className="font-medium text-gray-800 w-36 shrink-0">{run.job_name}</span>
      <span className="text-gray-400 text-xs flex-1 truncate">
        {run.emails_fetched != null && `fetched ${run.emails_fetched}`}
        {run.emails_processed != null && `processed ${run.emails_processed}`}
        {run.articles_saved != null && ` · ${run.articles_saved} articles`}
        {run.summaries_generated != null && ` · ${run.summaries_generated} summaries`}
        {run.error_message && <span className="text-red-400"> {run.error_message.slice(0, 60)}</span>}
      </span>
      <span className="text-xs text-gray-400 shrink-0">
        {duration != null ? `${duration}s` : ''}
      </span>
      <span className="text-xs text-gray-400 shrink-0 w-20 text-right">
        {relativeTime(run.started_at)}
      </span>
    </div>
  )
}
