import { useState, useEffect } from 'react'
import { format, subDays } from 'date-fns'
import { CATEGORIES, TODAY_SUMMARIES, ARTICLES } from '../lib/mockData.js'
import { supabase, isMockMode } from '../lib/supabase.js'
import ArticleCard from './ArticleCard.jsx'

const today = format(new Date(), 'EEEE, MMMM d, yyyy')

export default function ScanView({ categories, selectedCategory, onArticleClick, savedArticles, onToggleSave }) {
  const [summaries, setSummaries]       = useState([])
  const [articles, setArticles]         = useState([])
  const [loading, setLoading]           = useState(true)
  const [refreshing, setRefreshing]     = useState(false)
  const [summaryDate, setSummaryDate]   = useState(null)
  const [lastFetched, setLastFetched]   = useState(null)
  const isSavedView = selectedCategory === 'saved'

  useEffect(() => {
    if (isMockMode) {
      setSummaries(TODAY_SUMMARIES)
      setArticles(ARTICLES)
      setLoading(false)
      return
    }
    fetchLiveData()
  }, [selectedCategory])

  // Auto-refresh when tab regains focus, but no more than once every 5 minutes
  useEffect(() => {
    if (isMockMode) return
    function handleFocus() {
      const fiveMinutes = 5 * 60 * 1000
      if (!lastFetched || Date.now() - lastFetched > fiveMinutes) {
        fetchLiveData(true)
      }
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [lastFetched, selectedCategory])

  async function fetchLiveData(silent = false) {
    if (silent) setRefreshing(true)
    else setLoading(true)
    try {
      const sevenDaysAgo = subDays(new Date(), 7).toISOString()

      // Fetch summaries for the last 7 days, find the most recent date that has them
      const { data: summaryRows } = await supabase
        .from('daily_summaries')
        .select('*, category:categories(id, name, color)')
        .gte('date', format(subDays(new Date(), 7), 'yyyy-MM-dd'))
        .order('date', { ascending: false })

      // Use the most recent date that has summaries
      const mostRecentDate = summaryRows?.[0]?.date || null
      const latestSummaries = mostRecentDate
        ? summaryRows.filter(s => s.date === mostRecentDate)
        : []

      setSummaryDate(mostRecentDate)
      setSummaries(latestSummaries)

      // Fetch recent articles (last 7 days)
      let articleQuery = supabase
        .from('articles')
        .select('*, source:sources(name), category:categories(id, name, color)')
        .gte('created_at', sevenDaysAgo)
        .order('created_at', { ascending: false })
        .limit(150)

      // Filter by category if one is selected — use the live UUID from Supabase
      if (selectedCategory && selectedCategory !== 'saved') {
        articleQuery = articleQuery.eq('primary_category_id', selectedCategory)
      }

      const { data: articleRows } = await articleQuery

      const normalisedArticles = (articleRows || []).map(a => ({
        ...a,
        source: a.source?.name || a.source,
        category_tags: a.category_tags || [a.category?.name].filter(Boolean),
      }))

      setArticles(normalisedArticles)
      setLastFetched(Date.now())
    } catch (err) {
      console.error('Failed to fetch live data:', err)
      if (!silent) {
        setSummaries(TODAY_SUMMARIES)
        setArticles(ARTICLES)
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  // Always use the categories prop (from Supabase via App) — never derive from summaries
  const displayCategories = (selectedCategory && !isSavedView)
    ? (categories || CATEGORIES).filter(c => c.id === selectedCategory)
    : (categories || CATEGORIES)

  const visibleArticles = isSavedView
    ? articles.filter(a => savedArticles.has(a.id))
    : articles

  // Did summaries come from a prior day?
  const todayISO = format(new Date(), 'yyyy-MM-dd')
  const summaryIsStale = summaryDate && summaryDate !== todayISO

  if (loading) return <LoadingSkeleton />

  return (
    <div className="h-full overflow-y-auto">
    <div className="max-w-3xl mx-auto px-6 py-8">

      {/* Header */}
      {!isSavedView ? (
        <div className="mb-8">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707" />
            </svg>
            Morning Briefing
          </div>
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-gray-900">{today}</h1>
            <button
              onClick={() => fetchLiveData(true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-40"
              title="Refresh feed"
            >
              <svg
                className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {visibleArticles.length} articles across {displayCategories.length} interest areas
            {summaryIsStale && (
              <span className="ml-2 text-amber-500">· Summaries from {summaryDate}</span>
            )}
          </p>
        </div>
      ) : (
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900">Saved Articles</h1>
          <p className="text-sm text-gray-500 mt-1">
            {savedArticles.size} article{savedArticles.size !== 1 ? 's' : ''} saved
          </p>
        </div>
      )}

      {/* Empty states */}
      {isSavedView && savedArticles.size === 0 && (
        <div className="text-center py-16 text-gray-400">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          <p className="text-sm">No saved articles yet.</p>
          <p className="text-xs mt-1">Click the bookmark icon on any article to save it.</p>
        </div>
      )}

      {!isSavedView && visibleArticles.length === 0 && summaries.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
          </svg>
          <p className="text-sm">No articles found for the past 7 days.</p>
          <p className="text-xs mt-1">Run the pipeline to fetch your newsletters.</p>
        </div>
      )}

      {/* Category sections */}
      {!isSavedView && displayCategories.map(cat => {
        const summary = summaries.find(s =>
          s.category_id === cat.id || s.category?.id === cat.id
        )
        const catArticles = visibleArticles.filter(
          a => a.primary_category_id === cat.id
        )
        // Skip category if there's nothing to show
        if (!summary && catArticles.length === 0) return null

        return (
          <CategorySection
            key={cat.id}
            category={cat}
            summary={summary}
            articles={catArticles}
            onArticleClick={onArticleClick}
            savedArticles={savedArticles}
            onToggleSave={onToggleSave}
          />
        )
      })}

      {/* Saved articles flat list */}
      {isSavedView && savedArticles.size > 0 && (
        <div className="space-y-3">
          {visibleArticles.map(article => {
            const cat = (categories || CATEGORIES).find(c => c.id === article.primary_category_id)
              || article.category
            return (
              <ArticleCard
                key={article.id}
                article={article}
                category={cat}
                isSaved={true}
                onArticleClick={onArticleClick}
                onToggleSave={onToggleSave}
              />
            )
          })}
        </div>
      )}
    </div>
    </div>
  )
}

function CategorySection({ category, summary, articles, onArticleClick, savedArticles, onToggleSave }) {
  return (
    <section className="mb-10">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: category.color }} />
        <h2 className="text-base font-semibold text-gray-900">{category.name}</h2>
        {summary && (
          <span className="text-xs text-gray-400 font-normal ml-1">
            {summary.article_count} article{summary.article_count !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {summary?.summary && (
        <div
          className="rounded-xl p-4 mb-4 text-sm text-gray-700 leading-relaxed border-l-4"
          style={{ backgroundColor: `${category.color}08`, borderColor: `${category.color}50` }}
        >
          {summary.summary}
        </div>
      )}

      <div className="space-y-2.5">
        {articles.map(article => (
          <ArticleCard
            key={article.id}
            article={article}
            category={category}
            isSaved={savedArticles.has(article.id)}
            onArticleClick={onArticleClick}
            onToggleSave={onToggleSave}
          />
        ))}
      </div>
    </section>
  )
}

function LoadingSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-8 animate-pulse">
      <div className="mb-8">
        <div className="h-3 bg-gray-100 rounded w-32 mb-2" />
        <div className="h-7 bg-gray-200 rounded w-72 mb-2" />
        <div className="h-3 bg-gray-100 rounded w-48" />
      </div>
      {[1, 2, 3].map(i => (
        <div key={i} className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2.5 h-2.5 rounded-full bg-gray-200" />
            <div className="h-4 bg-gray-200 rounded w-24" />
          </div>
          <div className="rounded-xl p-4 mb-4 bg-gray-50 space-y-2">
            <div className="h-3 bg-gray-200 rounded w-full" />
            <div className="h-3 bg-gray-200 rounded w-5/6" />
            <div className="h-3 bg-gray-200 rounded w-4/6" />
          </div>
          {[1, 2].map(j => (
            <div key={j} className="bg-white border border-gray-100 rounded-xl px-4 py-3.5 mb-2.5">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-100 rounded w-full mb-1" />
              <div className="h-3 bg-gray-100 rounded w-2/3" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
