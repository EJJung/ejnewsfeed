# Recommendation Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire engagement capture and add a "Recommended" dashboard view that ranks articles by a blended (content + knowledge + affinity) score.

**Architecture:** Part A wires the existing `logInteraction()` into `opened`/`saved`/`read_full` interaction points. Part B adds pure, unit-tested scoring (`recommend.js`), a data helper (`fetchRecommendationInputs`), and `RecommendedView.jsx` (fetch → compute signals → `scoreArticles` → ranked `ArticleCard`s), plus `/recommended` route + nav item.

**Tech Stack:** React 18, react-router-dom 7, Tailwind, Supabase JS, Vitest (configured).

## Global Constraints

- Frontend in `dashboard/`; run all `npm`/`npx` from `dashboard/`.
- Match `KnowledgeView.jsx` conventions (local `useState`, `useEffect` fetch, gray palette, shared loading/error/empty patterns, `max-w-2xl mx-auto` container).
- `logInteraction(articleId, action, timeSpentSeconds?)` already exists in `lib/supabase.js` and no-ops in mock mode; call it fire-and-forget (do not `await` in click handlers).
- Scoring weights (exact): `score = 0.35*impact + 0.20*recency + 0.25*affinity + 0.15*srcBoost + 0.05*catBoost`. Affinity action-weights: `opened`=1, `read_full`=3, `saved`=5. Recency: `max(0, 1 - ageDays/30)`, null date → 0. Affinity normalized by max affinity across categories.
- Reason priority: source-boost → affinity(≥0.5)+category → impact(≥0.6) → "Recent".
- Data helpers respect `isMockMode` (return empty) so the app runs without Supabase env vars.
- `impact_score` is a 0–1 float (live range ~0–0.72); `ArticleCard({ article, category, isSaved, onArticleClick, onToggleSave })`; resolve `category` via `categories.find(c => c.id === article.primary_category_id) || article.category` (the ScanView pattern).
- Domain→category map (reused from KnowledgeView): `ai→AI, it→IT, entrepreneurship→Entrepreneurship, business→Business, ux→UX Design`.

---

### Task 1: Engagement capture (Part A)

Wire `logInteraction` so `user_interactions` finally accrues signal.

**Files:**
- Modify: `dashboard/src/App.jsx` (import + `handleArticleClick` + `handleToggleSave`)
- Modify: `dashboard/src/components/DiveView.jsx` (import + a `read_full` effect)

**Interfaces:** none produced (side-effect wiring).

- [ ] **Step 1: Log `opened` and `saved` in App.jsx**

In `dashboard/src/App.jsx`, add `logInteraction` to the existing lib import (line 16):
```jsx
import { supabase, isMockMode, signOut, checkApproval, ADMIN_EMAIL, logInteraction } from './lib/supabase.js'
```

In `handleArticleClick` (currently just navigates), log the open before navigating:
```jsx
  function handleArticleClick(article) {
    logInteraction(article.id, 'opened')
    navigate(`/article/${article.id}`, { state: { article } })
  }
```

In `handleToggleSave`, log a `saved` interaction inside the `isSaving` branch (right after the `saved_articles` insert):
```jsx
      if (isSaving) {
        await supabase.from('saved_articles').insert({ article_id: articleId })
        logInteraction(articleId, 'saved')
      } else {
```

- [ ] **Step 2: Log `read_full` in DiveView.jsx**

In `dashboard/src/components/DiveView.jsx`, add `logInteraction` to the existing lib import (line 4):
```jsx
import { supabase, isMockMode, logInteraction } from '../lib/supabase.js'
```

Add a new effect (place it right after the existing `useEffect` block that loads the saved note, around line 35) that logs a full-read once per article:
```jsx
  useEffect(() => {
    if (article?.id) logInteraction(article.id, 'read_full')
  }, [article?.id])
```

- [ ] **Step 3: Verify build**

Run from `dashboard/`:
```bash
npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/App.jsx dashboard/src/components/DiveView.jsx
git commit -m "feat: capture engagement (opened/saved/read_full) via logInteraction"
```

---

### Task 2: Pure scoring (`recommend.js`) — TDD

**Files:**
- Create: `dashboard/src/lib/recommend.js`
- Test: `dashboard/src/lib/recommend.test.js`

