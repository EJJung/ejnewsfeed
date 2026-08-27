# Podcast View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Podcast view to the dashboard so episodes are listenable on the live site (weekly deep dive pinned above daily briefs, inline player, per-episode transcript).

**Architecture:** A new React view (`PodcastView.jsx`) reads `ready` episodes via a `listEpisodes()` helper, splits them by `kind` with a pure helper, and renders two sections with a native `<audio>` player per episode. A one-line RLS migration grants the signed-in dashboard read access to `episodes` (currently service-role only, which would leave the view silently empty).

**Tech Stack:** React 18, react-router-dom 7, Tailwind, date-fns, Supabase JS client. Vitest (added in Task 1) for unit-testing pure helpers — the dashboard has no test tooling today.

## Global Constraints

- Frontend lives in `dashboard/`; run all `npm`/`npx` commands from `dashboard/`.
- Match existing view conventions (`KnowledgeView.jsx`): local `useState`, `useEffect` fetch, gray Tailwind palette, `border border-gray-100 rounded-xl p-5` cards, `max-w-2xl mx-auto` container, shared loading/error/empty sub-components.
- Read episode columns only: `id, kind, title, script, duration_seconds, published_at, audio_url`.
- Only `status='ready'` episodes are ever shown (matches the RSS feed; hides `error`/`generating` rows).
- Audio bucket `podcast-episodes` is public — stream `audio_url` directly, no signed URLs.
- Data helpers must respect `isMockMode` (return `[]`) so the app runs without Supabase env vars.

---

### Task 1: Pure helpers + Vitest setup

Pure, DB-free logic (grouping + duration formatting) extracted so it's unit-testable without React or Supabase. Also introduces Vitest, since the dashboard has no test runner yet.

**Files:**
- Modify: `dashboard/package.json` (add `vitest` devDep + `test` script)
- Create: `dashboard/src/lib/episodes.js`
- Test: `dashboard/src/lib/episodes.test.js`

**Interfaces:**
- Produces:
  - `splitByKind(episodes: Episode[]) => { weekly: Episode[], daily: Episode[] }` — partitions by `kind`; `'weekly'` → `weekly`, everything else → `daily`; preserves input order within each group.
  - `formatDuration(seconds: number|null) => string` — `null`/`0`/negative → `'—'`; `<60` → `'<1 min'`; else `'<rounded> min'`.

- [ ] **Step 1: Add Vitest dependency and test script**

Run from `dashboard/`:
```bash
npm install -D vitest
```

Then edit `dashboard/package.json` `scripts` to add a `test` line:
```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
```

- [ ] **Step 2: Write the failing test**

Create `dashboard/src/lib/episodes.test.js`:
```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run from `dashboard/`:
```bash
npx vitest run src/lib/episodes.test.js
```
Expected: FAIL — `Failed to resolve import "./episodes.js"` (module doesn't exist yet).

- [ ] **Step 4: Write minimal implementation**

Create `dashboard/src/lib/episodes.js`:
```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run from `dashboard/`:
```bash
npx vitest run src/lib/episodes.test.js
```
Expected: PASS — all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/src/lib/episodes.js dashboard/src/lib/episodes.test.js
git commit -m "feat: add podcast episode helpers (splitByKind, formatDuration) + vitest"
```

---

### Task 2: RLS migration for episode reads

Grants the signed-in dashboard read access to `ready` episodes. Without this the view renders but is always empty (the table currently has only a `service_role` policy).

**Files:**
- Create: `supabase/podcast_view_rls.sql`

**Interfaces:** none (SQL migration applied manually in the Supabase SQL editor).

- [ ] **Step 1: Write the migration file**

Create `supabase/podcast_view_rls.sql`:
```sql
-- ============================================================
-- EJ Newsfeed — Podcast View RLS
-- Run in Supabase SQL Editor → New Query
-- ============================================================
--
-- episodes previously had only a service_role policy (see
-- podcast_schema.sql), so authenticated dashboard reads returned zero
-- rows. This grants the signed-in dashboard read access, scoped to
-- status='ready' so half-finished (generating/error) rows never reach
-- the UI — matching what the RSS feed serves.
-- ============================================================

