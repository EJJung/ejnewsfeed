import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseKey  = import.meta.env.VITE_SUPABASE_ANON_KEY

// Returns null in mock mode (no env vars set)
export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null

export const isMockMode = !supabase

export const ADMIN_EMAIL = 'ej.newsfeed@gmail.com'

export async function signOut() {
  if (supabase) await supabase.auth.signOut()
}

// Returns { approved: true } or { approved: false, existingStatus: 'pending'|null }
export async function checkApproval(user) {
  if (user.email === ADMIN_EMAIL) return { approved: true }

  const { data } = await supabase
    .from('signup_requests')
    .select('status')
    .eq('email', user.email)
    .maybeSingle()

  if (data?.status === 'approved') return { approved: true }
  return { approved: false, existingStatus: data?.status ?? null }
}

// Log a user interaction (opens, saves, chat usage)
export async function logInteraction(articleId, action, timeSpentSeconds = null) {
  if (isMockMode) return
  await supabase.from('user_interactions').insert({
    article_id: articleId,
    action,
    time_spent_seconds: timeSpentSeconds,
  })
}

// Fetch today's daily summaries with category info
export async function fetchTodaySummaries(date) {
  if (isMockMode) return null
  const { data, error } = await supabase
    .from('daily_summaries')
    .select('*, category:categories(*)')
    .eq('date', date)
  if (error) throw error
  return data
}

// Fetch articles, optionally filtered by category
export async function fetchArticles(categoryId = null, limit = 50) {
  if (isMockMode) return null
  let query = supabase
    .from('articles')
    .select('*, source:sources(name), category:categories(name,color)')
    .order('impact_score', { ascending: false, nullsFirst: false })
    .order('published_at', { ascending: false })
    .limit(limit)
  if (categoryId) query = query.eq('primary_category_id', categoryId)
  const { data, error } = await query
  if (error) throw error
  return data
}

// Fetch or generate article analysis
export async function fetchAnalysis(articleId) {
  if (isMockMode) return null
  const { data, error } = await supabase
    .from('article_analyses')
    .select('*')
    .eq('article_id', articleId)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

// Toggle saved article
export async function toggleSaved(articleId, isSaved) {
  if (isMockMode) return
  if (isSaved) {
    await supabase.from('saved_articles').delete().eq('article_id', articleId)
  } else {
    await supabase.from('saved_articles').insert({ article_id: articleId })
  }
}

// ── Meeting Pack helpers (Phase 3a) ──

export async function listMeetings() {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('meetings')
    .select('id, title, status, created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getMeeting(id) {
  if (isMockMode) return null
  const { data, error } = await supabase.from('meetings').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

export async function createMeeting({ title, agenda, prospective_result, decision_questions }) {
  if (isMockMode) throw new Error('createMeeting unavailable in mock mode')
  const { data, error } = await supabase
    .from('meetings')
    .insert({ title, agenda, prospective_result, decision_questions, status: 'draft' })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function assemblePack(meetingId) {
  if (isMockMode) throw new Error('assemblePack unavailable in mock mode')
  // Optimistically flip status so the list reflects assembling immediately.
  await supabase.from('meetings').update({ status: 'assembling' }).eq('id', meetingId)
  const { error } = await supabase.functions.invoke('assemble-pack', { body: { meeting_id: meetingId } })
  if (error) {
    // Invoke never reached the function — roll the optimistic status back to a
    // recoverable terminal state so the meeting isn't stuck at 'assembling'
    // (where the UI disables Re-assemble and Approve).
    await supabase
      .from('meetings')
      .update({ status: 'error', error_message: `Failed to start pack assembly: ${error.message}` })
      .eq('id', meetingId)
    throw error
  }
}

export async function getCards(meetingId) {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('context_cards').select('*').eq('meeting_id', meetingId)
    .order('card_type').order('position')
  if (error) throw error
  return data
}

export async function setCardIncluded(cardId, included) {
  if (isMockMode) return
  const { error } = await supabase.from('context_cards').update({ included }).eq('id', cardId)
  if (error) throw error
}

export async function editCard(cardId, { headline, body }) {
  if (isMockMode) return
  const { error } = await supabase
    .from('context_cards').update({ headline, body, edited: true }).eq('id', cardId)
  if (error) throw error
}

export async function addManualCard(meetingId, { headline, body }) {
  if (isMockMode) return
  const { error } = await supabase.from('context_cards').insert({
    meeting_id: meetingId, card_type: 'manual', headline, body, included: true,
  })
  if (error) throw error
}

export async function approvePack(meetingId) {
  if (isMockMode) return
  const { error } = await supabase.from('meetings').update({ status: 'approved' }).eq('id', meetingId)
  if (error) throw error
}
