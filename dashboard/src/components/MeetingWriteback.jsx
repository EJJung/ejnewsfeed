import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getMeeting, getProposals, extractWriteback, commitWriteback, setProposalIncluded, editProposal } from '../lib/supabase.js'

const GROUPS = [
  { key: 'decision', label: 'Decisions' },
  { key: 'hypothesis', label: 'Hypotheses' },
  { key: 'open_question', label: 'Open Questions' },
]

export default function MeetingWriteback() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [meeting, setMeeting] = useState(null)
  const [proposals, setProposals] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  const load = useCallback(async () => {
    setMeeting(await getMeeting(id))
    setProposals(await getProposals(id))
  }, [id])

  useEffect(() => { load().catch((e) => setError(e.message)) }, [load])

  async function runExtract() {
    setBusy(true); setError(null); setNote(null)
    try { await extractWriteback(id); await load() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function runCommit() {
    setBusy(true); setError(null); setNote(null)
    try {
      const r = await commitWriteback(id)
      setNote(`Committed ${r.committed} item(s) to the knowledge base${r.skipped ? `; ${r.skipped} skipped for missing domains — add domains and commit again` : ''}.`)
      await load()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (!meeting) return <div className="max-w-3xl mx-auto px-6 py-8 text-gray-500">Loading…</div>

  const summary = proposals.find((p) => p.kind === 'summary')
  const hasProposed = proposals.some((p) => p.status === 'proposed')
  const committed = proposals.some((p) => p.status === 'committed')

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <button onClick={() => navigate(`/meetings/${id}`)} className="text-sm text-gray-500 hover:underline mb-4">← Meeting</button>
      <h1 className="text-2xl font-semibold text-gray-900">Write-back — {meeting.title}</h1>

      {proposals.length === 0 ? (
        <div className="mt-6">
          <p className="text-sm text-gray-500 mb-3">Extract the decisions, hypotheses, and open questions from this session's transcript.</p>
          <button onClick={runExtract} disabled={busy}
            className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50">
            {busy ? 'Extracting…' : 'Extract decisions & questions'}
          </button>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>
      ) : (
        <>
          {summary && (
            <div className="mt-5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Summary</h2>
              <ProposalCard p={summary} onSaved={load} committedMode={committed} />
            </div>
          )}
          {GROUPS.map((g) => {
            const items = proposals.filter((p) => p.kind === g.key)
            if (!items.length) return null
            return (
              <section key={g.key} className="mt-5">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">{g.label}</h2>
                <div className="space-y-2">{items.map((p) => <ProposalCard key={p.id} p={p} onSaved={load} committedMode={committed} />)}</div>
              </section>
            )
          })}

          {note && <p className="mt-5 text-sm text-green-700">{note}</p>}
          {error && <p className="mt-5 text-sm text-red-600">{error}</p>}

          <div className="mt-6 flex gap-3">
            {hasProposed && (
              <>
                <button onClick={runExtract} disabled={busy}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-100 disabled:opacity-50">Re-extract</button>
                <button onClick={runCommit} disabled={busy}
                  className="px-4 py-1.5 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700 disabled:opacity-50">
                  {busy ? 'Working…' : 'Commit to knowledge base'}
                </button>
              </>
            )}
            {committed && !hasProposed && <span className="text-sm text-green-700 font-medium">✓ Committed to the knowledge base</span>}
          </div>
        </>
      )}
    </div>
  )
}

function ProposalCard({ p, onSaved, committedMode }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(p.text)
  const [detail, setDetail] = useState(p.detail || '')
  const [domains, setDomains] = useState((p.domains || []).join(', '))

  const isCommitted = p.status === 'committed'
  const isDiscarded = p.status === 'discarded'
  const editable = p.status === 'proposed'

  async function save() {
    await editProposal(p.id, {
      text, detail: detail.trim() || null,
      domains: domains.split(',').map((d) => d.trim()).filter(Boolean),
    })
    setEditing(false); await onSaved()
  }
  async function toggle() { await setProposalIncluded(p.id, !p.included); await onSaved() }

  const dimmed = (!p.included && editable) || isDiscarded

  return (
    <div className={`p-4 rounded-lg border ${dimmed ? 'border-gray-100 opacity-40' : 'border-gray-200'}`}>
      {editing ? (
        <div className="space-y-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
          {p.kind !== 'hypothesis' && p.kind !== 'summary' && (
            <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={2} placeholder="context / why it matters" className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
          )}
          {p.kind !== 'summary' && (
            <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="domains (comma-separated: ai, business)" className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
          )}
          <div className="flex gap-2">
            <button onClick={save} className="text-xs text-violet-600 hover:underline">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:underline">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-900 whitespace-pre-wrap">{p.text}</p>
          {p.detail && <p className="text-xs text-gray-500 mt-1">{p.detail}</p>}
          {p.kind !== 'summary' && p.domains?.length > 0 && <p className="text-xs text-violet-500 mt-1">{p.domains.join(' · ')}</p>}
          {p.kind !== 'summary' && p.domains?.length === 0 && editable && <p className="text-xs text-amber-600 mt-1">no domains — add some before committing</p>}
          {editable && !committedMode && (
            <div className="flex gap-2 mt-2">
              <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-gray-700">Edit</button>
              {p.kind !== 'summary' && (
                <button onClick={toggle} className="text-xs text-gray-400 hover:text-gray-700">{p.included ? 'Exclude' : 'Include'}</button>
              )}
            </div>
          )}
          {isCommitted && <p className="text-xs text-green-600 mt-1">✓ in the knowledge base</p>}
          {isDiscarded && <p className="text-xs text-gray-400 mt-1">excluded</p>}
        </>
      )}
    </div>
  )
}
