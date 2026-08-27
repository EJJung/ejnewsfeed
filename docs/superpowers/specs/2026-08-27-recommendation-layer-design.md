# Recommendation Layer — Design Spec

*Drafted 2026-08-27 from discussion between EJ and Claude. Phase 4 (third sub-project).*

## Concept

A **"Recommended"** dashboard view that ranks articles for EJ by a blended score,
plus the **engagement capture** that makes the whole thing possible. This is the
third and final Phase 4 sub-project.

## The premise problem (why capture is Part A)

`user_interactions` has **0 rows** — the `logInteraction()` helper exists in
`lib/supabase.js` but is **never called** anywhere in the UI. Saved articles number
**4**. So a classic engagement recommender has no signal to learn from (cold start),
and never will until capture is wired. Therefore this feature ships two things:
capture (so engagement finally accrues) and a recommender that leans on
content/knowledge signals now and sharpens as engagement grows.

## Part A — Engagement capture

Wire the existing `logInteraction(articleId, action, timeSpentSeconds?)` at the
high-signal interaction points (all fire-and-forget; `logInteraction` already
no-ops in mock mode):

- **`opened`** — in `App.jsx handleArticleClick(article)` (article opened → detail view).
- **`saved`** — in `App.jsx handleToggleSave(articleId)`, only in the `isSaving` branch (not on un-save).
- **`read_full`** — in `DiveView.jsx`, in a `useEffect` keyed on `article.id` (the user is reading the full article/analysis).

Deferred (easy later adds): `dismissed` (no dismiss UI exists) and `chat_started`/`chat_message` (lower signal).

## Part B — The blended recommender

A new **"Recommended"** view (`/recommended` + nav item) listing articles ranked by
a blended score, rendered with the existing `ArticleCard` (so save/open behave the
same and themselves feed capture).

### Signals

- **Content quality & recency** — each article's `impact_score` and `published_at`.
- **Category affinity** — aggregated from `user_interactions` + `saved_articles`,
  weighted by action (`opened`=1, `read_full`=3, `saved`=5), summed per the
  article's `primary_category_id`. Uniform/zero when there's no data.
- **Knowledge boost** — (1) articles that are **sources of active insights**
  (`insight_sources` for `status='active'` insights) get a strong boost; (2) articles
  whose category corresponds to a **domain that has active insights** get a small
  boost. This carries the recommender during cold-start using the knowledge layer.

Already-saved articles are excluded from recommendations.

### Pure scoring (`dashboard/src/lib/recommend.js`)

Two pure, unit-tested functions (no I/O):

- `computeAffinity(interactions, savedCategoryIds) -> { [categoryId]: weight }`
  - `interactions`: `[{ action, category_id }]`; `savedCategoryIds`: `[category_id]`.
  - Action weights: `opened` 1, `read_full` 3, `saved` 5; each entry in
    `savedCategoryIds` adds 5. Unknown actions contribute 0. Returns summed weights per category.

- `scoreArticles(candidates, signals) -> [{ article, score, reason }]` (sorted desc)
  - `signals`: `{ affinity, insightArticleIds, activeCategoryNames, savedIds, now }`
    (`affinity` is the map above; `insightArticleIds`/`savedIds` are Sets of article ids;
    `activeCategoryNames` is a Set of category names; `now` is an ISO string / epoch ms).
  - For each candidate whose id ∉ `savedIds`, compute:
    - `impact = article.impact_score ?? 0` (assumed ~0–1)
    - `recency = recencyScore(article.published_at, now)` — linear decay:
      `max(0, 1 - ageDays / 30)` (null date → 0)
    - `aff = normalized affinity for article.primary_category_id` (affinity value ÷ max
      affinity across categories; 0 when no affinity data)
    - `srcBoost = insightArticleIds.has(article.id) ? 1 : 0`
    - `catBoost = activeCategoryNames.has(article.category?.name) ? 1 : 0`
    - `score = 0.35*impact + 0.20*recency + 0.25*aff + 0.15*srcBoost + 0.05*catBoost`
  - `reason`: a short label from the top-contributing signal, e.g.
    `srcBoost` → "Sources an active insight"; high `aff` → "Matches your {category} reading";
    high `impact` → "High impact"; else "Recent". (Deterministic tie-break by the weight order above.)
  - Returns candidates sorted by `score` descending.

