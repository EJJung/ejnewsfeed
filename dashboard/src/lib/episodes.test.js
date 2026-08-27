import { describe, it, expect } from 'vitest'
import { splitByKind, formatDuration, transcriptText } from './episodes.js'

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

describe('transcriptText', () => {
  it('joins weekly turns JSON into readable dialogue', () => {
    const script = JSON.stringify([
      { speaker: 'A', text: 'first' },
      { speaker: 'B', text: 'second' },
    ])
    expect(transcriptText({ kind: 'weekly', script })).toBe('A: first\n\nB: second')
  })

  it('falls back to the raw string when weekly JSON is malformed', () => {
    expect(transcriptText({ kind: 'weekly', script: '{not json' })).toBe('{not json')
  })

  it('falls back to the raw string when weekly JSON parses but is not turns shape (object)', () => {
    expect(transcriptText({ kind: 'weekly', script: '{"foo":1}' })).toBe('{"foo":1}')
  })

  it('falls back to the raw string when weekly JSON parses but is not turns shape (array of non-turns)', () => {
    expect(transcriptText({ kind: 'weekly', script: '[1,2]' })).toBe('[1,2]')
  })

  it('returns the plain script unchanged for daily episodes', () => {
    expect(transcriptText({ kind: 'daily', script: 'Just plain text.' })).toBe('Just plain text.')
  })

  it('returns an empty string when script is null or undefined', () => {
    expect(transcriptText({ kind: 'daily', script: null })).toBe('')
    expect(transcriptText({ kind: 'weekly', script: undefined })).toBe('')
  })
})
