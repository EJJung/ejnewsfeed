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