`recencyScore(publishedAt, now)` is also exported and unit-tested.

### Data (`dashboard/src/lib/supabase.js`)

One helper assembles the scorer's raw inputs (mock mode → all-empty):

- `fetchRecommendationInputs() -> { candidates, interactions, savedCategoryIds, insightArticleIds, activeDomains }`
  - `candidates`: top ~200 articles by `impact_score` then `published_at` (reuse the
    existing `fetchArticles(null, 200)` shape — carries `impact_score`,
    `primary_category_id`, `published_at`, and `category:{name,color}`).
  - `interactions`: `user_interactions` joined to the article's category —
    `select('action, article:articles(primary_category_id)')` → normalized to
    `[{ action, category_id }]`.
  - `savedCategoryIds`: `saved_articles` joined to article category →
    `[category_id]`.
  - active insights: `insights.select('id, domains').eq('status','active')` →
    `activeDomains` = distinct domains; then
    `insight_sources.select('article_id').in('insight_id', activeInsightIds)` →
    `insightArticleIds`.

The view derives `affinity = computeAffinity(...)`, `activeCategoryNames` (from
`activeDomains` via the `DOMAINS` id→categoryName map, reused from `KnowledgeView`),
and `savedIds` (from the `savedArticles` prop), then calls `scoreArticles`.

### View (`dashboard/src/components/RecommendedView.jsx`)

- Takes the same props ScanView gets (`categories`, `onArticleClick`,
  `savedArticles`, `onToggleSave`).
- On load: `fetchRecommendationInputs()`, compute signals, `scoreArticles`, render
  the ranked list of `ArticleCard`s, each with its short **reason** shown as a small
  tag above/beside the card.
- **Loading / error / empty** states like `KnowledgeView`. Empty (no candidates) →
  friendly message. Mock mode → empty inputs → empty state, no crash.

### Placement

- `Sidebar.jsx`: a **"Recommended"** nav item (near Morning Briefing — both are
  consumption entry points).
- `App.jsx`: `import RecommendedView` + `<Route path="/recommended" element={<RecommendedView {...scanProps} />} />` and a `recommended` case in `Sidebar`'s `handleNav`.

## Testing

- **Unit (`recommend.test.js`):** `computeAffinity` (action weighting, saved
  contribution, unknown action → 0, empty → `{}`); `recencyScore` (fresh → ~1, 30+
  days → 0, null → 0); `scoreArticles` (saved excluded; source-boosted article
  outranks an equal non-source one; affinity raises a matching-category article;
  reason reflects the dominant signal; empty candidates → `[]`; deterministic order).
- **Build:** `npm run build` succeeds with the new route.
- **Live E2E:** load `/recommended` (signed in) — a ranked list renders with reason
  tags; open an article and confirm an `opened` row lands in `user_interactions`;
  save one and confirm a `saved` row; reload and confirm the ranking still renders.

## Scope guardrails (YAGNI)

Candidate pool capped (~200), all scoring client-side (no server-side reco job, no
edge function). No collaborative filtering (single user). No embeddings/semantic
similarity — content + knowledge signals only. Fixed weights (no tuning UI). No
`dismissed`/chat capture yet. Reasons are simple top-signal labels, not explanations.

## Success criteria

EJ opens **Recommended** and sees a sensible ranked reading list — during cold-start
driven by impact, recency, and knowledge relevance — and, because opens/reads/saves
are now captured, the list measurably shifts toward EJ's category affinity over the
following weeks.