**Interfaces:**
- `computeAffinity(interactions, savedCategoryIds) -> { [categoryId]: number }`
- `recencyScore(publishedAt, now) -> number` (0–1)
- `scoreArticles(candidates, signals) -> [{ article, score, reason }]` sorted desc; `signals = { affinity, insightArticleIds, activeCategoryNames, savedIds, now }`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/lib/recommend.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { computeAffinity, recencyScore, scoreArticles } from './recommend.js'

describe('computeAffinity', () => {
  it('weights actions and sums per category', () => {
    const aff = computeAffinity(
      [{ action: 'opened', category_id: 'a' }, { action: 'read_full', category_id: 'a' }, { action: 'opened', category_id: 'b' }],
      ['a'],
    )
    expect(aff).toEqual({ a: 1 + 3 + 5, b: 1 }) // a: opened1+read_full3+saved5=9, b: 1
  })
  it('ignores unknown actions and null categories, empty → {}', () => {
    expect(computeAffinity([{ action: 'weird', category_id: 'a' }, { action: 'opened', category_id: null }], [])).toEqual({ a: 0 })
    expect(computeAffinity([], [])).toEqual({})
  })
})

describe('recencyScore', () => {
  const now = '2026-08-27T00:00:00Z'
  it('is ~1 for a just-published article', () => {
    expect(recencyScore('2026-08-27T00:00:00Z', now)).toBeCloseTo(1, 5)
  })
  it('decays to 0 by 30 days and clamps', () => {
    expect(recencyScore('2026-07-28T00:00:00Z', now)).toBeCloseTo(0, 1) // 30 days
    expect(recencyScore('2026-06-01T00:00:00Z', now)).toBe(0) // >30 days clamped
  })
  it('null date → 0', () => {
    expect(recencyScore(null, now)).toBe(0)
  })
})

