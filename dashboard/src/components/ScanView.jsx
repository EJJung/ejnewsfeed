import { useState, useEffect } from 'react'
import { format, subDays, isToday, parseISO } from 'date-fns'
import { CATEGORIES, TODAY_SUMMARIES, ARTICLES } from '../lib/mockData.js'
import { supabase, isMockMode } from '../lib/supabase.js'
import ArticleCard from './ArticleCard.jsx'

const todayLabel = format(new Date(), 'EEEE, MMMM d, yyyy')
const todayISO   = format(new Date(), 'yyyy-MM-dd')

export default function ScanView({ categories, selectedCategory, onArticleClick, savedArticles, onToggleSave }) {
  const [summaries, setSummaries]         = useState([])
  const [articles, setArticles]           = useState([])
  const [loading, setLoading]             = useState(true)
  const [refreshing, setRefreshing]       = useState(false)
  const [summaryDate, setSummaryDate]     = useState(null)
  const [mostRecentDate, setMostRecentDate] = useState(todayISO)
  const [lastFetched, setLastFetched]     = useState(null)

  const isSavedView    = selectedCategory === 'saved'
  const isCategoryView = !!selectedCategory && !isSavedView
  const isBriefing     = !selectedCategory

  // Re-fetch when route changes
  useEffect(() => {
    if (isMockMode) {
      setSummaries(TODAY_SUMMARIES)
      setArticles(ARTICLES)
      setLoading(false)
      return
    }
    fetchLiveData()
  }, [selectedCategory])

  // Re-fetch saved view when the saved set changes (user saves/unsaves)
  useEffect(() => {
    if (!isSavedView || isMockMode) return
    fetchLiveData()
  }, [savedArticles])

  // Auto-refresh on focus with 5-minute cooldown
  useEffect(() => {
    if (isMockMode) return
    function handleFocus() {
      const fiveMinutes = 5 * 60 * 1000
      if (!lastFetched || Date.now() - lastFetched > fiveMinutes) fetchLiveData(true)
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [lastFetched, selectedCategory])

  async function fetchLiveData(silent = false) {
    if (silent) setRefreshing(true)
    else setLoading(true)

    try {
      // ── Saved view: fetch articles by saved IDs ──────────────────────────
      if (isSavedView) {
        const savedIds = [...savedArticles]
        if (savedIds.length === 0) {
          setArticles([])
        } else {
          const { data } = await supabase
            .from('articles')
            .select('*, source:sources(name), category:categories(id, name, color)')
            .in('id', savedIds)
            .order('created_at', { ascending: false })
          setArticles(normalise(data || []))
        }
        setLastFetched(Date.now())
        return
      }

      // ── Briefing / Category view: fetch summaries ────────────────────────
      let summaryQuery = supabase
        .from('daily_summaries')
        .select('*, category:categories(id, name, color)')
        .gte('date', format(subDays(new Date(), 7), 'yyyy-MM-dd'))
        .order('date', { ascending: false })

      if (isCategoryView) summaryQuery = summaryQuery.eq('category_id', selectedCategory)

      const { data: summaryRows } = await summaryQuery
      const latestSummaryDate = summaryRows?.[0]?.date || null
      const latestSummaries = latestSummaryDate
        ? summaryRows.filter(s => s.date === latestSummaryDate)
        : []
      setSummaryDate(latestSummaryDate)
      setSummaries(latestSummaries)

      // ── Fetch articles ───────────────────────────────────────────────────
      // Order by impact_score first so high-impact items rise to the top
      // within each day, then by published_at as a freshness tiebreaker.
      let articleQuery = supabase
        .from('articles')
        .select('*, source:sources(name), category:categories(id, name, color)')
        .order('impact_score', { ascending: false, nullsFirst: false })
        .order('published_at', { ascending: false })

      if (isBriefing) {
        // Morning Briefing: fetch all articles from the last 7 days so past news
        // can be shown under each category. Find the most recent published date
        // first — that date's articles are shown as "current", older ones as "past".
        const { data: latestArticleRow } = await supabase
          .from('articles')
          .select('published_at')
          .order('published_at', { ascending: false })
          .limit(1)
        const latestDate = latestArticleRow?.[0]?.published_at?.slice(0, 10) || todayISO
        setMostRecentDate(latestDate)
        articleQuery = articleQuery
          .gte('published_at', subDays(new Date(), 7).toISOString())
          .limit(500)
      } else {
        // Category view: last 7 days for that category
        articleQuery = articleQuery
          .gte('published_at', subDays(new Date(), 7).toISOString())
          .eq('primary_category_id', selectedCategory)
          .limit(200)
      }

      const { data: articleRows } = await articleQuery
      setArticles(normalise(articleRows || []))
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

  // Split articles into "current" vs "past".
  // For briefing: current = most recent date in DB (may not be today if pipeline
  // was down), past = everything older within the 7-day fetch window.
  // For category view: current = today, past = all other days in the 7-day window.
  const currentDateKey = isBriefing ? mostRecentDate : todayISO

  const currentArticles = articles.filter(a => (a.published_at || '').startsWith(currentDateKey))
  const pastArticles    = articles.filter(a => !(a.published_at || '').startsWith(currentDateKey))

  // Group past articles by date (used by category view's flat PastNewsSection)
  const pastByDate = pastArticles.reduce((acc, a) => {
    const d = (a.published_at || '').slice(0, 10)
    if (!acc[d]) acc[d] = []
    acc[d].push(a)
    return acc
  }, {})
  const pastDates = Object.keys(pastByDate).sort((a, b) => b.localeCompare(a))

  const displayCategories = isCategoryView
    ? (categories || CATEGORIES).filter(c => c.id === selectedCategory)
    : (categories || CATEGORIES)

  const summaryIsStale = summaryDate && summaryDate !== todayISO

  if (loading) return <LoadingSkeleton />

  return (
    <div className="h-full overflow-y-auto">
    <div className="max-w-3xl mx-auto px-4 py-5 md:px-6 md:py-8">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      {!isSavedView ? (
        <div className="mb-8">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707" />
            </svg>
            {isCategoryView
              ? (displayCategories[0]?.name || 'Category')
              : 'Morning Briefing'}
          </div>
          <div className="flex items-center justify-between">
            <h1 className="text-xl md:text-2xl font-semibold text-gray-900">{todayLabel}</h1>
            <button
              onClick={() => fetchLiveData(true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-40"
            >
              <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {isBriefing
              ? `${articles.length} article${articles.length !== 1 ? 's' : ''} across ${displayCategories.length} interest areas`
              : `${currentArticles.length} today · ${pastArticles.length} past`}
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

      {/* ── Empty states ────────────────────────────────────────────────── */}
      {isSavedView && savedArticles.size === 0 && (
        <div className="text-center py-16 text-gray-400">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          <p className="text-sm">No saved articles yet.</p>
          <p className="text-xs mt-1">Click the bookmark icon on any article to save it.</p>
        </div>
      )}

      {!isSavedView && articles.length === 0 && summaries.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
          </svg>
          <p className="text-sm">No articles yet for today.</p>
          <p className="text-xs mt-1">The pipeline runs at 10am and 6pm ET — check back then.</p>
        </div>
      )}

      {/* ── Category sections (briefing or today's articles in category view) */}
      {!isSavedView && displayCategories.map(cat => {
        const summary     = summaries.find(s => s.category_id === cat.id || s.category?.id === cat.id)
        const catCurrent  = currentArticles.filter(a => a.primary_category_id === cat.id)
        const catPast     = pastArticles.filter(a => a.primary_category_id === cat.id)
        if (!summary && catCurrent.length === 0 && catPast.length === 0) return null

        return (
          <CategorySection
            key={cat.id}
            category={cat}
            summary={summary}
            articles={catCurrent}
            pastArticles={isBriefing ? catPast : []}
            onArticleClick={onArticleClick}
            savedArticles={savedArticles}
            onToggleSave={onToggleSave}
          />
        )
      })}

      {/* ── Past News (category view only) ─────────────────────────────── */}
      {isCategoryView && pastDates.length > 0 && (
        <PastNewsSection
          pastByDate={pastByDate}
          pastDates={pastDates}
          categories={categories}
          onArticleClick={onArticleClick}
          savedArticles={savedArticles}
          onToggleSave={onToggleSave}
        />
      )}

      {/* ── Saved articles list ─────────────────────────────────────────── */}
      {isSavedView && savedArticles.size > 0 && (
        <div className="space-y-3">
          {articles.map(article => {
            const cat = (categories || CATEGORIES).find(c => c.id === article.primary_category_id) || article.category
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

// ── Components ──────────────────────────────────────────────────────────────

function CategorySection({ category, summary, articles, pastArticles = [], onArticleClick, savedArticles, onToggleSave }) {
  // Group past articles by date for this category
  const pastByDate = pastArticles.reduce((acc, a) => {
    const d = (a.published_at || '').slice(0, 10)
    if (!acc[d]) acc[d] = []
    acc[d].push(a)
    return acc
  }, {})
  const pastDates = Object.keys(pastByDate).sort((a, b) => b.localeCompare(a))

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

      {/* Past articles for this category, grouped by date */}
      {pastDates.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-px flex-1 bg-gray-200" />
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Past News</span>
            <div className="h-px flex-1 bg-gray-200" />
          </div>

          {pastDates.map(date => (
            <div key={date} className="mb-6">
              <div className="flex items-center gap-2 mb-2.5">
                <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <h3 className="text-xs font-semibold text-gray-400">
                  {format(parseISO(date + 'T12:00:00Z'), 'EEEE, MMMM d')}
                </h3>
                <span className="text-xs text-gray-300">
                  · {pastByDate[date].length} article{pastByDate[date].length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="space-y-2.5">
                {pastByDate[date].map(article => (
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
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function PastNewsSection({ pastByDate, pastDates, categories, onArticleClick, savedArticles, onToggleSave }) {
  return (
    <section className="mt-2">
      {/* Divider */}
      <div className="flex items-center gap-3 mb-6">
        <div className="h-px flex-1 bg-gray-200" />
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Past News</span>
        <div className="h-px flex-1 bg-gray-200" />
      </div>

      {pastDates.map(date => {
        const dateArticles = pastByDate[date]
        // Parse as noon UTC to avoid any off-by-one from timezone
        const dateLabel = format(parseISO(date + 'T12:00:00Z'), 'EEEE, MMMM d')

        return (
          <div key={date} className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <h3 className="text-sm font-semibold text-gray-500">{dateLabel}</h3>
              <span className="text-xs text-gray-400">
                · {dateArticles.length} article{dateArticles.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="space-y-2.5">
              {dateArticles.map(article => {
                const cat = (categories || CATEGORIES).find(c => c.id === article.primary_category_id)
                  || article.category
                return (
                  <ArticleCard
                    key={article.id}
                    article={article}
                    category={cat}
                    isSaved={savedArticles.has(article.id)}
                    onArticleClick={onArticleClick}
                    onToggleSave={onToggleSave}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function LoadingSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-5 md:px-6 md:py-8 animate-pulse">
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
            <div className="h-3 bg-gray-100 rounded w-4/6" />
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

// ── Utilities ───────────────────────────────────────────────────────────────

function normalise(articles) {
  return articles.map(a => ({
    ...a,
    source: a.source?.name || a.source,
    category_tags: a.category_tags || [a.category?.name].filter(Boolean),
  }))
}
