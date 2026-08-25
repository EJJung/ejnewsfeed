import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getMeeting, getSessionMessages, startSession, sendSessionMessage, endSession } from '../lib/supabase.js'

export default function MeetingSession() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [meeting, setMeeting] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)
  const startedRef = useRef(false)

  const load = useCallback(async () => {
    const mtg = await getMeeting(id)
    setMeeting(mtg)
    setMessages(await getSessionMessages(id))
    return mtg
  }, [id])

  const doStart = useCallback(async () => {
    setBusy(true); setError(null)
    try { await startSession(id); await load() }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }, [id, load])

  useEffect(() => {
    (async () => {
      try {
        const mtg = await load()
        // Auto-start the session on first entry from an approved pack.
        if (mtg?.status === 'approved' && !startedRef.current) {
          startedRef.current = true
          await doStart()
        }
      } catch (e) { setError(e.message) } finally { setBusy(false) }
    })()
  }, [id, load, doStart])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])

  const readOnly = meeting?.status === 'complete'
  const needsStart = meeting?.status === 'approved' && messages.length === 0

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true); setError(null)
    // Optimistically show the user's turn.
    setMessages((prev) => [...prev, { id: `tmp-${prev.length}`, role: 'user', content: text }])
    setInput('')
    try {
      await sendSessionMessage(id, text)
      await load()
    } catch (e) {
      setError(e.message)
      setInput(text) // restore so the user can resend
      setMessages((prev) => prev.filter((mm) => !String(mm.id).startsWith('tmp-')))
    } finally { setBusy(false) }
  }

  async function finish() {
    if (!confirm('End this session? You can review the transcript afterward; write-back comes in the next release.')) return
    try {
      await endSession(id)
      navigate(`/meetings/${id}`)
    } catch (e) {
      setError(e.message)
    }
  }

  if (!meeting) return <div className="max-w-3xl mx-auto px-6 py-8 text-gray-500">Loading…</div>

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 flex flex-col h-full">
      <button onClick={() => navigate(`/meetings/${id}`)} className="text-sm text-gray-500 hover:underline mb-3 self-start">← Meeting</button>

      <details className="mb-4 p-3 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700">
        <summary className="font-medium cursor-pointer">{meeting.title}</summary>
        <p className="mt-2"><span className="font-medium">Agenda:</span> {meeting.agenda}</p>
        {meeting.prospective_result && <p><span className="font-medium">Desired result:</span> {meeting.prospective_result}</p>}
        {meeting.decision_questions?.length > 0 && (
          <ul className="list-decimal ml-5 mt-1">{meeting.decision_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        )}
      </details>

      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {messages.map((mm) => (
          <div key={mm.id} className={`flex ${mm.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${
              mm.role === 'user' ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-900'
            }`}>{mm.content}</div>
          </div>
        ))}
        {busy && <div className="text-xs text-gray-400 pl-1">companion is thinking…</div>}
        {error && <div className="text-xs text-red-600 pl-1">Couldn't reach the companion: {error}. Your message is restored — try again.</div>}
        <div ref={bottomRef} />
      </div>

      {readOnly ? (
        <div className="mt-2 text-sm text-gray-500 border-t border-gray-100 pt-3">
          Session complete — transcript is read-only. Write-back (turning this into decisions/hypotheses/questions) arrives in the next release.
        </div>
      ) : needsStart ? (
        <div className="mt-2 border-t border-gray-100 pt-3">
          <button onClick={doStart} disabled={busy}
            className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50">
            {busy ? 'Starting…' : 'Start session'}
          </button>
          {busy && <div className="mt-2 text-xs text-gray-400">companion is thinking…</div>}
          {error && <div className="mt-2 text-xs text-red-600">Couldn't start the session: {error}. Try again.</div>}
        </div>
      ) : (
        <div className="mt-2 border-t border-gray-100 pt-3">
          <div className="flex gap-2">
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder="Make your case…" rows={2} disabled={busy}
              className="flex-1 px-3 py-2 rounded-lg border border-gray-300 text-sm resize-none disabled:opacity-50" />
            <button onClick={send} disabled={busy || !input.trim()}
              className="px-4 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50">Send</button>
          </div>
          <button onClick={finish} disabled={busy}
            className="mt-2 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50">End session</button>
        </div>
      )}
    </div>
  )
}
