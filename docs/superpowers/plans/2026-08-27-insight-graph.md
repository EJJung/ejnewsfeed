# Insight Graph View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dashboard view rendering the knowledge layer's insights as an interactive co-citation graph (nodes = insights, edges = shared source articles).

**Architecture:** A pure `buildGraph(insights, sources)` computes `{nodes, links}` client-side; `InsightGraphView.jsx` fetches insights + source id-pairs, renders them with `react-force-graph-2d`, and lazily hydrates a node's sources into a side panel on click. New `/graph` route + nav item.

**Tech Stack:** React 18, react-router-dom 7, Tailwind, `react-force-graph-2d`, Supabase JS client, Vitest (already configured).

## Global Constraints

- Frontend in `dashboard/`; run all `npm`/`npx` commands from `dashboard/`.
- Match `KnowledgeView.jsx` conventions: local `useState`, `useEffect` fetch, gray Tailwind palette, shared loading/error/empty patterns, the `DOMAINS` id→categoryName map and `colorForDomain(id)` using the `categories` prop.
- Domain vocabulary: `ai, it, entrepreneurship, business, ux`. A `categories` prop supplies colors (`category.name` matches `DOMAINS[].categoryName`).
- Graph data: nodes = insights `{id, text, domains, confidence, status, sourceCount}`; links = `{source, target, weight}` where an edge exists between two insights sharing ≥1 source `article_id`, `weight` = number of shared articles. Only insights in the node set form edges (ignore source rows for non-node insights).
- Default status filter: `active` only; a toggle adds `candidate`; `rejected` never shown.
- Node color = first domain; node size = `sourceCount`; edge thickness = `weight`.
- Data helpers respect `isMockMode` (return empty) so the app runs without Supabase env vars.
- The insight-sources hydrated query shape mirrors `KnowledgeView.jsx:194-196`: `insight_sources.select('relation, article:articles(id, title, url, snippet, source:sources(name))').eq('insight_id', id)`.

---

### Task 1: Pure `buildGraph` + tests (TDD)

Co-citation edge construction — the only non-trivial logic — as a pure, DB-free function.

**Files:**
- Create: `dashboard/src/lib/graph.js`
- Test: `dashboard/src/lib/graph.test.js`

**Interfaces:**
- Produces: `buildGraph(insights, sources) -> { nodes, links }`.
  - `insights`: `[{id, text, domains, confidence, status}]`
  - `sources`: `[{insight_id, article_id}]`
  - `nodes`: `[{id, text, domains, confidence, status, sourceCount}]`
  - `links`: `[{source, target, weight}]` — one per unordered pair of node insights sharing ≥1 article; `weight` = shared-article count.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/lib/graph.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { buildGraph } from './graph.js'

const I = (id, extra = {}) => ({ id, text: `t-${id}`, domains: ['ai'], confidence: 0.5, status: 'active', ...extra })

