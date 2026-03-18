import { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom'
import Sidebar from './components/Sidebar.jsx'
import ScanView from './components/ScanView.jsx'
import DiveView from './components/DiveView.jsx'
import TrendsView from './components/TrendsView.jsx'
import { supabase, isMockMode } from './lib/supabase.js'
import { CATEGORIES } from './lib/mockData.js'

export default function App() {
  const [savedArticles, setSavedArticles]   = useState(new Set())
  const [categories, setCategories]         = useState(CATEGORIES)
  const navigate = useNavigate()

  // Fetch live categories once on mount
  useEffect(() => {
    if (isMockMode) return
    supabase
      .from('categories')
      .select('id, name, color, description')
      .order('name')
      .then(({ data, error }) => {
        if (!error && data?.length) setCategories(data)
      })
  }, [])

  function handleArticleClick(article) {
    navigate(`/article/${article.id}`, { state: { article } })
  }

  function handleToggleSave(articleId) {
    setSavedArticles(prev => {
      const next = new Set(prev)
      if (next.has(articleId)) next.delete(articleId)
      else next.add(articleId)
      return next
    })
  }

  const scanProps = { categories, onArticleClick: handleArticleClick, savedArticles, onToggleSave: handleToggleSave }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {isMockMode && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-xs text-amber-800 text-center">
          Running in demo mode — add Supabase credentials to <code className="font-mono bg-amber-100 px-1 rounded">.env</code> to connect live data
        </div>
      )}

      <Sidebar categories={categories} savedCount={savedArticles.size} />

      <main className={`flex-1 overflow-hidden ${isMockMode ? 'mt-8' : ''}`}>
        <Routes>
          <Route path="/" element={<Navigate to="/briefing" replace />} />
          <Route path="/briefing" element={<ScanView {...scanProps} selectedCategory={null} />} />
          <Route path="/category/:categoryId" element={<CategoryRoute {...scanProps} />} />
          <Route path="/saved" element={<ScanView {...scanProps} selectedCategory="saved" />} />
          <Route path="/trends" element={<TrendsView categories={categories} />} />
          <Route path="/article/:articleId" element={<ArticleRoute savedArticles={savedArticles} onToggleSave={handleToggleSave} />} />
          <Route path="*" element={<Navigate to="/briefing" replace />} />
        </Routes>
      </main>
    </div>
  )
}

// Pulls categoryId from the URL and passes it to ScanView
function CategoryRoute(scanProps) {
  const { categoryId } = useParams()
  return <ScanView {...scanProps} selectedCategory={categoryId} />
}

// Loads the article from router state (fast) or fetches from Supabase (direct URL access)
function ArticleRoute({ savedArticles, onToggleSave }) {
  const { articleId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [article, setArticle] = useState(location.state?.article || null)
  const [loading, setLoading] = useState(!location.state?.article)

  useEffect(() => {
    if (article) return
    supabase
      .from('articles')
      .select('*, category:categories(id, name, color)')
      .eq('id', articleId)
      .single()
      .then(({ data }) => {
        if (data) setArticle(data)
        setLoading(false)
      })
  }, [articleId])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading article…
      </div>
    )
  }

  if (!article) return <Navigate to="/briefing" replace />

  return (
    <DiveView
      article={article}
      onBack={() => navigate(-1)}
      savedArticles={savedArticles}
      onToggleSave={onToggleSave}
    />
  )
}
