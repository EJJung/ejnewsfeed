import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

const PERIOD_TYPES = [
  { key: 'weekly',    label: 'Weekly' },
  { key: 'monthly',   label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'yearly',    label: 'Yearly' },
]

export default function TrendsView({ categories = [] }) {
  const [periodType, setPeriodType]   = useState('weekly')
  const [categoryId, setCategoryId]   = useState(null)  // null = all categories
  const [summaries, setSummaries]     = useState([])
  const [isLoading, setIsLoading]     = useState(true)

  // Set default category to first one
  useEffect(() => {
    if (categories.length && !categoryId) {
      setCategoryId(categories[0].id)
    }
  }, [categories])

  useEffect(() => {
    if (!categoryId) return
    fetchSummaries()
  }, [periodType, categoryId])

  async function fetchSummaries() {
    setIsLoading(true)
    setSummaries([])

    const { data, error } = await supabase
      .from('trend_summaries')
      .select('*, categories(name, color)')
      .eq('period_type', periodType)
      .eq('category_id', categoryId)
      .order('period_start', { ascending: false })
      .limit(20)

    if (!error && data) setSummaries(data)
    setIsLoading(false)
  }

  const selectedCategory = categories.find(c => c.id === categoryId)

  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* Category picker — horizontal scroll on mobile, left panel on desktop */}
      <div className="md:w-48 shrink-0 md:border-r border-b md:border-b-0 border-gray-100 md:py-6 md:px-3 md:space-y-0.5">
        <p className="hidden md:block text-xs font-medium text-gray-400 uppercase tracking-wider px-2 mb-3">Category</p>
        <div className="flex md:flex-col gap-1 px-3 py-2 md:p-0 overflow-x-auto">
          {categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setCategoryId(cat.id)}
              className={`flex items-center gap-2 px-3 py-1.5 md:px-2.5 md:py-2 rounded-md md:rounded-md text-sm transition-colors text-left whitespace-nowrap md:w-full ${
                categoryId === cat.id
                  ? 'bg-gray-100 text-gray-900 font-medium'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-5 md:px-8 md:py-8">

          {/* Header */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-1">
              {selectedCategory && (
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedCategory.color }} />
              )}
              <h1 className="text-xl font-semibold text-gray-900">
                {selectedCategory?.name} Trends
              </h1>
            </div>
            <p className="text-sm text-gray-400">
              How {selectedCategory?.name} topics have evolved over time
            </p>
          </div>

          {/* Period type tabs */}
          <div className="flex gap-1 mb-8 p-1 bg-gray-100 rounded-lg w-fit">
            {PERIOD_TYPES.map(pt => (
              <button
                key={pt.key}
                onClick={() => setPeriodType(pt.key)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors font-medium ${
                  periodType === pt.key
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {pt.label}
              </button>
            ))}
          </div>

          {/* Content */}
          {isLoading ? (
            <LoadingSkeleton />
          ) : summaries.length === 0 ? (
            <EmptyState periodType={periodType} />
          ) : (
            <div className="space-y-6">
              {summaries.map(summary => (
                <TrendCard key={summary.id} summary={summary} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TrendCard({ summary }) {
  const [expanded, setExpanded] = useState(false)
  const themes = Array.isArray(summary.key_themes)
    ? summary.key_themes
    : (summary.key_themes ? JSON.parse(summary.key_themes) : [])

  return (
    <div className="border border-gray-100 rounded-xl p-5 hover:border-gray-200 transition-colors">
      {/* Period label + article count */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-mono font-medium text-gray-400 bg-gray-50 px-2 py-1 rounded">
          {summary.period_label}
        </span>
        <span className="text-xs text-gray-400">
          {summary.article_count} article{summary.article_count !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Summary text */}
      <p className={`text-sm text-gray-700 leading-relaxed ${!expanded ? 'line-clamp-3' : ''}`}>
        {summary.summary}
      </p>

      {summary.summary?.length > 200 && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-xs text-gray-400 hover:text-gray-600 mt-1.5 transition-colors"
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}

      {/* Key themes */}
      {themes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-gray-50">
          {themes.map((theme, i) => (
            <span
              key={i}
              className="text-xs text-gray-500 bg-gray-50 border border-gray-100 px-2 py-0.5 rounded-full"
            >
              {theme}
            </span>
          ))}
        </div>
      )}

      {/* Period dates */}
      <p className="text-xs text-gray-300 mt-3">
        {summary.period_start} — {summary.period_end}
      </p>
    </div>
  )
}

function EmptyState({ periodType }) {
  const nextRunMap = {
    weekly:    'next Monday',
    monthly:   'the 1st of next month',
    quarterly: 'the start of next quarter',
    yearly:    'January 1st',
  }

  return (
    <div className="text-center py-16">
      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
        <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
        </svg>
      </div>
      <p className="text-sm text-gray-500 font-medium">No {periodType} trends yet</p>
      <p className="text-xs text-gray-400 mt-1">
        First {periodType} summary generates {nextRunMap[periodType]}.
      </p>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {[1, 2, 3].map(i => (
        <div key={i} className="border border-gray-100 rounded-xl p-5">
          <div className="flex justify-between mb-3">
            <div className="h-5 bg-gray-100 rounded w-20" />
            <div className="h-5 bg-gray-100 rounded w-16" />
          </div>
          <div className="space-y-2">
            <div className="h-3 bg-gray-100 rounded w-full" />
            <div className="h-3 bg-gray-100 rounded w-5/6" />
            <div className="h-3 bg-gray-100 rounded w-4/6" />
          </div>
          <div className="flex gap-2 mt-4 pt-3 border-t border-gray-50">
            <div className="h-5 bg-gray-100 rounded-full w-16" />
            <div className="h-5 bg-gray-100 rounded-full w-20" />
            <div className="h-5 bg-gray-100 rounded-full w-14" />
          </div>
        </div>
      ))}
    </div>
  )
}