CREATE POLICY "authenticated_read_ready_episodes" ON episodes
  FOR SELECT TO authenticated
  USING (status = 'ready');

-- ── Verify ────────────────────────────────────────────────────────────────
SELECT policyname, roles, cmd FROM pg_policies WHERE tablename = 'episodes';
```

- [ ] **Step 2: Apply the migration**

Open the Supabase SQL editor for the project, paste the contents of `supabase/podcast_view_rls.sql`, and run it. Confirm the `SELECT ... pg_policies` output now lists **two** policies for `episodes`: `service_all_episodes` and `authenticated_read_ready_episodes`.

(The live read-path verification — that an authenticated session actually receives the `ready` rows and no `error` rows — happens end-to-end in Task 6.)

- [ ] **Step 3: Commit**

```bash
git add supabase/podcast_view_rls.sql
git commit -m "feat: add RLS policy so dashboard can read ready episodes"
```

---

### Task 3: `listEpisodes()` data helper

The single data-access function the view calls.

**Files:**
- Modify: `dashboard/src/lib/supabase.js` (append a new helper; follows the existing `fetchArticles` / `listMeetings` style)

**Interfaces:**
- Consumes: the module-level `supabase` client and `isMockMode` flag already exported from this file.
- Produces: `listEpisodes() => Promise<Episode[]>` where `Episode` has `{ id, kind, title, script, duration_seconds, published_at, audio_url }`. Returns `[]` in mock mode. Throws on query error.

- [ ] **Step 1: Add the helper**

Append to `dashboard/src/lib/supabase.js` (after the last existing helper):
```js
// ── Podcast helpers ──

// Fetch ready podcast episodes, newest first (Podcast view).
export async function listEpisodes() {
  if (isMockMode) return []
  const { data, error } = await supabase
    .from('episodes')
    .select('id, kind, title, script, duration_seconds, published_at, audio_url')
    .eq('status', 'ready')
    .order('published_at', { ascending: false })
  if (error) throw error
  return data
}
```

- [ ] **Step 2: Verify it compiles**

Run from `dashboard/`:
```bash
npm run build
```
Expected: build succeeds (no import/syntax errors). `listEpisodes` is exported but not yet used — that's fine; the wiring lands in Tasks 4–5.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/lib/supabase.js
git commit -m "feat: add listEpisodes() data helper"
```

---

### Task 4: PodcastView component

The view itself: two sections, inline player, transcript toggle, and loading/error/empty states.

**Files:**
- Create: `dashboard/src/components/PodcastView.jsx`

**Interfaces:**
- Consumes: `listEpisodes` from `../lib/supabase.js`; `splitByKind`, `formatDuration` from `../lib/episodes.js`; `formatDistanceToNow` from `date-fns`.
- Produces: `default export PodcastView` — a React component taking no props, mounted at `/podcast` in Task 5.

- [ ] **Step 1: Write the component**

