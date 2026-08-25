import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { listMeetings, createMeeting, assemblePack } from '../lib/supabase.js'

const STATUS_LABEL = {
  draft: 'Draft', assembling: 'Assembling…', pack_ready: 'Pack ready',
  approved: 'Approved', error: 'Error',
}
const STATUS_CLASS = {
  draft: 'bg-gray-100 text-gray-600', assembling: 'bg-amber-100 text-amber-700',
  pack_ready: 'bg-blue-100 text-blue-700', approved: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
}

export default function MeetingsView() {
  const navigate = useNavigate()
  const [meetings, setMeetings] = useState([])
  const [showForm, setShowForm] = useState(false)

  const refresh = useCallback(async () => {
    try { setMeetings(await listMeetings()) } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Poll while anything is assembling, so the badge flips to pack_ready.
  useEffect(() => {
    if (!meetings.some((m) => m.status === 'assembling')) return
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [meetings, refresh])

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Meetings</h1>
        <button onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700">
          {showForm ? 'Cancel' : 'New meeting'}
        </button>
      </div>

      {showForm && <NewMeetingForm onCreated={async () => { setShowForm(false); await refresh() }} />}

      <div className="space-y-2 mt-6">
        {meetings.length === 0 && <p className="text-gray-500 text-sm">No meetings yet.</p>}
        {meetings.map((m) => (
          <div key={m.id}
            className="flex items-center justify-between p-4 rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer"
            onClick={() => navigate(`/meetings/${m.id}`)}>
            <span className="font-medium text-gray-900">{m.title}</span>
            <span className={`text-xs px-2 py-1 rounded-full ${STATUS_CLASS[m.status] || ''}`}>
              {STATUS_LABEL[m.status] || m.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function NewMeetingForm({ onCreated }) {
  const [title, setTitle] = useState('')
  const [agenda, setAgenda] = useState('')
  const [result, setResult] = useState('')
  const [questions, setQuestions] = useState([''])
  const [busy, setBusy] = useState(false)

  function setQuestion(i, val) {
    setQuestions((qs) => qs.map((q, idx) => (idx === i ? val : q)))
  }

  async function submit(assemble) {
    if (!title.trim() || !agenda.trim()) return
    setBusy(true)
    try {
      const cleanQuestions = questions.map((q) => q.trim()).filter(Boolean)
      const id = await createMeeting({
        title: title.trim(), agenda: agenda.trim(),
        prospective_result: result.trim() || null, decision_questions: cleanQuestions,
      })
      if (assemble) await assemblePack(id)
      await onCreated()
    } catch (e) { console.error(e); alert(`Failed: ${e.message}`) } finally { setBusy(false) }
  }

  return (
    <div className="p-5 rounded-lg border border-gray-200 bg-gray-50 space-y-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting title"
        className="w-full px-3 py-2 rounded border border-gray-300 text-sm" />
      <textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="Agenda"
        rows={3} className="w-full px-3 py-2 rounded border border-gray-300 text-sm" />
      <textarea value={result} onChange={(e) => setResult(e.target.value)} placeholder="Desired result (optional)"
        rows={2} className="w-full px-3 py-2 rounded border border-gray-300 text-sm" />
      <div className="space-y-2">
        <label className="text-xs font-medium text-gray-600">Critical decision questions</label>
        {questions.map((q, i) => (
          <input key={i} value={q} onChange={(e) => setQuestion(i, e.target.value)}
            placeholder={`Question ${i + 1}`}
            className="w-full px-3 py-2 rounded border border-gray-300 text-sm" />
        ))}
        <button type="button" onClick={() => setQuestions((qs) => [...qs, ''])}
          className="text-xs text-violet-600 hover:underline">+ Add question</button>
      </div>
      <div className="flex gap-2 pt-1">
        <button disabled={busy} onClick={() => submit(false)}
          className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-gray-100 disabled:opacity-50">
          Save draft
        </button>
        <button disabled={busy} onClick={() => submit(true)}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm hover:bg-violet-700 disabled:opacity-50">
          {busy ? 'Working…' : 'Save & assemble pack'}
        </button>
      </div>
    </div>
  )
}
