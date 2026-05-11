import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseKey  = import.meta.env.VITE_SUPABASE_ANON_KEY

// Returns null in mock mode (no env vars set)
export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null

export const isMockMode = !supabase

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
