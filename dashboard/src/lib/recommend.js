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
