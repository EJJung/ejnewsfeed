import { describe, it, expect } from 'vitest'
import { splitByKind, formatDuration } from './episodes.js'

describe('splitByKind', () => {
  it('partitions weekly and daily, preserving order', () => {
    const eps = [
      { id: 'a', kind: 'daily' },
      { id: 'b', kind: 'weekly' },
      { id: 'c', kind: 'daily' },
    ]
    const { weekly, daily } = splitByKind(eps)
    expect(weekly.map(e => e.id)).toEqual(['b'])
    expect(daily.map(e => e.id)).toEqual(['a', 'c'])
  })

  it('treats any non-weekly kind as daily', () => {
    const { weekly, daily } = splitByKind([{ id: 'x', kind: 'other' }])
    expect(weekly).toEqual([])
    expect(daily.map(e => e.id)).toEqual(['x'])
  })

  it('returns empty groups for an empty list', () => {
    expect(splitByKind([])).toEqual({ weekly: [], daily: [] })
  })
})

describe('formatDuration', () => {
  it('returns an em dash for missing or non-positive values', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
  })

  it('returns "<1 min" for under a minute', () => {
    expect(formatDuration(30)).toBe('<1 min')
  })

  it('rounds to whole minutes', () => {
    expect(formatDuration(899)).toBe('15 min')
    expect(formatDuration(741)).toBe('12 min')
  })
})