Create `dashboard/src/components/PodcastView.jsx`:
```jsx
import { useState, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { listEpisodes } from '../lib/supabase.js'
import { splitByKind, formatDuration } from '../lib/episodes.js'

export default function PodcastView() {
  const [episodes, setEpisodes] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError]         = useState(null)
  const [playingId, setPlayingId] = useState(null)

  useEffect(() => {
    fetchEpisodes()
  }, [])

  async function fetchEpisodes() {
    setIsLoading(true)
    setError(null)
    try {
      const data = await listEpisodes()
      setEpisodes(data)
    } catch (e) {
      setError(e.message)
      setEpisodes([])
    } finally {
      setIsLoading(false)
    }
  }

  const { weekly, daily } = splitByKind(episodes)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-5 md:px-8 md:py-8">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Podcast</h1>
          <p className="text-sm text-gray-400">
            Your daily briefs and weekly deep dives — listen right here
          </p>
        </div>

        {/* Content */}
        {isLoading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={fetchEpisodes} />
        ) : episodes.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-8">
            {weekly.length > 0 && (
              <Section title="Weekly Deep Dive">
                {weekly.map(ep => (
                  <EpisodeCard
                    key={ep.id}
                    episode={ep}
                    isPlaying={playingId === ep.id}
                    onPlay={() => setPlayingId(ep.id)}
                  />
                ))}
              </Section>
            )}
            {daily.length > 0 && (
              <Section title="Daily Briefs">
                {daily.map(ep => (
                  <EpisodeCard
                    key={ep.id}
                    episode={ep}
                    isPlaying={playingId === ep.id}
                    onPlay={() => setPlayingId(ep.id)}
                  />
                ))}
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function EpisodeCard({ episode, isPlaying, onPlay }) {
  const [showTranscript, setShowTranscript] = useState(false)
  const timeAgo = episode.published_at
    ? formatDistanceToNow(new Date(episode.published_at), { addSuffix: true })
    : null
  const kindLabel = episode.kind === 'weekly' ? 'Weekly' : 'Daily'

  return (
    <div className="border border-gray-100 rounded-xl p-5 hover:border-gray-200 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-100">
          {kindLabel}
        </span>
        {timeAgo && <span className="text-xs text-gray-400">{timeAgo}</span>}
      </div>

      <h3 className="text-sm font-medium text-gray-900 leading-relaxed">{episode.title}</h3>
      <p className="text-xs text-gray-400 mt-1">{formatDuration(episode.duration_seconds)}</p>

      {/* Player */}
      <div className="mt-4">
        {isPlaying ? (
          <audio controls autoPlay src={episode.audio_url} className="w-full h-10">
            Your browser does not support the audio element.
          </audio>
        ) : (
          <button
            onClick={onPlay}
            className="flex items-center gap-2 text-sm text-gray-700 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play
          </button>
        )}
      </div>

      {/* Transcript */}
      <div className="mt-3 pt-3 border-t border-gray-50">
        <button
          onClick={() => setShowTranscript(v => !v)}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
        >
          <span className={`inline-block transition-transform ${showTranscript ? 'rotate-90' : ''}`}>▸</span>
          {showTranscript ? 'Hide transcript' : 'Show transcript'}
        </button>
        {showTranscript && (
          <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap leading-relaxed">
            {episode.script}
          </p>
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
        <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m-4 0h8m-4-6a3 3 0 01-3-3V5a3 3 0 116 0v4a3 3 0 01-3 3z" />
        </svg>
      </div>
      <p className="text-sm text-gray-500 font-medium">No episodes yet</p>
      <p className="text-xs text-gray-400 mt-1">
        The daily brief and weekly deep dive appear here once they're generated.
      </p>
    </div>
  )
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="text-center py-16">
      <p className="text-sm text-red-500 font-medium">Couldn't load episodes</p>
      <p className="text-xs text-gray-400 mt-1 mb-4">{message}</p>
      <button
        onClick={onRetry}
        className="text-xs text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors"
      >
        Try again
      </button>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3].map(i => (
        <div key={i} className="border border-gray-100 rounded-xl p-5">
          <div className="flex justify-between mb-3">
            <div className="h-5 bg-gray-100 rounded w-16" />
            <div className="h-5 bg-gray-100 rounded w-20" />
          </div>
          <div className="space-y-2">
            <div className="h-4 bg-gray-100 rounded w-3/4" />
            <div className="h-8 bg-gray-100 rounded w-24 mt-3" />
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run from `dashboard/`:
```bash
npm run build
```
Expected: build succeeds. The component isn't routed yet (Task 5), so it won't render — this step only confirms it compiles.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/PodcastView.jsx
git commit -m "feat: add PodcastView component (sections, inline player, transcript)"
```

---

### Task 5: Nav item + route wiring

Makes the view reachable: a "Podcast" sidebar item and the `/podcast` route.

**Files:**
- Modify: `dashboard/src/components/Sidebar.jsx` (add nav case + `NavItem`)
- Modify: `dashboard/src/App.jsx` (import + route)

**Interfaces:**
- Consumes: `PodcastView` default export from `./components/PodcastView.jsx`; the existing `NavItem`, `handleNav`, and `activeNav` machinery in `Sidebar.jsx`.

- [ ] **Step 1: Add the nav route case in `Sidebar.jsx`**

