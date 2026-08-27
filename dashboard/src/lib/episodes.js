// Pure helpers for the Podcast view — no React or Supabase, so they're
// unit-testable in isolation.

// Partition episodes into weekly deep dives and daily briefs.
// Order within each group is preserved (callers pass newest-first).
export function splitByKind(episodes) {
  const weekly = []
  const daily = []
  for (const ep of episodes) {
    if (ep.kind === 'weekly') weekly.push(ep)
    else daily.push(ep)
  }
  return { weekly, daily }
}

// Human-readable episode length, e.g. 899 -> "15 min".
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || seconds <= 0) return '—'
  if (seconds < 60) return '<1 min'
  return `${Math.round(seconds / 60)} min`
}
