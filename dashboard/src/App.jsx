import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom'
import Sidebar from './components/Sidebar.jsx'
import ScanView from './components/ScanView.jsx'
import DiveView from './components/DiveView.jsx'
import TrendsView from './components/TrendsView.jsx'
import KnowledgeView from './components/KnowledgeView.jsx'
import InsightGraphView from './components/InsightGraphView.jsx'
import PodcastView from './components/PodcastView.jsx'
import MeetingsView from './components/MeetingsView.jsx'
import MeetingPack from './components/MeetingPack.jsx'
import MeetingSession from './components/MeetingSession.jsx'
import MeetingWriteback from './components/MeetingWriteback.jsx'
import LoginPage from './components/LoginPage.jsx'
import RequestAccessPage from './components/RequestAccessPage.jsx'
import { supabase, isMockMode, signOut, checkApproval, ADMIN_EMAIL } from './lib/supabase.js'
import { CATEGORIES } from './lib/mockData.js'
import PrivacyPage from './components/PrivacyPage.jsx'
import TermsPage from './components/TermsPage.jsx'
import AdminView from './components/AdminView.jsx'

const LS_KEY = 'ej_saved_article_ids'

// authState: 'loading' | 'unauthenticated' | 'checking' | 'request-access' | 'authenticated'

export default function App() {
  const [authState, setAuthState]     = useState(isMockMode ? 'authenticated' : 'loading')
  const [authUser, setAuthUser]       = useState(null)
  const [requestInfo, setRequestInfo] = useState(null) // { email, existingStatus }
  const [savedArticles, setSavedArticles] = useState(new Set())
  const [categories, setCategories]       = useState(CATEGORIES)
  const [sidebarOpen, setSidebarOpen]     = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  // Auth setup
  const handleAuthUser = useCallback(async (user) => {
    setAuthState('checking')
    setAuthUser(user)
    const result = await checkApproval(user)
    if (result.approved) {
      setAuthState('authenticated')
    } else {
      setRequestInfo({ email: user.email, existingStatus: result.existingStatus })
      setAuthState('request-access')
    }
  }, [])

  useEffect(() => {
    if (isMockMode) return

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        await handleAuthUser(session.user)
      } else {
        setAuthState('unauthenticated')
        setAuthUser(null)
        setRequestInfo(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [handleAuthUser])

  // Close sidebar on route change (mobile)
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  // Fetch live categories once authenticated
  useEffect(() => {
    if (isMockMode || authState !== 'authenticated') return
    supabase
      .from('categories')
      .select('id, name, color, description')
      .order('name')
      .then(({ data, error }) => {
        if (!error && data?.length) setCategories(data)
      })
  }, [authState])

  // Load saved articles — localStorage first (instant), then sync from Supabase
  useEffect(() => {
    const stored = JSON.parse(localStorage.getItem(LS_KEY) || '[]')
    if (stored.length) setSavedArticles(new Set(stored))

    if (isMockMode || authState !== 'authenticated') return

    supabase
      .from('saved_articles')
      .select('article_id')
      .then(({ data }) => {
        if (data) {
          const ids = new Set(data.map(r => r.article_id))
          setSavedArticles(ids)
          localStorage.setItem(LS_KEY, JSON.stringify([...ids]))
        }
      })
  }, [authState])

  async function handleToggleSave(articleId) {
    const isSaving = !savedArticles.has(articleId)
    const next = new Set(savedArticles)
    if (isSaving) next.add(articleId)
    else next.delete(articleId)

    // Update UI and localStorage immediately
    setSavedArticles(next)
    localStorage.setItem(LS_KEY, JSON.stringify([...next]))

    // Persist to Supabase in background
    if (!isMockMode) {
      if (isSaving) {
        await supabase.from('saved_articles').insert({ article_id: articleId })
      } else {
        await supabase.from('saved_articles').delete().eq('article_id', articleId)
      }
    }
  }

  function handleArticleClick(article) {
    navigate(`/article/${article.id}`, { state: { article } })
  }

  const isAdmin = isMockMode || authUser?.email === ADMIN_EMAIL
  const scanProps = { categories, onArticleClick: handleArticleClick, savedArticles, onToggleSave: handleToggleSave }

  // Auth gates
  if (authState === 'loading' || authState === 'checking') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <svg className="w-5 h-5 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  if (authState === 'unauthenticated') {
    return <LoginPage />
  }

  if (authState === 'request-access') {
    return (
      <RequestAccessPage
        email={requestInfo.email}
        existingStatus={requestInfo.existingStatus}
        onSignOut={signOut}
      />
    )
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {isMockMode && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-xs text-amber-800 text-center">
          Running in demo mode — add Supabase credentials to <code className="font-mono bg-amber-100 px-1 rounded">.env</code> to connect live data
        </div>
      )}

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar: hidden on mobile, shown as overlay when open */}
      <div className={`
        fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <Sidebar
          categories={categories}
          savedCount={savedArticles.size}
          onClose={() => setSidebarOpen(false)}
          isAdmin={isAdmin}
          onSignOut={isMockMode ? undefined : signOut}
        />
      </div>

      <main className={`flex-1 overflow-hidden ${isMockMode ? 'mt-8' : ''}`}>
        {/* Mobile header bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 -ml-1.5 rounded-md text-gray-500 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-pink-500 to-violet-600 flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-gray-900">EJ Newsfeed</span>
          </div>
        </div>

        <div className="mobile-content overflow-hidden">
          <Routes>
            <Route path="/" element={<Navigate to="/briefing" replace />} />
            <Route path="/briefing" element={<ScanView {...scanProps} selectedCategory={null} />} />
            <Route path="/podcast" element={<PodcastView />} />
            <Route path="/category/:categoryId" element={<CategoryRoute {...scanProps} />} />
            <Route path="/saved" element={<ScanView {...scanProps} selectedCategory="saved" />} />
            <Route path="/trends" element={<TrendsView categories={categories} />} />
            <Route path="/knowledge" element={<KnowledgeView categories={categories} />} />
            <Route path="/graph" element={<InsightGraphView categories={categories} />} />
            <Route path="/meetings" element={<MeetingsView />} />
            <Route path="/meetings/:id" element={<MeetingPack />} />
            <Route path="/meetings/:id/session" element={<MeetingSession />} />
            <Route path="/meetings/:id/writeback" element={<MeetingWriteback />} />
            <Route path="/article/:articleId" element={<ArticleRoute savedArticles={savedArticles} onToggleSave={handleToggleSave} />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/admin" element={isAdmin ? <AdminView /> : <Navigate to="/briefing" replace />} />
            <Route path="*" element={<Navigate to="/briefing" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}

function CategoryRoute(scanProps) {
  const { categoryId } = useParams()
  return <ScanView {...scanProps} selectedCategory={categoryId} />
}

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