In `dashboard/src/components/Sidebar.jsx`, add a `podcast` branch to `handleNav` (after the `briefing` line):
```js
  function handleNav(key) {
    if (key === 'briefing') navigate('/briefing')
    else if (key === 'podcast') navigate('/podcast')
    else if (key === 'saved') navigate('/saved')
    else if (key === 'trends') navigate('/trends')
    else if (key === 'knowledge') navigate('/knowledge')
    else if (key === 'meetings') navigate('/meetings')
    else if (key === 'admin') navigate('/admin')
    else navigate(`/category/${key}`)
  }
```

- [ ] **Step 2: Add the `NavItem` in `Sidebar.jsx`**

Directly after the "Morning Briefing" `<NavItem ... />` block (it closes with `/>` around line 61), insert:
```jsx
        <NavItem
          label="Podcast"
          isActive={activeNav === 'podcast'}
          onClick={() => handleNav('podcast')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m-4 0h8m-4-6a3 3 0 01-3-3V5a3 3 0 116 0v4a3 3 0 01-3 3z" />
            </svg>
          }
        />
```

- [ ] **Step 3: Import and route `PodcastView` in `App.jsx`**

In `dashboard/src/App.jsx`, add the import alongside the other view imports (near the `KnowledgeView` import):
```jsx
import PodcastView from './components/PodcastView.jsx'
```

Then add the route inside `<Routes>`, directly after the `/briefing` route:
```jsx
            <Route path="/podcast" element={<PodcastView />} />
```

- [ ] **Step 4: Verify it builds**

Run from `dashboard/`:
```bash
npm run build
```
Expected: build succeeds with the new import and route resolved.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/Sidebar.jsx dashboard/src/App.jsx
git commit -m "feat: wire Podcast nav item and /podcast route"
```

---

### Task 6: End-to-end verification

Confirms the whole path works against real data: RLS lets the view read, the weekly episode is pinned on top, and playback + transcript work.

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Confirm the RLS migration is applied**

Verify Task 2 was applied to the live project (the SQL editor showed both policies on `episodes`). If not, apply `supabase/podcast_view_rls.sql` now — without it the view will be empty.

- [ ] **Step 2: Run the dashboard locally**

Run from `dashboard/`:
```bash
npm run dev
```
Expected: Vite serves at `http://localhost:5173`. Sign in as `ej.newsfeed@gmail.com` (the view requires an authenticated session — the RLS policy is scoped to the `authenticated` role).

- [ ] **Step 3: Verify the view**

Open `http://localhost:5173/podcast` (or click **Podcast** in the sidebar). Confirm all of:
- A **"Weekly Deep Dive"** section appears first, containing *"EJ Weekly Deep Dive — August 24, 2026"*.
- A **"Daily Briefs"** section appears below with the recent daily episodes, newest first.
- No `error`-status episodes appear (the 5 failed Aug-20 dailies must be absent).
- Clicking **Play** on the weekly episode reveals a native audio player and audio streams/plays.
- **Show transcript** expands the episode's script text and **Hide transcript** collapses it.

- [ ] **Step 4: Confirm the full test + build pass**

Run from `dashboard/`:
```bash
npm run test && npm run build
```
Expected: Vitest reports all tests passing; the production build succeeds.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

Only if Steps 1–4 surfaced fixes:
```bash
git add -A
git commit -m "fix: address Podcast view verification findings"
```

---

## Self-Review

**Spec coverage:**
- RLS migration (spec §1) → Task 2 ✅
- `listEpisodes()` helper (spec §2) → Task 3 ✅
- PodcastView: split by kind, weekly pinned, inline player, transcript, states (spec §3, §5) → Tasks 1 (helpers) + 4 ✅
- Nav + routing (spec §4) → Task 5 ✅
- Testing: pure-helper unit tests + live RLS + E2E (spec "Testing") → Tasks 1, 6 ✅
- Mock-mode safety (spec §5) → Task 3 helper returns `[]`; empty state in Task 4 ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases" — all steps carry concrete code and commands. ✅

**Type consistency:** `splitByKind`/`formatDuration` signatures identical in Task 1 definition and Task 4 usage; `listEpisodes()` return columns match the `select` in Task 3 and the fields read in Task 4 (`id, kind, title, script, duration_seconds, published_at, audio_url`); `playingId`/`onPlay`/`isPlaying` prop names consistent between `PodcastView` and `EpisodeCard`. ✅
