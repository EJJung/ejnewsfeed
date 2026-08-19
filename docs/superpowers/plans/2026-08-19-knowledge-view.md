# Dashboard Knowledge View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/knowledge` page to the dashboard that browses the `insights` table — domain picker, active/contested-by-default status filter, and inline expand-to-sources with a supporting/contradicting split for contested insights.

**Architecture:** One new React component (`KnowledgeView.jsx`) modeled directly on the existing `TrendsView.jsx` (left domain picker + right card list, same loading/empty/error state conventions), wired into `App.jsx`'s router and `Sidebar.jsx`'s nav. Data comes straight from the `supabase` browser client (RLS already grants `anon` SELECT on `insights`/`insight_sources`), matching every other view in this dashboard — no new backend work.

**Tech Stack:** React (Vite), Tailwind CSS (utility classes, no CSS files), `@supabase/supabase-js` browser client, `date-fns` for relative timestamps — all already dependencies of `dashboard/`.

## Global Constraints

- Domain slugs are exactly: `ai`, `it`, `entrepreneurship`, `business`, `ux`, mapping to `categories.name` values `AI`, `IT`, `Entrepreneurship`, `Business`, `UX Design` respectively (same mapping as `distill-insights`'s `DOMAIN_TO_CATEGORY`).
- `insights.status` values are exactly: `candidate`, `active`, `contested`, `superseded`, `rejected`.
- Default status filter (toggle off): `active` + `contested` only. Toggle on: all 5 statuses.
- Sort: `contested` status first, then everything else; within each group, ordered by `last_confirmed_at ?? first_seen_at` descending (NOT `created_at` — that was a mistake caught and fixed during spec self-review).
- Source expansion is inline/in-place (accordion), fetched lazily only when a card is expanded — no dedicated route, no eager N+1 fetch on page load.
- Supporting/Contradicting source groups only render as two separate labeled groups when an insight has both relation types; otherwise render one flat list.
- No mock-mode (`isMockMode`) support — follows `TrendsView.jsx`'s precedent exactly (no mock branch in that file).
- No automated test suite exists anywhere in `dashboard/` — verification is running the dev server and checking the page in a browser against live data, per this codebase's established convention.
- Full spec: `docs/superpowers/specs/2026-08-19-knowledge-view-design.md`.

---

### Task 1: Knowledge view — component, routing, and nav

**Files:**
- Create: `dashboard/src/components/KnowledgeView.jsx`
- Modify: `dashboard/src/App.jsx:6` (add import), `dashboard/src/App.jsx:202` (add route, right after the `/trends` route)
- Modify: `dashboard/src/components/Sidebar.jsx:18` (add `handleNav` case), `dashboard/src/components/Sidebar.jsx:88-89` (add `NavItem`, between the existing Trends and Saved items)

**Interfaces:**
- Consumes: `supabase` client from `../lib/supabase.js` (same import every other view uses); `categories` array (`{id, name, color, description}`) passed down from `App.jsx`, same as `<TrendsView categories={categories} />` already receives.
- Produces: `KnowledgeView` default export, a route at `/knowledge`, and a `Sidebar` nav entry — nothing else in the codebase depends on this component's internals.

- [ ] **Step 1: Create `dashboard/src/components/KnowledgeView.jsx`**

```jsx
import { useState, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { supabase } from '../lib/supabase.js'

const DOMAINS = [
  { id: 'ai', label: 'AI', categoryName: 'AI' },
  { id: 'it', label: 'IT', categoryName: 'IT' },
  { id: 'entrepreneurship', label: 'Entrepreneurship', categoryName: 'Entrepreneurship' },
  { id: 'business', label: 'Business', categoryName: 'Business' },
  { id: 'ux', label: 'UX Design', categoryName: 'UX Design' },
]

const STATUS_BADGE = {
  active:     { label: 'Active',     className: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  contested:  { label: 'Contested',  className: 'bg-amber-50 text-amber-700 border-amber-100' },
  candidate:  { label: 'Candidate',  className: 'bg-gray-50 text-gray-500 border-gray-100' },
  superseded: { label: 'Superseded', className: 'bg-gray-50 text-gray-400 border-gray-100' },
  rejected:   { label: 'Rejected',   className: 'bg-gray-50 text-gray-400 border-gray-100' },
}

export default function KnowledgeView({ categories = [] }) {
  const [domainId, setDomainId]               = useState('all')
  const [showAllStatuses, setShowAllStatuses] = useState(false)
  const [insights, setInsights]               = useState([])
  const [candidateCount, setCandidateCount]   = useState(0)
  const [isLoading, setIsLoading]             = useState(true)
  const [error, setError]                     = useState(null)

  useEffect(() => {
    fetchInsights()
  }, [domainId, showAllStatuses])

  async function fetchInsights() {
    setIsLoading(true)
    setError(null)

    let query = supabase.from('insights').select('*').order('created_at', { ascending: false })
    if (domainId !== 'all') query = query.contains('domains', [domainId])
    query = showAllStatuses
      ? query.in('status', ['candidate', 'active', 'contested', 'superseded', 'rejected'])
      : query.in('status', ['active', 'contested'])

    const { data, error: fetchError } = await query

    if (fetchError) {
      setError(fetchError.message)
      setInsights([])
      setIsLoading(false)
      return
    }

    const sorted = sortInsights(data || [])
    setInsights(sorted)

    // If the default (active+contested) filter came back empty, check whether
    // there are candidates awaiting the weekly review, so the empty state can
    // tell EJ why — rather than just looking broken.
    if (sorted.length === 0 && !showAllStatuses) {
      let countQuery = supabase.from('insights').select('id', { count: 'exact', head: true }).eq('status', 'candidate')
      if (domainId !== 'all') countQuery = countQuery.contains('domains', [domainId])
      const { count } = await countQuery
      setCandidateCount(count || 0)
    } else {
      setCandidateCount(0)
    }

    setIsLoading(false)
  }

  function sortInsights(rows) {
    return [...rows].sort((a, b) => {
      const aContested = a.status === 'contested' ? 0 : 1
      const bContested = b.status === 'contested' ? 0 : 1
      if (aContested !== bContested) return aContested - bContested
      const aTime = a.last_confirmed_at || a.first_seen_at
      const bTime = b.last_confirmed_at || b.first_seen_at
      return new Date(bTime) - new Date(aTime)
    })
  }

  function colorForDomain(id) {
    const domain = DOMAINS.find(d => d.id === id)
    const category = categories.find(c => c.name === domain?.categoryName)
    return category?.color || '#9CA3AF'
  }

  const activeDomain = DOMAINS.find(d => d.id === domainId)

  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* Domain picker */}
      <div className="md:w-48 shrink-0 md:border-r border-b md:border-b-0 border-gray-100 md:py-6 md:px-3 md:space-y-0.5">
        <p className="hidden md:block text-xs font-medium text-gray-400 uppercase tracking-wider px-2 mb-3">Domain</p>
        <div className="flex md:flex-col gap-1 px-3 py-2 md:p-0 overflow-x-auto">
          <button
            onClick={() => setDomainId('all')}
            className={`flex items-center gap-2 px-3 py-1.5 md:px-2.5 md:py-2 rounded-md text-sm transition-colors text-left whitespace-nowrap md:w-full ${
              domainId === 'all'
                ? 'bg-gray-100 text-gray-900 font-medium'
                : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
            }`}
          >
            All
          </button>
          {DOMAINS.map(d => (
            <button
              key={d.id}
              onClick={() => setDomainId(d.id)}
              className={`flex items-center gap-2 px-3 py-1.5 md:px-2.5 md:py-2 rounded-md text-sm transition-colors text-left whitespace-nowrap md:w-full ${
                domainId === d.id
                  ? 'bg-gray-100 text-gray-900 font-medium'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorForDomain(d.id) }} />
              {d.label}
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
              {activeDomain && (
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colorForDomain(activeDomain.id) }} />
              )}
              <h1 className="text-xl font-semibold text-gray-900">
                {activeDomain ? `${activeDomain.label} Insights` : 'All Insights'}
              </h1>
            </div>
            <p className="text-sm text-gray-400">
              Durable claims distilled from your reading, linked back to their sources
            </p>
          </div>

          {/* Status toggle */}
          <label className="flex items-center gap-2 mb-8 text-sm text-gray-500 cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={showAllStatuses}
              onChange={(e) => setShowAllStatuses(e.target.checked)}
              className="rounded border-gray-300 text-gray-900 focus:ring-gray-400"
            />
            Show all statuses
          </label>

          {/* Content */}
          {isLoading ? (
            <LoadingSkeleton />
          ) : error ? (
            <ErrorState message={error} onRetry={fetchInsights} />
          ) : insights.length === 0 ? (
            <EmptyState
              domainLabel={activeDomain?.label}
              showAllStatuses={showAllStatuses}
              candidateCount={candidateCount}
            />
          ) : (
            <div className="space-y-4">
              {insights.map(insight => (
                <InsightCard key={insight.id} insight={insight} allInsights={insights} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function InsightCard({ insight, allInsights }) {
  const [expanded, setExpanded] = useState(false)
  const [sources, setSources] = useState(null)
  const [loadingSources, setLoadingSources] = useState(false)

  const badge = STATUS_BADGE[insight.status] || STATUS_BADGE.candidate
  const timeLabel = insight.last_confirmed_at || insight.first_seen_at
  const timeAgo = timeLabel ? formatDistanceToNow(new Date(timeLabel), { addSuffix: true }) : null
  const domainLabel = (insight.domains || [])
    .map(d => DOMAINS.find(x => x.id === d)?.label || d)
    .join(' · ')

  async function handleToggleExpand() {
    const next = !expanded
    setExpanded(next)
    if (next && sources === null) {
      setLoadingSources(true)
      const { data } = await supabase
        .from('insight_sources')
        .select('relation, article:articles(id, title, url, snippet, source:sources(name))')
        .eq('insight_id', insight.id)
      setSources(data || [])
      setLoadingSources(false)
    }
  }

  const supporting = (sources || []).filter(s => s.relation === 'supporting')
  const contradicting = (sources || []).filter(s => s.relation === 'contradicting')

  const supersededByText = insight.status === 'superseded' && insight.superseded_by
    ? allInsights.find(i => i.id === insight.superseded_by)?.text
    : null

  return (
    <div className="border border-gray-100 rounded-xl p-5 hover:border-gray-200 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${badge.className}`}>
            {badge.label}
          </span>
          {domainLabel && <span className="text-xs text-gray-400">{domainLabel}</span>}
        </div>
        {timeAgo && <span className="text-xs text-gray-400">{timeAgo}</span>}
      </div>

      <p className="text-sm text-gray-900 leading-relaxed">{insight.text}</p>

      <p className="text-xs text-gray-400 mt-2">
        confidence {typeof insight.confidence === 'number' ? insight.confidence.toFixed(2) : '—'}
      </p>

      {insight.status === 'superseded' ? (
        supersededByText && (
          <p className="text-xs text-gray-400 mt-3 pt-3 border-t border-gray-50">
            → superseded by: {supersededByText.slice(0, 100)}{supersededByText.length > 100 ? '…' : ''}
          </p>
        )
      ) : (
        <div className="mt-3 pt-3 border-t border-gray-50">
          <button
            onClick={handleToggleExpand}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
          >
            <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
            {sources ? `${sources.length} source${sources.length !== 1 ? 's' : ''}` : 'Sources'}
          </button>

          {expanded && (
            loadingSources ? (
              <p className="text-xs text-gray-300 mt-2">Loading sources…</p>
            ) : (
              <div className="mt-2 space-y-3">
                {supporting.length > 0 && contradicting.length > 0 ? (
                  <>
                    <SourceGroup label={`Supporting (${supporting.length})`} items={supporting} />
                    <SourceGroup label={`Contradicting (${contradicting.length})`} items={contradicting} />
                  </>
                ) : (
                  <SourceGroup items={[...supporting, ...contradicting]} />
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

function SourceGroup({ label, items }) {
  return (
    <div>
      {label && <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>}
      <ul className="space-y-1">
        {items.map(({ article }) => article && (
          <li key={article.id} className="text-xs text-gray-500">
            {article.url ? (
              <a href={article.url} target="_blank" rel="noreferrer" className="hover:text-gray-700 hover:underline">
                → {article.title}
              </a>
            ) : (
              <span>→ {article.title}</span>
            )}
            {article.source?.name && <span className="text-gray-300"> — {article.source.name}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function EmptyState({ domainLabel, showAllStatuses, candidateCount }) {
  const hasCandidates = !showAllStatuses && candidateCount > 0
  return (
    <div className="text-center py-16">
      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
        <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
      </div>
      <p className="text-sm text-gray-500 font-medium">
        No {showAllStatuses ? '' : 'active '}insights yet{domainLabel ? ` for ${domainLabel}` : ''}
      </p>
      <p className="text-xs text-gray-400 mt-1">
        {hasCandidates
          ? `${candidateCount} candidate${candidateCount !== 1 ? 's' : ''} awaiting the weekly review — toggle "Show all statuses" to see them.`
          : "The daily distillation job hasn't found anything durable enough to keep here yet."}
      </p>
    </div>
  )
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="text-center py-16">
      <p className="text-sm text-red-500 font-medium">Couldn't load insights</p>
      <p className="text-xs text-gray-400 mt-1 mb-4">{message}</p>
      <button
        onClick={onRetry}
        className="text-xs text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors"
      >
        Try again
      </button>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3].map(i => (
        <div key={i} className="border border-gray-100 rounded-xl p-5">
          <div className="flex justify-between mb-3">
            <div className="h-5 bg-gray-100 rounded w-24" />
            <div className="h-5 bg-gray-100 rounded w-12" />
          </div>
          <div className="space-y-2">
            <div className="h-3 bg-gray-100 rounded w-full" />
            <div className="h-3 bg-gray-100 rounded w-3/4" />
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Wire the route into `dashboard/src/App.jsx`**

Add the import next to the other view imports (after the existing `import TrendsView from './components/TrendsView.jsx'` line):

```jsx
import TrendsView from './components/TrendsView.jsx'
import KnowledgeView from './components/KnowledgeView.jsx'
```

Add the route inside `<Routes>`, immediately after the existing `/trends` route:

```jsx
<Route path="/trends" element={<TrendsView categories={categories} />} />
<Route path="/knowledge" element={<KnowledgeView categories={categories} />} />
```

- [ ] **Step 3: Add the nav item in `dashboard/src/components/Sidebar.jsx`**

In `handleNav`, add a case for `'knowledge'` right after the existing `'trends'` case:

```jsx
function handleNav(key) {
  if (key === 'briefing') navigate('/briefing')
  else if (key === 'saved') navigate('/saved')
  else if (key === 'trends') navigate('/trends')
  else if (key === 'knowledge') navigate('/knowledge')
  else if (key === 'admin') navigate('/admin')
  else navigate(`/category/${key}`)
}
```

Add a `NavItem` between the existing "Trends" `NavItem` and the "Saved" `NavItem` (i.e., right after the Trends `NavItem`'s closing `/>` and before the Saved `NavItem`):

```jsx
<NavItem
  label="Knowledge"
  isActive={activeNav === 'knowledge'}
  onClick={() => handleNav('knowledge')}
  icon={
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
    </svg>
  }
/>
```

No change is needed to the `activeNav` derivation logic (`const parts = location.pathname.split('/')...`) — it already falls through generically to `parts[0]` for any route that isn't `category/:id` or the default, so `/knowledge` → `activeNav === 'knowledge'` works automatically, the same way `'trends'`/`'saved'`/`'admin'` already do.

- [ ] **Step 4: Start the dev server and verify in a browser**

```bash
cd dashboard && npm run dev
```

Expected: Vite starts, prints a local URL (default `http://localhost:5173`).

Using a browser (e.g. via browser automation tooling), navigate to the dashboard, log in if needed, then:

1. Click "Knowledge" in the sidebar (between Trends and Saved) — confirm it navigates to `/knowledge` and highlights as active.
2. Confirm the domain picker shows "All, AI, IT, Entrepreneurship, Business, UX Design" and each domain (except All) shows a colored dot matching that category's color elsewhere in the app (e.g. compare against the same dot color in the sidebar's category list).
3. With "All" selected and "Show all statuses" off: confirm only `active`/`contested` insights render (there is real data — this session's distillation testing left real `active` and `contested` insights in the `business` and `it` domains). A `contested` insight should visually stand out (amber/red badge) and should sort before `active` ones.
4. Click a `contested` insight's "Sources" toggle: confirm it expands in place, shows a loading state briefly, then renders two labeled groups, "Supporting" and "Contradicting", each listing at least one article with a working link (or plain text if the article has no URL) and a source name.
5. Click an `active` insight's "Sources" toggle: confirm it shows one flat, unlabeled source list (no "Supporting"/"Contradicting" split, since it only has one relation type).
6. Toggle "Show all statuses" on: confirm `candidate`, `superseded`, and `rejected` insights now also appear, each with a distinct gray badge. Find a `superseded` insight and confirm it shows "→ superseded by: ..." instead of a sources toggle.
7. Select a specific domain (e.g. "Business") with "Show all statuses" off: confirm the list filters to only insights whose `domains` array includes `business`.
8. Select a domain/status combination you expect to be empty (e.g. a domain with no `active`/`contested` insights, "Show all statuses" off): confirm the empty state renders, and if that domain has `candidate` rows, confirm the empty-state text mentions the candidate count.
9. Check the browser console for errors during all of the above — none expected.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/KnowledgeView.jsx dashboard/src/App.jsx dashboard/src/components/Sidebar.jsx
git commit -m "feat: add dashboard Knowledge view for browsing insights"
```
