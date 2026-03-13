import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar.jsx'
import ScanView from './components/ScanView.jsx'
import DiveView from './components/DiveView.jsx'
import TrendsView from './components/TrendsView.jsx'
import { supabase, isMockMode } from './lib/supabase.js'
import { CATEGORIES } from './lib/mockData.js'

export default function App() {
  const [view, setView]                         = useState('scan')
  const [selectedArticle, setSelectedArticle]   = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [savedArticles, setSavedArticles]       = useState(new Set())
  const [activeNav, setActiveNav]               = useState('briefing')
  const [categories, setCategories]             = useState(CATEGORIES)

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
    setSelectedArticle(article)
    setView('dive')
  }

  function handleBack() {
    setView('scan')
    setSelectedArticle(null)
  }

  function handleNavSelect(key) {
    setActiveNav(key)
    setSelectedArticle(null)
    if (key === 'trends') {
      setView('trends')
      setSelectedCategory(null)
    } else {
      setView('scan')
      if (key === 'briefing' || key === 'saved') {
        setSelectedCategory(key === 'saved' ? 'saved' : null)
      } else {
        setSelectedCategory(key)
      }
    }
  }

  function handleToggleSave(articleId) {
    setSavedArticles(prev => {
      const next = new Set(prev)
      if (next.has(articleId)) next.delete(articleId)
      else next.add(articleId)
      return next
    })
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {isMockMode && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-xs text-amber-800 text-center">
          Running in demo mode — add Supabase credentials to <code className="font-mono bg-amber-100 px-1 rounded">.env</code> to connect live data
        </div>
      )}

      <Sidebar
        categories={categories}
        activeNav={activeNav}
        onNavSelect={handleNavSelect}
        savedCount={savedArticles.size}
      />

      <main className={`flex-1 overflow-hidden ${isMockMode ? 'mt-8' : ''}`}>
        {view === 'trends' ? (
          <TrendsView categories={categories} />
        ) : view === 'scan' ? (
          <ScanView
            categories={categories}
            selectedCategory={selectedCategory}
            onArticleClick={handleArticleClick}
            savedArticles={savedArticles}
            onToggleSave={handleToggleSave}
          />
        ) : (
          <DiveView
            article={selectedArticle}
            onBack={handleBack}
            savedArticles={savedArticles}
            onToggleSave={handleToggleSave}
          />
        )}
      </main>
    </div>
  )
}
