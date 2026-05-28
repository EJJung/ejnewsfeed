import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function RequestAccessPage({ email, existingStatus, onSignOut }) {
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } = await supabase
      .from('signup_requests')
      .upsert({ email, status: 'pending' }, { onConflict: 'email' })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    await supabase.auth.signOut()
    setSubmitted(true)
    setLoading(false)
  }

  // Already submitted a request in a previous session
  if (existingStatus === 'pending') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Request pending</h2>
          <p className="text-sm text-gray-500 mt-2">
            Your request for <strong>{email}</strong> is under review. Check back later.
          </p>
          <button
            onClick={onSignOut}
            className="mt-6 text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center">
          <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Request sent</h2>
          <p className="text-sm text-gray-500 mt-2">
            Your request for <strong>{email}</strong> has been submitted. You'll be able to sign in once it's approved.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center">
        <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-gray-900">Access required</h2>
        <p className="text-sm text-gray-500 mt-2 mb-6">
          <strong>{email}</strong> doesn't have access yet. Submit a request and EJ will review it.
        </p>
        <form onSubmit={handleSubmit}>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 transition-colors disabled:opacity-60"
          >
            {loading ? 'Submitting…' : 'Request Access'}
          </button>
        </form>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button
          onClick={onSignOut}
          className="mt-4 text-xs text-gray-400 hover:text-gray-600 underline"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
