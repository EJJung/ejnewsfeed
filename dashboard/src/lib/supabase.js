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

// ── Companion session helpers (Phase 3b) ──

export async function getSessionMessages(meetingId) {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('session_messages').select('id, role, content, seq')
    .eq('meeting_id', meetingId).order('seq', { ascending: true })
  if (error) throw error
  return data
}

async function invokeSessionChat(payload) {
  const { data, error } = await supabase.functions.invoke('session-chat', { body: payload })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data.reply
}

export async function startSession(meetingId) {
  if (isMockMode) throw new Error('startSession unavailable in mock mode')
  return invokeSessionChat({ meeting_id: meetingId, start: true })
}

export async function sendSessionMessage(meetingId, text) {
  if (isMockMode) throw new Error('sendSessionMessage unavailable in mock mode')
  return invokeSessionChat({ meeting_id: meetingId, message: text })
}

export async function endSession(meetingId) {
  if (isMockMode) return
  const { error } = await supabase.from('meetings').update({ status: 'complete' }).eq('id', meetingId)
  if (error) throw error
}

// ── Write-back helpers (Phase 3c) ──

export async function getProposals(meetingId) {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('writeback_proposals').select('*').eq('meeting_id', meetingId).order('kind').order('created_at')
  if (error) throw error
  return data
}

async function invokeWriteback(meetingId, mode) {
  const { data, error } = await supabase.functions.invoke('writeback', { body: { meeting_id: meetingId, mode } })
  if (error) throw error
  if (data?.ok === false) throw new Error(data.error || 'writeback failed')
  return data
}

export async function extractWriteback(meetingId) {
  if (isMockMode) throw new Error('extractWriteback unavailable in mock mode')
  return invokeWriteback(meetingId, 'extract')
}

export async function commitWriteback(meetingId) {
  if (isMockMode) throw new Error('commitWriteback unavailable in mock mode')
  return invokeWriteback(meetingId, 'commit')
}

export async function setProposalIncluded(id, included) {
  if (isMockMode) return
  const { error } = await supabase.from('writeback_proposals').update({ included }).eq('id', id)
  if (error) throw error
}

export async function editProposal(id, { text, detail, domains }) {
  if (isMockMode) return
  const { error } = await supabase
    .from('writeback_proposals').update({ text, detail, domains, edited: true }).eq('id', id)
  if (error) throw error
}

// ── Podcast helpers ──

// Fetch ready podcast episodes, newest first (Podcast view).
export async function listEpisodes() {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('episodes')
    .select('id, kind, title, script, duration_seconds, published_at, audio_url')
    .eq('status', 'ready')
    .order('published_at', { ascending: false })
  if (error) throw error
  return data
}

// ── Insight Graph helpers ──

// Fetch all rows from a select in pages, so a >1000-row table isn't silently
// truncated by PostgREST's default cap.
async function fetchAllPaged(makeQuery, pageSize = 1000) {
  const all = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1)
    if (error) throw error
    all.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return all
}

// Fetch insights (+ source id-pairs) for the co-citation graph.
export async function fetchInsightsForGraph(includeCandidates = false) {
  if (isMockMode) return { insights: [], sources: [] }
  const statuses = includeCandidates ? ['active', 'candidate'] : ['active']
  const [insightsRes, sources] = await Promise.all([
    supabase.from('insights').select('id, text, domains, confidence, status').in('status', statuses),
    fetchAllPaged(() => supabase.from('insight_sources').select('insight_id, article_id')),
  ])
  if (insightsRes.error) throw insightsRes.error
  return { insights: insightsRes.data || [], sources }
}

// Fetch one insight's hydrated sources for the graph side panel.
export async function fetchInsightSources(insightId) {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('insight_sources')
    .select('relation, article:articles(id, title, url, snippet, source:sources(name))')
    .eq('insight_id', insightId)
  if (error) throw error
  return data || []
}

// ── Recommendation inputs ──

// Assemble the raw signals the recommender scores over.
export async function fetchRecommendationInputs() {
  if (isMockMode) {
    return { candidates: [], interactions: [], savedCategoryIds: [], insightArticleIds: [], activeDomains: [] }
  }
  const [cRes, iRes, sRes, aRes] = await Promise.all([
    supabase.from('articles')
      .select('*, source:sources(name), category:categories(name,color)')
      .order('impact_score', { ascending: false, nullsFirst: false })
      .order('published_at', { ascending: false })
      .limit(200),
    supabase.from('user_interactions').select('action, article:articles(primary_category_id)'),
    supabase.from('saved_articles').select('article:articles(primary_category_id)'),
    supabase.from('insights').select('id, domains').eq('status', 'active'),
  ])
  for (const r of [cRes, iRes, sRes, aRes]) if (r.error) throw r.error

  const activeInsights = aRes.data || []
  const activeInsightIds = activeInsights.map((x) => x.id)
  const activeDomains = [...new Set(activeInsights.flatMap((x) => x.domains || []))]

  let insightArticleIds = []
  if (activeInsightIds.length) {
    const { data, error } = await supabase
      .from('insight_sources').select('article_id').in('insight_id', activeInsightIds)
    if (error) throw error
    insightArticleIds = [...new Set((data || []).map((r) => r.article_id))]
  }

  const interactions = (iRes.data || []).map((r) => ({ action: r.action, category_id: r.article?.primary_category_id }))
  const savedCategoryIds = (sRes.data || []).map((r) => r.article?.primary_category_id).filter(Boolean)

  return { candidates: cRes.data || [], interactions, savedCategoryIds, insightArticleIds, activeDomains }
}
