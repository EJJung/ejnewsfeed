import { useState, useEffect } from 'react'
import { fetchRecommendationInputs } from '../lib/supabase.js'
import { computeAffinity, scoreArticles } from '../lib/recommend.js'
import ArticleCard from './ArticleCard.jsx'

const DOMAIN_TO_CATEGORY = {
  ai: 'AI', it: 'IT', entrepreneurship: 'Entrepreneurship', business: 'Business', ux: 'UX Design',
}

export default function RecommendedView({ categories = [], onArticleClick, savedArticles = new Set(), onToggleSave }) {
  const [ranked, setRanked] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function load() {
    setIsLoading(true)
    setError(null)
    try {
      const inp = await fetchRecommendationInputs()
      const affinity = computeAffinity(inp.interactions, inp.savedCategoryIds)
      const activeCategoryNames = new Set(inp.activeDomains.map((d) => DOMAIN_TO_CATEGORY[d]).filter(Boolean))
      const scored = scoreArticles(inp.candidates, {
        affinity,
        insightArticleIds: new Set(inp.insightArticleIds),
        activeCategoryNames,
        savedIds: savedArticles,
        now: new Date().toISOString(),
      })
      setRanked(scored)
    } catch (e) {
      setError(e.message)
      setRanked([])
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-5 md:px-8 md:py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Recommended</h1>
          <p className="text-sm text-gray-400">
            Ranked for you by impact, recency, and how it connects to what you're learning
          </p>
        </div>

        {isLoading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : ranked.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {ranked.map(({ article, reason }) => {
              const cat = categories.find((c) => c.id === article.primary_category_id) || article.category
              return (
                <div key={article.id}>
                  <p className="text-xs text-gray-400 mb-1 ml-1">{reason}</p>
                  <ArticleCard
                    article={article}
                    category={cat}
                    isSaved={savedArticles.has(article.id)}
                    onArticleClick={onArticleClick}
                    onToggleSave={onToggleSave}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <p className="text-sm text-gray-500 font-medium">Nothing to recommend yet</p>
      <p className="text-xs text-gray-400 mt-1">Once articles are ingested, your ranked reading list appears here.</p>
    </div>
  )
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="text-center py-16">
      <p className="text-sm text-red-500 font-medium">Couldn't load recommendations</p>
      <p className="text-xs text-gray-400 mt-1 mb-4">{message}</p>
      <button onClick={onRetry} className="text-xs text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors">
        Try again
      </button>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="border border-gray-100 rounded-xl p-5">
          <div className="h-3 bg-gray-100 rounded w-24 mb-3" />
          <div className="h-4 bg-gray-100 rounded w-3/4" />
        </div>
      ))}
    </div>
  )
}