describe('scoreArticles', () => {
  const now = '2026-08-27T00:00:00Z'
  const base = (id, extra = {}) => ({ id, impact_score: 0.5, published_at: now, primary_category_id: 'a', category: { name: 'AI' }, ...extra })

  it('excludes saved articles', () => {
    const out = scoreArticles([base('x'), base('y')], { savedIds: new Set(['x']), now })
    expect(out.map(r => r.article.id)).toEqual(['y'])
  })

  it('ranks a source-of-active-insight article above an equal non-source one', () => {
    const out = scoreArticles([base('x'), base('y')], { insightArticleIds: new Set(['y']), now })
    expect(out[0].article.id).toBe('y')
    expect(out[0].reason).toBe('Sources an active insight')
  })

  it('affinity raises a matching-category article', () => {
    const out = scoreArticles(
      [base('x', { primary_category_id: 'a' }), base('y', { primary_category_id: 'b' })],
      { affinity: { a: 10, b: 0 }, now },
    )
    expect(out[0].article.id).toBe('x')
  })

  it('returns [] for no candidates and sorts descending', () => {
    expect(scoreArticles([], { now })).toEqual([])
    const out = scoreArticles([base('x', { impact_score: 0.1 }), base('y', { impact_score: 0.9 })], { now })
    expect(out.map(r => r.article.id)).toEqual(['y', 'x'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/recommend.test.js
```
Expected: FAIL — `Failed to resolve import "./recommend.js"`.

- [ ] **Step 3: Implement recommend.js**

Create `dashboard/src/lib/recommend.js`:
```js
// Pure scoring for the Recommended view — no I/O, unit-testable.

const ACTION_WEIGHTS = { opened: 1, read_full: 3, saved: 5 }

// Sum engagement weight per category from interactions + saves.
export function computeAffinity(interactions, savedCategoryIds) {
  const affinity = {}
  for (const { action, category_id } of interactions || []) {
    if (!category_id) continue
    affinity[category_id] = (affinity[category_id] || 0) + (ACTION_WEIGHTS[action] || 0)
  }
  for (const category_id of savedCategoryIds || []) {
    if (!category_id) continue
    affinity[category_id] = (affinity[category_id] || 0) + ACTION_WEIGHTS.saved
  }
  return affinity
}

// Linear recency in [0,1]: 1 when fresh, 0 at/after 30 days or when undated.
export function recencyScore(publishedAt, now) {
  if (!publishedAt) return 0
  const ageDays = (new Date(now) - new Date(publishedAt)) / 86400000
  return Math.max(0, 1 - ageDays / 30)
}

function toSet(v) {
  return v instanceof Set ? v : new Set(v || [])
}

function pickReason({ srcBoost, aff, impact, categoryName }) {
  if (srcBoost) return 'Sources an active insight'
  if (aff >= 0.5 && categoryName) return `Matches your ${categoryName} reading`
  if (impact >= 0.6) return 'High impact'
  return 'Recent'
}

// Rank candidate articles by the blended score. Excludes saved articles.
export function scoreArticles(candidates, signals) {
  const { affinity = {}, now } = signals || {}
  const insightSet = toSet(signals?.insightArticleIds)
  const savedSet = toSet(signals?.savedIds)
  const catNameSet = toSet(signals?.activeCategoryNames)
  const affValues = Object.values(affinity)
  const maxAff = affValues.length ? Math.max(...affValues) : 0

  const scored = []
  for (const article of candidates || []) {
    if (savedSet.has(article.id)) continue
    const impact = typeof article.impact_score === 'number' ? article.impact_score : 0
    const recency = recencyScore(article.published_at, now)
    const affRaw = affinity[article.primary_category_id] || 0
    const aff = maxAff > 0 ? affRaw / maxAff : 0
    const srcBoost = insightSet.has(article.id) ? 1 : 0
    const catBoost = catNameSet.has(article.category?.name) ? 1 : 0
    const score = 0.35 * impact + 0.2 * recency + 0.25 * aff + 0.15 * srcBoost + 0.05 * catBoost
    const reason = pickReason({ srcBoost, aff, impact, categoryName: article.category?.name })
    scored.push({ article, score, reason })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/recommend.test.js
```
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/recommend.js dashboard/src/lib/recommend.test.js
git commit -m "feat: add pure recommendation scoring (computeAffinity, recencyScore, scoreArticles) + tests"
```

---

### Task 3: Data helper (`fetchRecommendationInputs`)

**Files:**
- Modify: `dashboard/src/lib/supabase.js` (append helper)

**Interfaces:**
- `fetchRecommendationInputs() -> Promise<{ candidates, interactions, savedCategoryIds, insightArticleIds, activeDomains }>`; all-empty in mock mode.

- [ ] **Step 1: Append the helper**

Append to `dashboard/src/lib/supabase.js`:
```js
// ── Recommendation inputs ──

// Assemble the raw signals the recommender scores over.
export async function fetchRecommendationInputs() {
  if (isMockMode) {
    return { candidates: [], interactions: [], savedCategoryIds: [], insightArticleIds: [], activeDomains: [] }
  }
  const [cRes, iRes, sRes, aRes] = await Promise.all([
    supabase.from('articles')
      .select('*, source:sources(name), category:categories(name,color)')
      .order('impact_score', { ascending: false, nullsFirst: false })
      .order('published_at', { ascending: false })
      .limit(200),
    supabase.from('user_interactions').select('action, article:articles(primary_category_id)'),
    supabase.from('saved_articles').select('article:articles(primary_category_id)'),
    supabase.from('insights').select('id, domains').eq('status', 'active'),
  ])
  for (const r of [cRes, iRes, sRes, aRes]) if (r.error) throw r.error

  const activeInsights = aRes.data || []
  const activeInsightIds = activeInsights.map((x) => x.id)
  const activeDomains = [...new Set(activeInsights.flatMap((x) => x.domains || []))]

  let insightArticleIds = []
  if (activeInsightIds.length) {
    const { data, error } = await supabase
      .from('insight_sources').select('article_id').in('insight_id', activeInsightIds)
    if (error) throw error
    insightArticleIds = [...new Set((data || []).map((r) => r.article_id))]
  }

  const interactions = (iRes.data || []).map((r) => ({ action: r.action, category_id: r.article?.primary_category_id }))
  const savedCategoryIds = (sRes.data || []).map((r) => r.article?.primary_category_id).filter(Boolean)

  return { candidates: cRes.data || [], interactions, savedCategoryIds, insightArticleIds, activeDomains }
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: build succeeds (helper exported, not yet used).

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/lib/supabase.js
git commit -m "feat: add fetchRecommendationInputs data helper"
```

---

### Task 4: `RecommendedView` component

**Files:**
- Create: `dashboard/src/components/RecommendedView.jsx`

**Interfaces:**
- Consumes: `fetchRecommendationInputs` (`../lib/supabase.js`); `computeAffinity`, `scoreArticles` (`../lib/recommend.js`); `ArticleCard` (`./ArticleCard.jsx`).
- Produces: `default export RecommendedView({ categories, onArticleClick, savedArticles, onToggleSave })`.

- [ ] **Step 1: Write the component**

Create `dashboard/src/components/RecommendedView.jsx`:
```jsx
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
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: build succeeds (component not yet routed — Task 5).

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/RecommendedView.jsx
git commit -m "feat: add RecommendedView (ranked articles with reason tags)"
```

---

### Task 5: Nav item + route wiring

**Files:**
- Modify: `dashboard/src/components/Sidebar.jsx`
- Modify: `dashboard/src/App.jsx`

**Interfaces:** Consumes `RecommendedView`; the existing `NavItem`/`handleNav`/`activeNav` machinery and `scanProps`.

- [ ] **Step 1: Add the nav route case in `Sidebar.jsx`**

In `handleNav`, after the `briefing` line:
```js
    else if (key === 'recommended') navigate('/recommended')
```

- [ ] **Step 2: Add the `NavItem` in `Sidebar.jsx`**

Immediately after the "Morning Briefing" `<NavItem ... />` block, insert:
```jsx
        <NavItem
          label="Recommended"
          isActive={activeNav === 'recommended'}
          onClick={() => handleNav('recommended')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          }
        />
```

- [ ] **Step 3: Import and route `RecommendedView` in `App.jsx`**

Add the import near the other view imports:
```jsx
import RecommendedView from './components/RecommendedView.jsx'
```

Add the route inside `<Routes>`, directly after the `/briefing` route (`scanProps` already carries `categories`, `onArticleClick`, `savedArticles`, `onToggleSave`):
```jsx
            <Route path="/recommended" element={<RecommendedView {...scanProps} />} />
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```
Expected: build succeeds with the import and route resolved.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/Sidebar.jsx dashboard/src/App.jsx
git commit -m "feat: wire Recommended nav item and /recommended route"
```

---

### Task 6: End-to-end verification

**Files:** none.

- [ ] **Step 1: All unit tests + build pass**

```bash
npm run test && npm run build
```
Expected: Vitest all-green (recommend + graph + episodes suites); build succeeds.

- [ ] **Step 2: Run the dashboard against real data**

If `dashboard/.env.local` has `VITE_SUPABASE_*` (from prior work), skip; else:
```bash
vercel env pull /tmp/ej_vercel.env --environment=production --yes
grep -E '^VITE_SUPABASE_(URL|ANON_KEY)=' /tmp/ej_vercel.env > dashboard/.env.local
```
Then `npm run dev` and sign in as `ej.newsfeed@gmail.com`.

- [ ] **Step 3: Verify the view + capture loop**

- Open `/recommended` (or click **Recommended**): a ranked list of articles renders, each with a small **reason** tag ("High impact" / "Recent" / "Sources an active insight" / "Matches your … reading").
- Click an article to open it → then query production `user_interactions` and confirm a fresh `opened` row exists for that article id.
- Save an article from the list → confirm a `saved` row appears.
- Reload `/recommended` → the list still renders (and excludes the just-saved article).
- No console errors.

---

## Self-Review

**Spec coverage:**
- Part A capture: `opened`/`saved`/`read_full` → Task 1 ✅
- Pure scoring `computeAffinity`/`recencyScore`/`scoreArticles` with exact weights → Task 2 ✅
- `fetchRecommendationInputs` (candidates, interactions, saved categories, active-insight article ids, active domains) → Task 3 ✅
- `RecommendedView` (fetch → signals → score → ArticleCards + reason; states; mock mode) → Task 4 ✅
- Nav + `/recommended` route with scanProps → Task 5 ✅
- Testing: unit + build + live E2E incl. capture-loop check → Tasks 2, 6 ✅

**Placeholder scan:** No TBD/TODO; every step carries concrete code/commands. ✅

**Type consistency:** `computeAffinity(interactions, savedCategoryIds)` and `scoreArticles(candidates, {affinity, insightArticleIds, activeCategoryNames, savedIds, now})` signatures identical across Task 2 (def), Task 4 (usage). `fetchRecommendationInputs` return keys (`candidates, interactions, savedCategoryIds, insightArticleIds, activeDomains`) identical across Task 3 (def) and Task 4 (usage). `interactions` element shape `{action, category_id}` matches what `computeAffinity` consumes; `candidates` carry `impact_score, published_at, primary_category_id, category.name` as `scoreArticles` reads. Nav key `recommended` / route `/recommended` / `activeNav === 'recommended'` consistent across Task 5. `logInteraction(articleId, action)` calls in Task 1 match its existing signature. ✅
