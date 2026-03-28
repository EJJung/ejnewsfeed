import { useState, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { CATEGORIES, ARTICLE_ANALYSES } from '../lib/mockData.js'
import { supabase, isMockMode } from '../lib/supabase.js'
import ChatPanel from './ChatPanel.jsx'

export default function DiveView({ article, onBack, savedArticles, onToggleSave }) {
  const [analysis, setAnalysis] = useState(null)
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(true)
  const [note, setNote] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteSaved, setNoteSaved] = useState(false)
  const [showChat, setShowChat] = useState(false)

  // Category: use embedded join data from live articles, or look up from mock list
  const category = article?.category
    || CATEGORIES.find(c => c.id === article?.primary_category_id)

  const isSaved = savedArticles.has(article?.id)
  const timeAgo = article?.published_at
    ? formatDistanceToNow(new Date(article.published_at), { addSuffix: true })
    : null

  // Load existing note whenever a saved article is opened
  useEffect(() => {
    setNote('')
    setNoteSaved(false)
    if (!isSaved || isMockMode || !article?.id) return
    supabase
      .from('saved_articles')
      .select('notes')
      .eq('article_id', article.id)
      .maybeSingle()
      .then(({ data }) => { if (data?.notes) setNote(data.notes) })
  }, [article?.id, isSaved])

  async function handleNoteBlur() {
    if (!isSaved || isMockMode) return
    setNoteSaving(true)
    const { error } = await supabase
      .from('saved_articles')
      .update({ notes: note })
      .eq('article_id', article.id)
    setNoteSaving(false)
    if (error) {
      console.error('Failed to save note:', error)
      setNoteSaved(false)
    } else {
      setNoteSaved(true)
      setTimeout(() => setNoteSaved(false), 2000)
    }
  }

  useEffect(() => {
    if (!article) return
    setIsLoadingAnalysis(true)
    setAnalysis(null)

    if (isMockMode) {
      // Mock mode: use pre-built analyses or generate placeholder
      const prebuilt = ARTICLE_ANALYSES[article.id]
      setTimeout(() => {
        setAnalysis(prebuilt || buildPlaceholderAnalysis(category?.name))
        setIsLoadingAnalysis(false)
      }, prebuilt ? 600 : 2200)
      return
    }

    // Live mode: fetch from Supabase, or generate on-demand via Edge Function
    fetchLiveAnalysis(article.id)
  }, [article?.id])

  async function fetchLiveAnalysis(articleId) {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

      const res = await fetch(`${supabaseUrl}/functions/v1/generate-analysis`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ articleId }),
      })

      const data = await res.json()

      if (data.ok && data.analysis) {
        setAnalysis(data.analysis)
      } else {
        console.error('generate-analysis failed:', data.error)
        setAnalysis(null)
      }
    } catch (err) {
      console.error('fetchLiveAnalysis error:', err)
      setAnalysis(null)
    } finally {
      setIsLoadingAnalysis(false)
    }
  }

  function buildPlaceholderAnalysis(catName) {
    return {
      key_points: [
        `This article covers a significant development in the ${catName || 'news'} space.`,
        "The key takeaway relates to how established players are responding to new market pressures.",
        "Short-term impact will be felt primarily among early adopters, with broader effects in 12–18 months.",
        "Several second-order effects are worth tracking beyond the headline.",
      ],
      so_what: `The significance of this piece extends beyond its immediate subject. It signals a broader pattern of change in how ${catName || 'this space'} is evolving — specifically the tension between incumbents defending existing positions and new entrants moving faster without legacy constraints.`,
      implications: "Watch for competitive responses in the next 60–90 days. There's also a regulatory dimension developing quietly that could accelerate or complicate this trajectory.",
      interest_connections: [
        { category: 'Business', connection: "Direct implications for competitive strategy and market positioning." },
        { category: 'Entrepreneurship', connection: "Creates a window of opportunity for startups who can move faster than incumbents." },
      ],
    }
  }

  if (!article) return null

  return (
    <div className="flex flex-col md:flex-row h-full relative">
      {/* Left: Article + Analysis (scrollable) */}
      <div className="flex-1 overflow-y-auto md:border-r border-gray-100">
        <div className="max-w-2xl mx-auto px-4 py-5 md:px-8 md:py-8">
          {/* Back nav */}
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors mb-6"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Morning Briefing
          </button>

          {/* Article header */}
          <div className="mb-6">
            {category && (
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: category.color }} />
                <span className="text-xs font-medium" style={{ color: category.color }}>{category.name}</span>
              </div>
            )}

            <h1 className="text-xl font-semibold text-gray-900 leading-snug mb-3">
              {article.title}
            </h1>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                {article.source && <span>{article.source}</span>}
                {timeAgo && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span>{timeAgo}</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Save */}
                <button
                  onClick={() => onToggleSave(article.id)}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                    isSaved
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'text-gray-500 border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill={isSaved ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                  {isSaved ? 'Saved' : 'Save'}
                </button>
                {/* Read original */}
                {article.url && (
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-gray-500 border border-gray-200 hover:border-gray-300 hover:bg-gray-50 px-2.5 py-1.5 rounded-lg transition-colors"
                  >
                    Read original
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            </div>

            {/* Snippet */}
            <p className="text-sm text-gray-600 leading-relaxed mt-4 pt-4 border-t border-gray-100">
              {article.snippet}
            </p>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-6">
            <div className="h-px flex-1 bg-gray-100" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">In-Depth Analysis</span>
            <div className="h-px flex-1 bg-gray-100" />
          </div>

          {/* Analysis */}
          {isLoadingAnalysis ? (
            <AnalysisSkeleton />
          ) : analysis ? (
            <Analysis analysis={analysis} />
          ) : (
            <p className="text-sm text-gray-400 text-center py-8">
              Analysis unavailable — check back shortly.
            </p>
          )}

          {/* My Notes — only visible when article is saved */}
          {isSaved && (
            <div className="mt-8 pb-8">
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-gray-100" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">My Notes</span>
                <div className="h-px flex-1 bg-gray-100" />
              </div>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                onBlur={handleNoteBlur}
                placeholder="Add your personal notes on this article…"
                rows={4}
                className="w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 placeholder-gray-400 leading-relaxed"
              />
              <div className="text-right mt-1.5 text-xs text-gray-400 h-4">
                {noteSaving ? 'Saving…' : noteSaved ? '✓ Saved' : ''}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mobile chat toggle button */}
      <button
        onClick={() => setShowChat(!showChat)}
        className="md:hidden fixed bottom-4 right-4 z-30 bg-gray-900 text-white rounded-full p-3 shadow-lg hover:bg-gray-800 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {showChat
            ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            : <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          }
        </svg>
      </button>

      {/* Right: Chat panel — overlay on mobile, fixed column on desktop */}
      <div className={`
        fixed inset-0 z-20 bg-white flex flex-col
        md:relative md:inset-auto md:w-[360px] md:shrink-0 md:z-auto
        ${showChat ? 'flex' : 'hidden md:flex'}
      `}>
        {/* Mobile chat header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 md:hidden">
          <span className="text-sm font-medium text-gray-700">Ask about this article</span>
          <button onClick={() => setShowChat(false)} className="p-1 rounded-md text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <ChatPanel article={article} />
        </div>
      </div>
    </div>
  )
}

function Analysis({ analysis }) {
  return (
    <div className="space-y-6">
      {/* Key Points */}
      <AnalysisSection
        icon="✦"
        title="Key Points"
        color="#6366f1"
      >
        <ul className="space-y-2.5">
          {analysis.key_points.map((point, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-gray-700 leading-relaxed">
              <span className="text-gray-300 mt-0.5 shrink-0 text-xs font-mono">{String(i + 1).padStart(2, '0')}</span>
              {point}
            </li>
          ))}
        </ul>
      </AnalysisSection>

      {/* So What */}
      <AnalysisSection icon="◈" title="So What" color="#10b981">
        <p className="text-sm text-gray-700 leading-relaxed">{analysis.so_what}</p>
      </AnalysisSection>

      {/* Implications */}
      <AnalysisSection icon="◉" title="Watch For" color="#f59e0b">
        <p className="text-sm text-gray-700 leading-relaxed">{analysis.implications}</p>
      </AnalysisSection>

      {/* Interest connections */}
      {analysis.interest_connections?.length > 0 && (
        <AnalysisSection icon="⇢" title="Connects To Your Interests" color="#ec4899">
          <div className="space-y-3">
            {analysis.interest_connections.map((conn, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <span className="text-xs font-medium bg-gray-100 text-gray-700 px-2 py-0.5 rounded shrink-0 mt-0.5">
                  {conn.category}
                </span>
                <p className="text-sm text-gray-600 leading-relaxed">{conn.connection}</p>
              </div>
            ))}
          </div>
        </AnalysisSection>
      )}
    </div>
  )
}

function AnalysisSection({ icon, title, color, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm" style={{ color }}>{icon}</span>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="pl-5">{children}</div>
    </div>
  )
}

function AnalysisSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {[1, 2, 3].map(i => (
        <div key={i}>
          <div className="h-3 bg-gray-100 rounded w-24 mb-4" />
          <div className="space-y-2.5 pl-5">
            <div className="h-3 bg-gray-100 rounded w-full" />
            <div className="h-3 bg-gray-100 rounded w-5/6" />
            <div className="h-3 bg-gray-100 rounded w-4/6" />
          </div>
        </div>
      ))}
      <p className="text-xs text-center text-gray-400 pt-2">Generating analysis with Claude…</p>
    </div>
  )
}
