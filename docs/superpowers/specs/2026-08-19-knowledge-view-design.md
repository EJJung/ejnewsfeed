# Dashboard Knowledge View — Design

*Drafted 2026-08-19. Implements item 1d of [Phase 1](../../../knowledge-center-plan.md#phase-1--knowledge-layer--multi-source-ingestion-23-weeks) of the ejnewsfeed knowledge-center plan — the browsing UI for the `insights` table populated by the [knowledge layer schema + distillation](2026-08-18-knowledge-layer-schema-distillation-design.md) work (already live).*

## Why this is scoped this way

The parent plan's item 1d says: "Browse insights by domain; filters for contested items and open questions; each insight expands to its sources." Of those, only `insights` has real data today — `decisions`/`hypotheses`/`open_questions` are schema-only until Phase 3 builds the meeting write-back loop. This spec covers **insights only**; UI for the other three tables is deferred to a Phase 3 spec once they have real data and defined write-back behavior to design against.

This is additive to existing navigation, not a replacement — the plan's framing of Knowledge as the eventual primary way EJ engages is an end-state goal, not something to force with only one of four knowledge-layer tables populated.

## Existing patterns this design follows

- **`TrendsView.jsx`** is the closest existing analog (left category picker + right card list, period/filter controls, expand/collapse, loading skeleton, empty state) and is the direct template for layout and interaction.
- **`ArticleCard.jsx`** for card visual language (white bg, `border-gray-100`, `rounded-xl`, hover states, `text-gray-900`/`text-gray-500`/`text-gray-400` hierarchy).
- **`Sidebar.jsx`**'s `NavItem` + `handleNav` pattern for adding the new nav entry.
- Data fetching follows the established direct-`supabase`-client-from-browser pattern used by every existing view (RLS already grants `anon` SELECT on `insights`/`insight_sources` from the schema work).
- No mock-mode (`isMockMode`) support — follows `TrendsView`'s precedent (not `ScanView`'s fuller mock-data path), keeping scope tight.

## Routing & navigation

- New route `/knowledge` → `KnowledgeView` component, added to `App.jsx`'s `<Routes>`.
- New `Sidebar.jsx` nav item "Knowledge", positioned after Trends, before Saved:
  ```
  Morning Briefing
  — Categories —
  ────────────
  Trends
  Knowledge   ← new
  Saved
  ```
- `handleNav` gains `else if (key === 'knowledge') navigate('/knowledge')`.

## Layout & data flow

```
KnowledgeView
├── left panel: domain picker — [All, AI, IT, Entrepreneurship, Business, UX Design]
│   (same visual pattern as TrendsView's category picker: dot + label, active state)
└── main content
    ├── header: "{Domain} Insights" + one-line description
    ├── controls: "Show all statuses" toggle (default off → active+contested only)
    └── card list (empty/loading states matching TrendsView's)
        └── InsightCard × N
```

**Domain picker:** single-select, matching `TrendsView`'s left-panel pattern, plus an "All" option as the first/default entry. Because `insights.domains` is an array (an insight can belong to more than one domain, unlike `trend_summaries`' single `category_id`), selecting a specific domain shows any insight whose `domains` array contains it — a multi-domain insight can legitimately appear under more than one selection. Domain slugs (`ai`/`it`/`entrepreneurship`/`business`/`ux`) map to display names/colors via the same slug→category-name table `distill-insights`'s `DOMAIN_TO_CATEGORY` uses, inverted for slug→color lookup against the `categories` already loaded in `App.jsx`.

**Fetch query** (DB-level order is provisional — the real ordering is the client-side sort described below):
```js
let query = supabase.from('insights').select('*').order('created_at', { ascending: false })
if (domainId !== 'all') query = query.contains('domains', [domainId])
query = statusFilter === 'default'
  ? query.in('status', ['active', 'contested'])
  : query.in('status', ['candidate', 'active', 'contested', 'superseded', 'rejected'])
```

**Client-side sort** (applied after fetch, not in the query — only 5 status values, simpler than a compound DB sort): contested-status insights first, then everything else, each group ordered by "most recently confirmed" descending — `last_confirmed_at ?? first_seen_at` (an insight only gets `last_confirmed_at` once a weekly pass reconfirms it with new evidence; one that was promoted straight from its first candidate pass and never merged again falls back to `first_seen_at`). This matches the plan's emphasis on "contradictions between sources are surfaced automatically" — contested insights are what need EJ's attention, so they lead — and surfaces insights the pipeline is actively reaffirming ahead of ones that have gone quiet.

