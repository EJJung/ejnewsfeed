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