describe('buildGraph', () => {
  it('returns empty graph for empty inputs', () => {
    expect(buildGraph([], [])).toEqual({ nodes: [], links: [] })
  })

  it('links two insights that share an article, weight 1', () => {
    const insights = [I('a'), I('b')]
    const sources = [
      { insight_id: 'a', article_id: 'x' },
      { insight_id: 'b', article_id: 'x' },
    ]
    const { nodes, links } = buildGraph(insights, sources)
    expect(nodes.map(n => n.id).sort()).toEqual(['a', 'b'])
    expect(links).toHaveLength(1)
    expect(links[0].weight).toBe(1)
    expect([links[0].source, links[0].target].sort()).toEqual(['a', 'b'])
  })

  it('counts shared articles as edge weight', () => {
    const sources = [
      { insight_id: 'a', article_id: 'x' }, { insight_id: 'b', article_id: 'x' },
      { insight_id: 'a', article_id: 'y' }, { insight_id: 'b', article_id: 'y' },
    ]
    const { links } = buildGraph([I('a'), I('b')], sources)
    expect(links).toHaveLength(1)
    expect(links[0].weight).toBe(2)
  })

  it('creates pairwise links when three insights share one article', () => {
    const sources = ['a', 'b', 'c'].map(id => ({ insight_id: id, article_id: 'x' }))
    const { links } = buildGraph([I('a'), I('b'), I('c')], sources)
    expect(links).toHaveLength(3)
    expect(links.every(l => l.weight === 1)).toBe(true)
  })

  it('leaves an insight with no shared source as an isolated node', () => {
    const sources = [
      { insight_id: 'a', article_id: 'x' }, { insight_id: 'b', article_id: 'x' },
      { insight_id: 'c', article_id: 'z' },
    ]
    const { nodes, links } = buildGraph([I('a'), I('b'), I('c')], sources)
    expect(nodes).toHaveLength(3)
    expect(links).toHaveLength(1)
  })

  it('computes sourceCount and ignores sources for non-node insights', () => {
    const sources = [
      { insight_id: 'a', article_id: 'x' },
      { insight_id: 'a', article_id: 'y' },
      { insight_id: 'ghost', article_id: 'x' },
    ]
    const { nodes, links } = buildGraph([I('a')], sources)
    expect(nodes[0].sourceCount).toBe(2)
    expect(links).toHaveLength(0) // 'ghost' is not a node → no edge
  })

  it('passes through node fields', () => {
    const { nodes } = buildGraph([I('a', { domains: ['ux', 'ai'], confidence: 0.9, status: 'candidate' })], [])
    expect(nodes[0]).toMatchObject({
      id: 'a', text: 't-a', domains: ['ux', 'ai'], confidence: 0.9, status: 'candidate', sourceCount: 0,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `dashboard/`:
```bash
npx vitest run src/lib/graph.test.js
```
Expected: FAIL — `Failed to resolve import "./graph.js"`.

- [ ] **Step 3: Implement graph.js**

Create `dashboard/src/lib/graph.js`:
```js
// Build a co-citation graph from insights and their source id-pairs.
// Two insights are linked when they share >= 1 source article; edge weight is
// the number of shared articles. Pure — no I/O, no canvas.
export function buildGraph(insights, sources) {
  const nodeIds = new Set(insights.map((i) => i.id))

  const sourceCount = {}
  const articleToInsights = {} // article_id -> Set(insight_id in node set)
  for (const s of sources) {
    if (!nodeIds.has(s.insight_id)) continue
    sourceCount[s.insight_id] = (sourceCount[s.insight_id] || 0) + 1
    ;(articleToInsights[s.article_id] ||= new Set()).add(s.insight_id)
  }

  const nodes = insights.map((i) => ({
    id: i.id,
    text: i.text,
    domains: i.domains || [],
    confidence: i.confidence,
    status: i.status,
    sourceCount: sourceCount[i.id] || 0,
  }))

  // Accumulate shared-article counts per unordered insight pair.
  const pairWeight = {} // "a|b" (a < b) -> shared article count
  for (const insightSet of Object.values(articleToInsights)) {
    const ids = [...insightSet].sort()
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const key = `${ids[a]}|${ids[b]}`
        pairWeight[key] = (pairWeight[key] || 0) + 1
      }
    }
  }

  const links = Object.entries(pairWeight).map(([key, weight]) => {
    const [source, target] = key.split('|')
    return { source, target, weight }
  })

  return { nodes, links }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `dashboard/`:
```bash
npx vitest run src/lib/graph.test.js
```
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/graph.js dashboard/src/lib/graph.test.js
git commit -m "feat: add pure buildGraph co-citation graph builder (+ tests)"
```

---

### Task 2: Data helpers (`lib/supabase.js`)

The two fetches the view needs.

**Files:**
- Modify: `dashboard/src/lib/supabase.js` (append helpers, following the existing style)

**Interfaces:**
- Consumes: the module-level `supabase` client and `isMockMode`.
- Produces:
  - `fetchInsightsForGraph(includeCandidates: boolean) -> Promise<{insights, sources}>` — `insights` are `{id, text, domains, confidence, status}` filtered by status; `sources` are all `{insight_id, article_id}` pairs. `[]`/`[]` in mock mode.
  - `fetchInsightSources(insightId: string) -> Promise<Array>` — hydrated `{relation, article:{id,title,url,snippet,source:{name}}}` rows for the side panel. `[]` in mock mode.

- [ ] **Step 1: Append the helpers**

Append to `dashboard/src/lib/supabase.js`:
```js
// ── Insight Graph helpers ──

// Fetch insights (+ source id-pairs) for the co-citation graph.
export async function fetchInsightsForGraph(includeCandidates = false) {
  if (isMockMode) return { insights: [], sources: [] }
  const statuses = includeCandidates ? ['active', 'candidate'] : ['active']
  const [insightsRes, sourcesRes] = await Promise.all([
    supabase.from('insights').select('id, text, domains, confidence, status').in('status', statuses),
    supabase.from('insight_sources').select('insight_id, article_id'),
  ])
  if (insightsRes.error) throw insightsRes.error
  if (sourcesRes.error) throw sourcesRes.error
  return { insights: insightsRes.data || [], sources: sourcesRes.data || [] }
}

// Fetch one insight's hydrated sources for the graph side panel.
export async function fetchInsightSources(insightId) {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('insight_sources')
    .select('relation, article:articles(id, title, url, snippet, source:sources(name))')
    .eq('insight_id', insightId)
  if (error) throw error
  return data || []
}
```

- [ ] **Step 2: Verify it compiles**

Run from `dashboard/`:
```bash
npm run build
```
Expected: build succeeds. Helpers are exported but not yet used — fine.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/lib/supabase.js
git commit -m "feat: add insight-graph data helpers (fetchInsightsForGraph, fetchInsightSources)"
```

---

### Task 3: `InsightGraphView` component + dependency

Install `react-force-graph-2d` and build the view: force graph, domain filter, candidate toggle, and click-to-open side panel with neighbor highlighting.

**Files:**
- Modify: `dashboard/package.json` / `package-lock.json` (add `react-force-graph-2d`)
- Create: `dashboard/src/components/InsightGraphView.jsx`

**Interfaces:**
- Consumes: `fetchInsightsForGraph`, `fetchInsightSources` (`../lib/supabase.js`); `buildGraph` (`../lib/graph.js`); `ForceGraph2D` (default import from `react-force-graph-2d`).
- Produces: `default export InsightGraphView({ categories })` — mounted at `/graph` in Task 4.

- [ ] **Step 1: Install the dependency**

Run from `dashboard/`:
```bash
npm install react-force-graph-2d
```
Verify it resolves:
```bash
node -e "require.resolve('react-force-graph-2d'); console.log('resolved')"
```
Expected: `resolved`.

- [ ] **Step 2: Write the component**

Create `dashboard/src/components/InsightGraphView.jsx`:
```jsx
import { useState, useEffect, useRef, useMemo } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { fetchInsightsForGraph, fetchInsightSources } from '../lib/supabase.js'
import { buildGraph } from '../lib/graph.js'

const DOMAINS = [
  { id: 'ai', label: 'AI', categoryName: 'AI' },
  { id: 'it', label: 'IT', categoryName: 'IT' },
  { id: 'entrepreneurship', label: 'Entrepreneurship', categoryName: 'Entrepreneurship' },
  { id: 'business', label: 'Business', categoryName: 'Business' },
  { id: 'ux', label: 'UX Design', categoryName: 'UX Design' },
]

export default function InsightGraphView({ categories = [] }) {
  const [domainId, setDomainId] = useState('all')
  const [includeCandidates, setIncludeCandidates] = useState(false)
  const [raw, setRaw] = useState({ insights: [], sources: [] })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null) // { node, sources, loadingSources }

  const containerRef = useRef(null)
  const [dims, setDims] = useState({ width: 800, height: 600 })

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeCandidates])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setDims({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  async function fetchData() {
    setIsLoading(true)
    setError(null)
    setSelected(null)
    try {
      setRaw(await fetchInsightsForGraph(includeCandidates))
    } catch (e) {
      setError(e.message)
      setRaw({ insights: [], sources: [] })
    } finally {
      setIsLoading(false)
    }
  }

  function colorForDomain(id) {
    const domain = DOMAINS.find((d) => d.id === id)
    const category = categories.find((c) => c.name === domain?.categoryName)
    return category?.color || '#9CA3AF'
  }

  const graph = useMemo(() => {
    const insights = domainId === 'all'
      ? raw.insights
      : raw.insights.filter((i) => (i.domains || []).includes(domainId))
    return buildGraph(insights, raw.sources)
  }, [raw, domainId])

  const neighbors = useMemo(() => {
    if (!selected) return null
    const set = new Set([selected.node.id])
    for (const l of graph.links) {
      const s = l.source.id || l.source
      const t = l.target.id || l.target
      if (s === selected.node.id) set.add(t)
      if (t === selected.node.id) set.add(s)
    }
    return set
  }, [selected, graph.links])

  async function handleNodeClick(node) {
    setSelected({ node, sources: null, loadingSources: true })
    try {
      const sources = await fetchInsightSources(node.id)
      setSelected((cur) => (cur && cur.node.id === node.id ? { ...cur, sources, loadingSources: false } : cur))
    } catch {
      setSelected((cur) => (cur && cur.node.id === node.id ? { ...cur, sources: [], loadingSources: false } : cur))
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 flex-wrap">
        <div className="flex gap-1">
          <FilterButton active={domainId === 'all'} onClick={() => setDomainId('all')}>All</FilterButton>
          {DOMAINS.map((d) => (
            <FilterButton key={d.id} active={domainId === d.id} onClick={() => setDomainId(d.id)}>
              <span className="w-2 h-2 rounded-full inline-block mr-1.5 align-middle" style={{ backgroundColor: colorForDomain(d.id) }} />
              {d.label}
            </FilterButton>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer ml-auto">
          <input type="checkbox" checked={includeCandidates} onChange={(e) => setIncludeCandidates(e.target.checked)}
            className="rounded border-gray-300 text-gray-900 focus:ring-gray-400" />
          Include candidates
        </label>
      </div>

      {/* Graph + side panel */}
      <div className="flex-1 flex min-h-0">
        <div ref={containerRef} className="flex-1 relative min-h-0">
          {isLoading ? (
            <Centered><span className="text-sm text-gray-400">Loading graph…</span></Centered>
          ) : error ? (
            <Centered>
              <div className="text-center">
                <p className="text-sm text-red-500 font-medium">Couldn't load the graph</p>
                <p className="text-xs text-gray-400 mt-1 mb-3">{error}</p>
                <button onClick={fetchData} className="text-xs text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50">Try again</button>
              </div>
            </Centered>
          ) : graph.nodes.length === 0 ? (
            <Centered><span className="text-sm text-gray-400">No insights to graph yet.</span></Centered>
          ) : (
            <ForceGraph2D
              graphData={graph}
              width={dims.width}
              height={dims.height}
              nodeId="id"
              nodeVal={(n) => Math.max(1, n.sourceCount)}
              nodeLabel={(n) => n.text}
              nodeColor={(n) => {
                if (neighbors && !neighbors.has(n.id)) return 'rgba(180,180,180,0.15)'
                return colorForDomain((n.domains || [])[0])
              }}
              linkWidth={(l) => Math.max(1, l.weight)}
              linkColor={(l) => {
                if (!neighbors) return 'rgba(150,150,150,0.25)'
                const s = l.source.id || l.source
                const t = l.target.id || l.target
                return neighbors.has(s) && neighbors.has(t) ? 'rgba(120,120,120,0.6)' : 'rgba(200,200,200,0.08)'
              }}
              onNodeClick={handleNodeClick}
              onBackgroundClick={() => setSelected(null)}
              cooldownTicks={100}
            />
          )}
        </div>

        {selected && (
          <SidePanel
            node={selected.node}
            sources={selected.sources}
            loading={selected.loadingSources}
            domainLabels={(selected.node.domains || []).map((d) => DOMAINS.find((x) => x.id === d)?.label || d)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  )
}

function FilterButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap ${
        active ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
      }`}
    >
      {children}
    </button>
  )
}

function Centered({ children }) {
  return <div className="absolute inset-0 flex items-center justify-center">{children}</div>
}

function SidePanel({ node, sources, loading, domainLabels, onClose }) {
  return (
    <div className="w-80 shrink-0 border-l border-gray-100 overflow-y-auto p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-100 capitalize">{node.status}</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <p className="text-sm text-gray-900 leading-relaxed">{node.text}</p>
      <p className="text-xs text-gray-400 mt-2">
        {domainLabels.join(' · ')}
        {typeof node.confidence === 'number' ? ` · confidence ${node.confidence.toFixed(2)}` : ''}
      </p>
      <div className="mt-4 pt-4 border-t border-gray-50">
        <p className="text-xs font-medium text-gray-500 mb-2">Sources ({node.sourceCount})</p>
        {loading ? (
          <p className="text-xs text-gray-300">Loading sources…</p>
        ) : (
          <ul className="space-y-1.5">
            {(sources || []).map(({ article }) => article && (
              <li key={article.id} className="text-xs text-gray-500">
                {article.url ? (
                  <a href={article.url} target="_blank" rel="noreferrer" className="hover:text-gray-700 hover:underline">→ {article.title}</a>
                ) : (
                  <span>→ {article.title}</span>
                )}
                {article.source?.name && <span className="text-gray-300"> — {article.source.name}</span>}
              </li>
            ))}
            {(sources || []).length === 0 && <li className="text-xs text-gray-300">No sources.</li>}
          </ul>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify it builds**

Run from `dashboard/`:
```bash
npm run build
```
Expected: build succeeds with the new dependency and component (component not yet routed — that's Task 4).

- [ ] **Step 4: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/src/components/InsightGraphView.jsx
git commit -m "feat: add InsightGraphView (force graph, filters, side panel)"
```

---

### Task 4: Nav item + route wiring

**Files:**
- Modify: `dashboard/src/components/Sidebar.jsx` (nav case + `NavItem`)
- Modify: `dashboard/src/App.jsx` (import + route)

**Interfaces:**
- Consumes: `InsightGraphView` default export; the existing `NavItem`/`handleNav`/`activeNav` machinery.

- [ ] **Step 1: Add the nav route case in `Sidebar.jsx`**

In `dashboard/src/components/Sidebar.jsx`, add a `graph` branch to `handleNav` (after the `knowledge` line):
```js
    else if (key === 'knowledge') navigate('/knowledge')
    else if (key === 'graph') navigate('/graph')
```

- [ ] **Step 2: Add the `NavItem` in `Sidebar.jsx`**

Directly after the "Knowledge" `<NavItem ... />` block, insert:
```jsx
        <NavItem
          label="Insight Graph"
          isActive={activeNav === 'graph'}
          onClick={() => handleNav('graph')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6a2 2 0 100-4 2 2 0 000 4zM6 20a2 2 0 100-4 2 2 0 000 4zM18 20a2 2 0 100-4 2 2 0 000 4zM12 6l-6 10M12 6l6 10M8 18h8" />
            </svg>
          }
        />
```

- [ ] **Step 3: Import and route `InsightGraphView` in `App.jsx`**

In `dashboard/src/App.jsx`, add the import alongside the other view imports (near `KnowledgeView`):
```jsx
import InsightGraphView from './components/InsightGraphView.jsx'
```

Then add the route inside `<Routes>`, directly after the `/knowledge` route:
```jsx
            <Route path="/graph" element={<InsightGraphView categories={categories} />} />
```

- [ ] **Step 4: Verify it builds**

Run from `dashboard/`:
```bash
npm run build
```
Expected: build succeeds with the import and route resolved.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/Sidebar.jsx dashboard/src/App.jsx
git commit -m "feat: wire Insight Graph nav item and /graph route"
```

---

### Task 5: End-to-end verification

Confirms the whole path works against real data.

**Files:** none (verification only).

- [ ] **Step 1: Confirm all unit tests + build pass**

Run from `dashboard/`:
```bash
npm run test && npm run build
```
Expected: Vitest all-green (graph + episodes suites); production build succeeds.

- [ ] **Step 2: Run the dashboard against real data**

The dashboard needs real Supabase client creds to leave mock mode. If `dashboard/.env.local` already has `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (created during the podcast work), skip ahead. Otherwise create it:
```bash
vercel env pull /tmp/ej_vercel.env --environment=production --yes
grep -E '^VITE_SUPABASE_(URL|ANON_KEY)=' /tmp/ej_vercel.env > dashboard/.env.local
```
Then run from `dashboard/`:
```bash
npm run dev
```
Expected: Vite serves at `http://localhost:5173`. Sign in as `ej.newsfeed@gmail.com`.

- [ ] **Step 3: Verify the view**

Open `http://localhost:5173/graph` (or click **Insight Graph** in the sidebar). Confirm all of:
- A force graph of active insights renders, nodes colored by domain, with visible clusters (edges between insights that share sources).
- The **domain filter** restricts to that domain's insights; **Include candidates** adds more nodes.
- **Clicking a node** opens the side panel with the insight's text, domains/confidence, and its source articles (links); the node + its neighbors highlight while the rest dim.
- Clicking the background (or the panel's close) clears the selection.
- No console errors.

---

## Self-Review

**Spec coverage:**
- Co-citation `buildGraph` (spec "Graph construction") → Task 1 ✅
- Two-tier data fetch (spec "Data fetching") → Task 2 (`fetchInsightsForGraph` id-pairs + `fetchInsightSources` hydrated) ✅
- Visual encoding: color=domain, size=sourceCount, edge width=weight (spec "Visual encoding") → Task 3 ✅
- Interactions: domain filter, candidate toggle, click→side panel, neighbor highlight, hover tooltip (spec "Interactions") → Task 3 ✅
- Placement/structure, states, mock mode (spec) → Tasks 3, 4; helpers return empty in mock mode (Task 2) ✅
- Testing: `buildGraph` unit tests + build + live E2E (spec "Testing") → Tasks 1, 5 ✅

**Placeholder scan:** No TBD/TODO; every step has concrete code/commands. ✅

**Type consistency:** `buildGraph(insights, sources)` signature and `{nodes, links}`/node-field shape identical across Task 1 (def), Task 3 (usage), and the tests. `fetchInsightsForGraph`→`{insights, sources}` and `fetchInsightSources`→`[{relation, article:{...}}]` identical across Task 2 (def) and Task 3 (usage: `article.id/title/url/source.name`, `node.sourceCount`, `link.weight`, `link.source/target`). Nav key `graph`, route `/graph`, and `activeNav === 'graph'` consistent across Task 4. ✅
