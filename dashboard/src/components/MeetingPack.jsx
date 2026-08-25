import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  getMeeting, getCards, setCardIncluded, editCard, addManualCard, approvePack, assemblePack,
} from '../lib/supabase.js'

const GROUPS = [
  { key: 'insight', label: 'Insights & Contradictions' },
  { key: 'decision', label: 'Decisions' },
  { key: 'hypothesis', label: 'Hypotheses' },
  { key: 'open_question', label: 'Open Questions' },
  { key: 'article', label: 'Articles' },
  { key: 'manual', label: 'Your additions' },
]

export default function MeetingPack() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [meeting, setMeeting] = useState(null)
  const [cards, setCards] = useState([])

  const refresh = useCallback(async () => {
    try {
      setMeeting(await getMeeting(id))
      setCards(await getCards(id))
    } catch (e) { console.error(e) }
  }, [id])

  useEffect(() => { refresh() }, [refresh])

  // Poll while assembling / re-assembling.
  useEffect(() => {
    if (meeting?.status !== 'assembling') return
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [meeting, refresh])

  if (!meeting) return <div className="max-w-3xl mx-auto px-6 py-8 text-gray-500">Loading…</div>

  async function toggle(card) { await setCardIncluded(card.id, !card.included); await refresh() }

  async function reassemble() {
    if (!confirm('Re-assemble the pack? Your manual and edited cards are kept; other cards are regenerated.')) return
    await assemblePack(id); await refresh()
  }

  async function approve() { await approvePack(id); await refresh() }

  const assembling = meeting.status === 'assembling'

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <button onClick={() => navigate('/meetings')} className="text-sm text-gray-500 hover:underline mb-4">← Meetings</button>

      <h1 className="text-2xl font-semibold text-gray-900">{meeting.title}</h1>
      <div className="mt-3 p-4 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700 space-y-2">
        <p><span className="font-medium">Agenda:</span> {meeting.agenda}</p>
        {meeting.prospective_result && <p><span className="font-medium">Desired result:</span> {meeting.prospective_result}</p>}
        {meeting.decision_questions?.length > 0 && (
          <div><span className="font-medium">Decision questions:</span>
            <ul className="list-decimal ml-5 mt-1">{meeting.decision_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 my-5">
        {meeting.status === 'error' && <span className="text-sm text-red-600">Error: {meeting.error_message}</span>}
        <button onClick={reassemble} disabled={assembling}
          className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-100 disabled:opacity-50">
          {assembling ? 'Assembling…' : 'Re-assemble'}
        </button>
        {meeting.status !== 'approved' ? (
          <button onClick={approve} disabled={assembling}
            className="px-4 py-1.5 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700 disabled:opacity-50">
            Approve pack
          </button>
        ) : <span className="text-sm text-green-700 font-medium">✓ Approved</span>}
        {meeting.status === 'approved' && (
          <button onClick={() => navigate(`/meetings/${id}/session`)}
            className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-sm hover:bg-violet-700">
            Start session
          </button>
        )}
        {meeting.status === 'in_session' && (
          <button onClick={() => navigate(`/meetings/${id}/session`)}
            className="px-4 py-1.5 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700">
            Resume session
          </button>
        )}
        {meeting.status === 'complete' && (
          <button onClick={() => navigate(`/meetings/${id}/session`)}
            className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-100">
            View transcript
          </button>
        )}
        {meeting.status === 'complete' && (
          <button onClick={() => navigate(`/meetings/${id}/writeback`)}
            className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-sm hover:bg-violet-700">
            Write-back
          </button>
        )}
      </div>

      {!assembling && cards.length === 0 && (
        <p className="text-sm text-gray-500">AI found nothing relevant — add cards manually below.</p>
      )}

      {GROUPS.map((g) => {
        const groupCards = cards.filter((c) => c.card_type === g.key)
        if (!groupCards.length) return null
        return (
          <section key={g.key} className="mb-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">{g.label}</h2>
            <div className="space-y-2">
              {groupCards.map((c) => <Card key={c.id} card={c} onToggle={() => toggle(c)} onSaved={refresh} />)}
            </div>
          </section>
        )
      })}

      <AddCard meetingId={id} onAdded={refresh} />
    </div>
  )
}

function Card({ card, onToggle, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [headline, setHeadline] = useState(card.headline)
  const [body, setBody] = useState(card.body)

  async function save() { await editCard(card.id, { headline, body }); setEditing(false); await onSaved() }

  return (
    <div className={`p-4 rounded-lg border ${card.included ? 'border-gray-200' : 'border-gray-100 opacity-40'}`}>
      {editing ? (
        <div className="space-y-2">
          <input value={headline} onChange={(e) => setHeadline(e.target.value)}
            className="w-full px-2 py-1 rounded border border-gray-300 text-sm font-medium" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
            className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
          <div className="flex gap-2">
            <button onClick={save} className="text-xs text-violet-600 hover:underline">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:underline">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-gray-900 text-sm">{card.headline}</p>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-gray-700">Edit</button>
              <button onClick={onToggle} className="text-xs text-gray-400 hover:text-gray-700">
                {card.included ? 'Exclude' : 'Include'}
              </button>
            </div>
          </div>
          <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{card.body}</p>
          {card.why_relevant && <p className="text-xs text-violet-500 mt-2 italic">Why: {card.why_relevant}</p>}
        </>
      )}
    </div>
  )
}

function AddCard({ meetingId, onAdded }) {
  const [open, setOpen] = useState(false)
  const [headline, setHeadline] = useState('')
  const [body, setBody] = useState('')

  async function add() {
    if (!headline.trim() || !body.trim()) return
    await addManualCard(meetingId, { headline: headline.trim(), body: body.trim() })
    setHeadline(''); setBody(''); setOpen(false); await onAdded()
  }

  if (!open) return <button onClick={() => setOpen(true)} className="text-sm text-violet-600 hover:underline">+ Add card</button>
  return (
    <div className="p-4 rounded-lg border border-gray-200 bg-gray-50 space-y-2">
      <input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Card headline"
        className="w-full px-2 py-1 rounded border border-gray-300 text-sm font-medium" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Card content" rows={3}
        className="w-full px-2 py-1 rounded border border-gray-300 text-sm" />
      <div className="flex gap-2">
        <button onClick={add} className="text-xs text-violet-600 hover:underline">Add</button>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:underline">Cancel</button>
      </div>
    </div>
  )
}
