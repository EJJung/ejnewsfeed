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
