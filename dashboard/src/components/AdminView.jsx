/**
 * AdminView — Pipeline control panel
 * ====================================
 * Lets EJ manually trigger fetch-emails or process-emails,
 * and shows the last 20 pipeline run records from Supabase.
 *
 * Features:
 *  - Today's health banner (did the daily run succeed?)
 *  - Auto-refresh run history while a job is running
 *  - Gmail auth health check (catch expired tokens early)
 *  - Expandable error details in run history
 *  - Re-run yesterday quick button in Fetch Overrides
 */

import { useState, useEffect, useCallback, useRef } from 'react'
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

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

function yesterdayUTC() {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function StatusBadge({ status }) {
  const styles = {
    success: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
    error:   'bg-red-100 text-red-600 border border-red-200',
    running: 'bg-blue-100 text-blue-600 border border-blue-200',
    partial: 'bg-amber-100 text-amber-700 border border-amber-200',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status] || 'bg-gray-100 text-gray-500'}`}>
      {status}
    </span>
  )
}

// ── Health Banner ─────────────────────────────────────────────────────────────

function HealthBanner({ runs }) {
  const today = todayUTC()
  const todayRuns = runs.filter(r => r.started_at?.startsWith(today))

  const fetchRun   = todayRuns.find(r => r.job_name === 'fetch-emails')
  const processRun = todayRuns.find(r => r.job_name === 'process-emails')

  const anyRunning = todayRuns.some(r => r.status === 'running')
  const anyError   = todayRuns.some(r => r.status === 'error')
  const bothOk     = fetchRun?.status === 'success' && processRun?.status === 'success'

  if (runs.length === 0) return null

  let bg, icon, title, detail
  if (anyRunning) {
    bg = 'bg-blue-50 border-blue-200'; icon = '⏳'; title = 'Pipeline running'
    detail = 'A job is currently in progress — run history refreshes automatically.'
  } else if (anyError) {
    const errRun = todayRuns.find(r => r.status === 'error')
    bg = 'bg-red-50 border-red-200'; icon = '❌'; title = `Today's pipeline failed`
    detail = errRun?.error_message
      ? errRun.error_message.slice(0, 120)
      : 'Check run history below for details.'
  } else if (bothOk) {
    const arts = processRun?.articles_saved ?? 0
    const sums = processRun?.summaries_generated ?? 0
    bg = 'bg-emerald-50 border-emerald-200'; icon = '✅'; title = "Today's pipeline succeeded"
    detail = `${fetchRun?.emails_fetched ?? 0} emails fetched · ${arts} articles saved · ${sums} summaries generated`
  } else if (!fetchRun && !processRun) {
    bg = 'bg-gray-50 border-gray-200'; icon = '🕐'; title = "No runs yet today"
    detail = 'The daily pg_cron job runs at 10:00 AM EDT. Use the buttons below to run manually.'
  } else {
    bg = 'bg-amber-50 border-amber-200'; icon = '⚠️'; title = 'Pipeline partially complete'
    detail = `fetch-emails: ${fetchRun?.status ?? 'not run'} · process-emails: ${processRun?.status ?? 'not run'}`
  }

  return (
    <div className={`rounded-xl border p-4 ${bg}`}>
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none mt-0.5">{icon}</span>
        <div>
          <p className="text-sm font-semibold text-gray-800">{title}</p>
          <p className="text-xs text-gray-500 mt-0.5">{detail}</p>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AdminView() {
  const [secret, setSecret]           = useState(() => localStorage.getItem(LS_SECRET_KEY) || '')
  const [secretInput, setSecretInput] = useState('')
  const [runs, setRuns]               = useState([])
  const [loading, setLoading]         = useState(false)
  const [triggering, setTriggering]   = useState(null)
  const [lastResult, setLastResult]   = useState(null)
  const [requests, setRequests]       = useState([])
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [authChecking, setAuthChecking] = useState(false)
  const [authResult, setAuthResult]     = useState(null) // { ok, message }
  const pollRef = useRef(null)

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

  // Auto-refresh every 5s while any run is 'running'
  useEffect(() => {
    const hasRunning = runs.some(r => r.status === 'running')
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(loadRuns, 5000)
    } else if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [runs, loadRuns])

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
    setAuthResult(null)
    try {
      const { data, error } = await supabase.functions.invoke(job, {
        body: { ...params, adminSecret: secret },
      })
      const ok = !error
      setLastResult({ job, ok, data: error ? { error: String(error) } : data })
      loadRuns()
    } catch (err) {
      setLastResult({ job, ok: false, data: { error: String(err) } })
    } finally {
      setTriggering(null)
    }
  }

  // ── Gmail auth check ─────────────────────────────────────────────────────────
  // Calls fetch-emails with a far-future query — touches OAuth but returns 0 emails.

  async function checkGmailAuth() {
    if (!secret) return
    setAuthChecking(true)
    setAuthResult(null)
    setLastResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('fetch-emails', {
        body: { query: 'in:inbox after:2099/01/01', adminSecret: secret },
      })
      if (error) {
        const msg = String(error)
        const isToken = msg.includes('invalid_grant') || msg.includes('unauthorized_client') || msg.includes('token')
        setAuthResult({ ok: false, message: isToken ? '❌ Gmail OAuth token is invalid or expired — regenerate it via OAuth Playground.' : `❌ ${msg}` })
      } else {
        setAuthResult({ ok: true, message: '✅ Gmail auth is working.' })
      }
    } catch (err) {
      setAuthResult({ ok: false, message: `❌ ${String(err)}` })
    } finally {
      setAuthChecking(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const isAnyRunning = runs.some(r => r.status === 'running')

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Pipeline Admin</h1>
            <p className="text-sm text-gray-500 mt-1">
              Manually trigger edge functions and monitor pipeline health.
            </p>
          </div>
          {isAnyRunning && (
            <span className="flex items-center gap-1.5 text-xs text-blue-600 bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-full">
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Live
            </span>
          )}
        </div>

        {/* Today's health banner */}
        <HealthBanner runs={runs} />

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
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              Admin secret saved
            </span>
            <button
              onClick={() => { localStorage.removeItem(LS_SECRET_KEY); setSecret('') }}
              className="text-gray-400 hover:text-gray-600 underline"
            >
              clear
            </button>
            <span className="text-gray-200">|</span>
            <button
              onClick={checkGmailAuth}
              disabled={authChecking || !!triggering}
              className="flex items-center gap-1 text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-colors"
            >
              {authChecking
                ? <><svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Checking…</>
                : '🔑 Test Gmail auth'
              }
            </button>
          </div>
        )}

        {/* Auth check result */}
        {authResult && (
          <div className={`text-xs px-3 py-2 rounded-lg border ${authResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {authResult.message}
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
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-700">Run History</h2>
              {isAnyRunning && (
                <span className="text-xs text-blue-500 animate-pulse">auto-refreshing</span>
              )}
            </div>
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

  function runYesterday() {
    const y = yesterdayUTC().replace(/-/g, '/')
    const tod = todayUTC().replace(/-/g, '/')
    onTrigger('fetch-emails', { query: `in:inbox after:${y} before:${tod}` })
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-700">Fetch Overrides</h3>
        <button
          onClick={runYesterday}
          disabled={!!triggering}
          className="text-xs px-3 py-1 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
        >
          ↩ Re-run yesterday
        </button>
      </div>
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
  const [expanded, setExpanded] = useState(false)

  const duration = run.completed_at && run.started_at
    ? Math.round((new Date(run.completed_at) - new Date(run.started_at)) / 1000)
    : null

  const hasError = !!run.error_message

  const stats = [
    run.emails_fetched   > 0 && `${run.emails_fetched} fetched`,
    run.emails_skipped   > 0 && `${run.emails_skipped} skipped`,
    run.emails_processed > 0 && `${run.emails_processed} processed`,
    run.articles_saved   > 0 && `${run.articles_saved} articles`,
    run.summaries_generated > 0 && `${run.summaries_generated} summaries`,
  ].filter(Boolean).join(' · ')

  return (
    <div className="bg-white border border-gray-100 rounded-lg overflow-hidden">
      <div
        className={`px-4 py-3 flex items-center gap-3 text-sm ${hasError ? 'cursor-pointer hover:bg-gray-50' : ''}`}
        onClick={() => hasError && setExpanded(e => !e)}
      >
        <StatusBadge status={run.status} />
        <span className="font-medium text-gray-800 w-36 shrink-0">{run.job_name}</span>
        <span className="text-gray-400 text-xs flex-1 truncate">
          {stats || (hasError ? <span className="text-red-400">{run.error_message.slice(0, 60)}…</span> : '—')}
        </span>
        <span className="text-xs text-gray-400 shrink-0">
          {duration != null ? `${duration}s` : run.status === 'running' ? '…' : ''}
        </span>
        <span className="text-xs text-gray-400 shrink-0 w-20 text-right">
          {relativeTime(run.started_at)}
        </span>
        {hasError && (
          <span className="text-xs text-gray-400 shrink-0">{expanded ? '▲' : '▼'}</span>
        )}
      </div>
      {expanded && run.error_message && (
        <div className="px-4 pb-3 pt-0">
          <pre className="text-xs bg-red-50 border border-red-100 text-red-700 rounded-lg p-3 whitespace-pre-wrap break-all">
            {run.error_message}
          </pre>
        </div>
      )}
    </div>
  )
}