**Status filter default:** `active` + `contested` only. `candidate` (unvetted, awaiting the weekly pass), `superseded` (already merged into another insight), and `rejected` (pipeline decided it wasn't durable enough) are pipeline-internal states that would be noise on the primary view — a "Show all statuses" toggle reveals them.

**Sources**, fetched lazily only when a card is expanded (avoids an N+1 join on every insight up front):
```js
supabase.from('insight_sources').select('relation, article:articles(id, title, url, snippet, source_id)').eq('insight_id', insightId)
```

## Insight card

```
┌─ InsightCard ──────────────────────────────────────┐
│ [contested]  AI · Business              2d ago      │  ← status badge + domain dots/labels + relative time
│ "Cloud infrastructure costs are rising industry-wide"│  ← insight text
│ confidence 0.8                                       │  ← small, muted
│ ▾ 4 sources                                          │  ← click to expand (inline, in-place — no route change)
│                                                       │
│   Supporting (2)                                     │  ← only rendered as a labeled group when both types exist
│     → Cloud Costs Jumped 230% — Every                │
│     → ...                                            │
│   Contradicting (2)                                  │  ← only appears for contested insights
│     → ...                                            │
└──────────────────────────────────────────────────────┘
```

- **Expansion is inline** (accordion, matching `TrendsView`'s `TrendCard` read-more pattern), not a navigation to a detail route — keeps EJ in the browsing flow.
- **Status badge colors:** `active` = green-ish, `contested` = amber/red (needs attention), `candidate`/`superseded`/`rejected` = gray (only ever visible with the toggle on).
- **Supporting/Contradicting split:** the two labeled groups only render when both `relation` types are present among the insight's `insight_sources` rows. A normal `active` insight will only ever have `supporting` rows (per the distillation design, `contradicting` rows are only ever attached to an insight when it becomes `contested`), so it renders as one flat "Sources" list. This directly implements the plan's "surfaces the contradictory opinions in the pack rather than agreeing by default" goal using data the schema already produces — no new backend work needed.
- **`superseded` insights** (visible only with the toggle on): instead of a sources list, show "→ superseded by: {other insight's text, truncated}". If that target insight is present in the current filtered set, this could scroll to it; otherwise it's a dead-end label. No cross-domain navigation in this version.

## Empty & loading states

Following `TrendsView`'s exact pattern (skeleton cards while loading), with smarter empty-state copy since we can tell EJ *why* it's empty:

- **Domain has insights, but none `active`/`contested` (default filter):** "No active insights yet in {domain}. {N} candidate(s) awaiting the weekly review — toggle 'Show all statuses' to see them."
- **Domain has no insights in any status:** "No insights yet for {domain}. The daily distillation job hasn't found anything durable enough to keep here yet."
- **"All" domain, nothing anywhere:** same copy, domain-agnostic phrasing.

## Error handling & edge cases

- **Fetch failure:** inline error text + "Try again" button — a visible distinction from "no insights," rather than this codebase's more common silent no-op on error (`if (!error && data) setX(data)`), since on a page meant to build trust in the knowledge layer, "the data failed to load" and "there's genuinely nothing here" need to look different.
- **Multi-domain insight + "All" filter:** shown once, never duplicated.
- **Multi-domain insight + specific domain filter:** shown if that domain is anywhere in its `domains` array (covered by the `.contains()` query, no extra client-side dedup needed for this case).

## Testing / verification

No automated test suite exists anywhere in `dashboard/`. Verification: run the dev server, navigate to `/knowledge`, and manually verify against real data already in the live `insights` table (which has real `active`/`contested`/`candidate`/`superseded` rows from this session's distillation testing) — domain picker, status toggle, sort order, and inline source-expansion including a contested insight's supporting/contradicting split.

## Out of scope

- decisions/hypotheses/open_questions UI — deferred to a Phase 3 spec.
- Search/text-filtering within insights — not requested by the plan for 1d.
- Any write actions (editing/re-classifying an insight by hand) — this view is read-only browsing. The plan's human-in-the-loop editing control point is Phase 3's Meeting Pack review UI, not this view.
- Mock-mode data support.
