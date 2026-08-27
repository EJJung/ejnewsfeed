# Podcast View — Design Spec

*Drafted 2026-08-26 from discussion between EJ and Claude.*

## Problem

Podcast episodes (daily briefs + the weekly deep dive) are generated, stored as
mp3s in the `podcast-episodes` Supabase Storage bucket, and served **only**
through the token-gated RSS feed (`podcast-feed` Edge Function). To listen, EJ
must subscribe that private feed URL inside a separate podcast app.

The dashboard web app (the Vercel "live site") has **no podcast player at all** —
neither daily nor weekly episodes are playable on the site. EJ wants to open the
site and listen to any episode anytime, with the weekly deep dive prominent so it
never gets buried under the daily briefs.

Investigation confirmed the weekly episode itself is healthy (in the DB as
`status='ready'`, audio reachable, present in the RSS feed). The gap is purely a
missing on-site listening surface.

## Goal

Add a **Podcast view** to the dashboard: a new nav item and page that lists
`ready` episodes with an inline audio player, the weekly deep dive pinned above
the daily briefs.

Non-goals (YAGNI, easy later adds): persistent/global player bar, download
management, episode search/filter, play-progress tracking, per-episode show notes
beyond the existing transcript.

## Constraint discovered: RLS blocks the read

`episodes` has RLS enabled with **only** a `service_role` policy
(`supabase/podcast_schema.sql`). The dashboard reads with the anon key under an
authenticated session, so with no `authenticated` SELECT policy the view would
receive **zero rows** — the same silent-empty RLS bug class previously hit on the
knowledge-layer tables and `pipeline_runs`. The fix is a new read policy, and it
is a required part of this feature (without it the UI renders but is always
empty).

The audio bucket is public (`storage.buckets.public = true`), so playback streams
the `audio_url` directly with no signed URLs or storage policy needed.

## Design

### 1. RLS migration — `supabase/podcast_view_rls.sql`

```sql
-- Podcast View: let the signed-in dashboard read ready episodes.
-- episodes previously had only a service_role policy, so authenticated
-- reads returned zero rows. Scope to status='ready' so half-finished
-- (generating/error) rows never reach the UI — matching what the RSS
-- feed serves.
CREATE POLICY "authenticated_read_ready_episodes" ON episodes
  FOR SELECT TO authenticated
  USING (status = 'ready');
```

- Read-only, `authenticated` role only, scoped to `status='ready'`.
- Service-role writes (`generate-podcast`) and the `podcast-feed` function
  (service role) are unaffected.
- Applied via the Supabase SQL editor, same as the other schema files in
  `supabase/`.

### 2. Data helper — `dashboard/src/lib/supabase.js`

One helper, matching the existing style (`fetchArticles`, `listMeetings`, etc.):

```js
// Fetch ready podcast episodes, newest first (Podcast view)
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

The `.eq('status','ready')` filter is redundant with the RLS policy but kept
explicit so the query's intent is clear at the call site and it stays correct if
the policy ever widens.

### 3. Component — `dashboard/src/components/PodcastView.jsx`

Follows the `KnowledgeView` shape (local `useState`, `useEffect` fetch, loading /
error / empty states).

**State & data:**
- Fetch once on mount via `listEpisodes()`.
- Split the flat list into `weekly` (`kind === 'weekly'`) and `daily`
  (`kind === 'daily'`) in memory. Both remain newest-first from the query order.
- `playingId` — the single episode whose audio player is mounted (null = none).
  Only one player is mounted at a time so two episodes can't play at once.

**Layout (option B — weekly pinned on top):**
- **"Weekly Deep Dive"** section first, then **"Daily Briefs"**. Each section is
  omitted entirely when its list is empty (e.g. no weekly yet → only Daily Briefs
  renders).

**Episode row:**
- Title, a small kind badge ("Weekly" / "Daily"), relative date via
  `formatDistanceToNow` (already a dependency, used in `KnowledgeView`), and
  duration formatted from `duration_seconds` (e.g. `899 → "15 min"`).
- **Play button (option A — inline native player):** clicking sets `playingId`
  and reveals a native `<audio controls src={audio_url}>` in that row. Native
  controls provide scrubbing, playback speed, and download for free. Playback
  stops when navigating away from the view (acceptable per scope; a persistent
  bar is a deliberate non-goal).
- **"Show transcript" toggle (option A):** expands the episode's `script` text,
  collapsed by default. Per-row local toggle state.

**Pure helpers (unit-testable, no DB):**
- `splitByKind(episodes)` → `{ weekly, daily }`.
- `formatDuration(seconds)` → human string (`"15 min"`, handles null → e.g. `"—"`).

### 4. Nav + routing

- `dashboard/src/components/Sidebar.jsx`: a **"Podcast"** `NavItem` with a
  headphones icon, placed near "Morning Briefing" (both are consumption
  surfaces). Uses the existing `NavItem` component and active-state logic.
- `dashboard/src/App.jsx`: add `import PodcastView` and a
  `<Route path="/podcast" element={<PodcastView />} />`, wired into the existing
  view resolution the same way `/knowledge`, `/meetings`, etc. are.

### 5. States

- **Loading:** the shared spinner pattern used by the other views.
- **Error:** inline message mirroring `KnowledgeView`'s error branch.
- **Empty:** friendly "No episodes yet" (realistically won't show — dailies
  exist — but handled so the view never looks broken).
- **Mock mode:** `listEpisodes()` returns `[]`, so the view renders the empty
  state with no crash when Supabase env vars are absent.

## Testing

- **Unit:** `splitByKind` and `formatDuration` are pure — test grouping, sort
  preservation, and duration formatting (including the null case) without a DB.
- **RLS (live):** after applying `podcast_view_rls.sql`, confirm an
  `authenticated`-role read returns the `ready` episodes and still hides
  `error`/`generating` rows.
- **End-to-end:** load `/podcast` on the running dashboard; confirm the weekly
  episode appears pinned in its own section above the daily briefs, the inline
  player streams and plays the mp3, and the transcript toggle expands the script.

## Files touched

| File | Change |
|---|---|
| `supabase/podcast_view_rls.sql` | New — `authenticated` SELECT policy on `episodes` |
| `dashboard/src/lib/supabase.js` | New `listEpisodes()` helper |
| `dashboard/src/components/PodcastView.jsx` | New — the view (+ pure helpers) |
| `dashboard/src/components/Sidebar.jsx` | New "Podcast" nav item |
| `dashboard/src/App.jsx` | Import + `/podcast` route |
| tests | Unit tests for `splitByKind` / `formatDuration` |

## Success criteria

EJ opens the dashboard, clicks **Podcast**, sees the weekly deep dive pinned at
the top and the daily briefs below, and can play any episode — and read its
transcript — without leaving the site.
