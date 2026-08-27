# Insight Graph View — Design Spec

*Drafted 2026-08-27 from discussion between EJ and Claude. Phase 4 (second sub-project).*

## Concept

A new dashboard view that visualizes the knowledge layer's insights as an
interactive **co-citation graph**: each insight is a node, and two insights are
linked when they share a source article. It answers *"which of my beliefs cluster
together and draw on the same evidence?"* — making the knowledge layer explorable
at a glance rather than as a flat list.

This is the second Phase 4 sub-project (after the knowledge MCP server). The third
direction (engagement-based recommendations) remains out of scope, its own spec
later.

## Data reality (2026-08-27)

- Insights: 64 active, 45 candidate, 11 rejected. **0 contested, 0 superseded.**
- `insight_sources`: 199 links, **all `supporting`** (0 contradicting). 110 distinct
  articles; **51 articles are cited by more than one insight** — these shared
  articles are the graph's edges. 120 insights have ≥1 source.
- decisions / hypotheses / open_questions: empty.

Consequence: the only real connective tissue today is **shared source articles**
(co-citation). There are no contradiction edges or contested insights to draw yet,
so the graph is a co-citation network for now. The edge model is designed so that a
future `contradicting` relation can render as a visually distinct edge with no
rework.

## Design

### Graph construction (pure, client-side)

`dashboard/src/lib/graph.js` exposes a pure `buildGraph(insights, sources)`:

- **Inputs:**
  - `insights`: `[{ id, text, domains, confidence, status }]`
  - `sources`: `[{ insight_id, article_id }]` (id pairs only — no article hydration)
- **Output:** `{ nodes, links }` for `react-force-graph-2d`:
  - `nodes`: `[{ id, text, domains, confidence, status, sourceCount }]` where
    `sourceCount` = number of source rows for that insight.
  - `links`: `[{ source: insightId, target: insightId, weight }]` — one link per
    pair of insights that share ≥1 article; `weight` = number of shared articles.
    Pairs are canonicalized (each unordered pair once).
- Isolated insights (no shared source) still appear as unconnected nodes.

This is the only non-trivial logic and is unit-tested without a DB or canvas.

### Visual encoding

- **Node = insight.** Color by domain, reusing the app's category colors
  (`categories` prop + the `DOMAINS` id→categoryName map from `KnowledgeView`); a
  multi-domain insight is colored by its first domain. **Node size = `sourceCount`**
  (evidence weight).
- **Edge = shared source article(s)**, line thickness scaled by `weight`.
- Rendered with **`react-force-graph-2d`** (canvas force layout; built-in
  zoom/pan/drag). One added npm dependency, bundled by Vite (no CDN).

### Interactions

- **Domain filter** — the same picker pattern as `KnowledgeView`
  (All / AI / IT / Entrepreneurship / Business / UX). Selecting a domain restricts
  the graph to insights in that domain and the edges among them.
- **Status toggle** — active-only by default (64 nodes, legible); a toggle to
  include `candidate` insights. `rejected` never shown.
- **Click a node → side panel** showing the insight's full text, domains,
  confidence, status, and its **source articles** (titles + links). The panel's
  sources are fetched lazily on click (hydrated `insight_sources → articles`, the
  same shape `KnowledgeView` uses on expand), so the initial graph payload stays
  light. On selection, the clicked node and its direct neighbors highlight; the
  rest dims. A close control returns to the full graph.
- **Hover** → tooltip with the insight text (`react-force-graph-2d` `nodeLabel`).

### Data fetching

Two tiers, both with the authenticated Supabase client:
1. **On load:** fetch insights (status per the toggle) + all their `insight_sources`
   id-pairs (`insight_id, article_id`) → `buildGraph`. Lightweight (~199 rows).
2. **On node click:** fetch that insight's hydrated sources
   (`insight_sources.select('relation, article:articles(title, url, source:sources(name))').eq('insight_id', id)`)
   for the side panel — mirrors `KnowledgeView`'s existing per-insight source query.

New helpers in `dashboard/src/lib/supabase.js`:
- `fetchInsightsForGraph(includeCandidates: boolean)` → `{ insights, sources }`.
- (Reuse the existing per-insight source query pattern for the side panel, or add
  `fetchInsightSources(insightId)` if not already factored out.)

### Placement & structure

- `Sidebar.jsx`: a new **"Insight Graph"** nav item (graph icon), near Knowledge.
- `App.jsx`: `import InsightGraphView` + `<Route path="/graph" element={<InsightGraphView categories={categories} />} />`, and a `graph` case in `Sidebar`'s `handleNav`.
- `dashboard/src/components/InsightGraphView.jsx` — the view: data fetch, domain
  filter, status toggle, the `ForceGraph2D`, and the side panel.
- `dashboard/src/lib/graph.js` — pure `buildGraph`.

### States

- **Loading / error / empty** — the same patterns as `KnowledgeView` (spinner,
  inline error with retry, friendly empty message when there are no insights).
- **Mock mode** — `fetchInsightsForGraph` returns empty → an empty graph with the
  empty state, no crash.

## Testing

- **Unit (`graph.test.js`):** `buildGraph` — a shared article between two insights
  yields one weighted link; three insights sharing one article yield the three
  pairwise links; `weight` counts shared articles (two shared → weight 2); an
  insight with no shared sources is an isolated node; `sourceCount` is correct;
  empty inputs → `{ nodes: [], links: [] }`.
- **Build:** `npm run build` succeeds with the new dependency and route.
- **Live E2E:** load `/graph` on the running dashboard (signed in), confirm the
  active-insight co-citation graph renders with domain-colored nodes and visible
  clusters, the domain filter and candidate toggle work, clicking a node opens the
  side panel with its sources, and neighbor highlighting works.

## Scope guardrails (YAGNI)

Node count is bounded (≤~120), so all computation is client-side. No server-side
graph building, no physics-tuning UI, no article nodes, no clustering algorithm
beyond the force layout, no contradiction edges until that data exists (the edge
model leaves room for them), no graph export/screenshot feature.

## Success criteria

EJ opens **Insight Graph**, sees active insights clustered by shared evidence and
colored by domain, filters to a domain, clicks a node, and reads that insight and
its sources in the side panel — getting a spatial feel for how the knowledge layer
hangs together that the flat Knowledge list doesn't convey.
