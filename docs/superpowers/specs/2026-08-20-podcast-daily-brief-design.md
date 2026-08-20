# Podcast — Daily Brief — Design

*Drafted 2026-08-20. First sub-project of Phase 2 in `knowledge-center-plan.md`. Scope split from that plan deliberately: daily brief (single voice) ships first and builds the shared delivery infra; the weekly deep dive (two-host dialogue) is a separate follow-on spec once this is live.*

---

## 1. What this adds

A daily ~5–20 minute audio brief, generated unattended each evening from that day's `daily_summaries`, delivered as a private podcast-app RSS feed. EJ adds the feed URL once to a podcast app; new episodes show up automatically, no dashboard visit required.

**Scope boundary:** this spec covers the daily brief only. The weekly two-host deep dive, any dashboard episode player, and episode retention/cleanup are explicitly out of scope — see §7.

**Updates the plan doc's AI stack decision.** `knowledge-center-plan.md` §1 says "OpenAI is used only where it is uniquely strong: TTS ... and Realtime API." This spec uses **ElevenLabs** for TTS instead (EJ already has an account, values voice realism over vendor-count minimalism). The stack is now three AI vendors: Claude (reasoning), ElevenLabs (TTS), OpenAI (reserved for Phase 3's Realtime API). `knowledge-center-plan.md` should be updated to reflect this when this spec is approved.

---

## 2. Pipeline flow

```
  daily_summaries (today, all categories)
  + top articles per category by impact_score
                    │
                    ▼
        generate-podcast [Claude] — writes one flowing script
                    │
                    ▼
        chunk script (~4500 chars, paragraph boundaries)
                    │
                    ▼
        ElevenLabs TTS, per chunk ──→ concatenate MP3 buffers
                    │
                    ▼
        Supabase Storage (podcast-episodes bucket)
                    │
                    ▼
        INSERT episodes row (status='ready')
                    │
                    ▼
        podcast-feed [Edge Function] ──→ RSS 2.0 + iTunes XML
                    │
                    ▼
        EJ's podcast app (polls the feed URL)
```

Two new Edge Functions, mirroring the existing `process-videos`/`distill-insights` shape: `pipeline_runs` row per invocation, `sendAlert` on fatal errors, background-task pattern (`EdgeRuntime.waitUntil`) for the potentially-long TTS synthesis step.

---

## 3. Schema

```sql
CREATE TABLE episodes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily','weekly')),
  title            TEXT NOT NULL,
  script           TEXT NOT NULL,        -- kept for debugging / re-synthesis without a fresh Claude call
  audio_url        TEXT,                 -- Storage public URL, set once synthesis succeeds
  duration_seconds INT,                  -- estimated from word count (~150 wpm), not decoded from audio
  published_at     TIMESTAMPTZ,          -- set when status flips to 'ready'; drives RSS item order
  status           TEXT NOT NULL DEFAULT 'generating'
                   CHECK (status IN ('generating','ready','error')),
  error_message    TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_episodes_published ON episodes(published_at DESC) WHERE status = 'ready';

ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_episodes" ON episodes FOR ALL TO service_role
  USING (true) WITH CHECK (true);
```

No `anon`/`authenticated` read policy — episodes are read only by the `podcast-feed` function (service role) and, later, an admin dashboard view if one gets built. `kind` is included now (not deferred) so the weekly deep dive slots into the same table without a migration later; only `'daily'` is produced by this spec.

A row is inserted as `'generating'` before synthesis starts (so a crash mid-run leaves a visible `error` row via the same `pipeline_runs`/`sendAlert` pattern, not a silent gap), and flipped to `'ready'` with `audio_url`/`duration_seconds`/`published_at` set on success.

---

## 4. `generate-podcast` — script generation

Triggered by pg_cron at **22:35 UTC** — 5 minutes after the evening `distill-insights` daily run (22:30 UTC), so the brief reflects the full day including that day's freshly-extracted insights context.

1. Query `daily_summaries WHERE date = today()`, joined to `categories` for names.
2. For each category, pull that day's top 3 articles by `impact_score` (title + snippet) as ordering/detail signal — the `daily_summaries.summary` text is already synthesized prose, the articles give Claude concrete details to optionally cite.
3. One Claude call. Prompt instructs:
   - Write **one continuous script**, not category-by-category headers — a real news-brief voice, transitions between topics.
   - Order by impact: lead with the highest-impact story across all categories, not the highest-impact category's summary first.
   - **Length is content-driven, not target-driven**: typical range 700–3000 words (~5–20 min at 150 wpm). Do not pad to hit a length; do not cut substance to stay short. Skip categories with no meaningful activity that day rather than force content.
   - Written for the ear: short sentences, no "as shown in the chart above"-style constructs, spell out things a listener can't see.
4. Output is the plain script text (no SSML/markdown) — stored on the `episodes` row before synthesis begins.

Skip entirely (no episode, no error) if `daily_summaries` has zero rows for today (e.g. a pipeline outage day) — log this as a `pipeline_runs` success with `metadata: { skipped: 'no_content' }`, not a failure.

---

## 5. TTS synthesis — ElevenLabs

- Voice and model selected once as a config constant (`ELEVENLABS_VOICE_ID`), picked for clear, neutral news narration — not exposed as a per-episode choice.
- **Chunking:** split the script into segments ≤4500 characters on paragraph boundaries (never mid-sentence). A 20-minute script (~17k characters) becomes ~4 chunks.
- Each chunk → one ElevenLabs `text-to-speech` call → raw MP3 bytes.
- **Concatenation:** chunks are joined via direct byte concatenation of the MP3 buffers, in order. No re-encoding step (Edge Functions have no ffmpeg available) — sequential complete MP3 frames play back correctly in standard players; a sub-frame click at chunk boundaries is an acceptable MVP tradeoff, not a correctness bug.
- **Duration estimate:** `word_count / 150 * 60` seconds, rounded. Not decoded from the actual audio — no MP3-parsing dependency needed for an approximate `<itunes:duration>` value.
- Secret: `ELEVENLABS_API_KEY` via `supabase secrets set`, same mechanism as `SUPADATA_API_KEY`/`ANTHROPIC_API_KEY`.

---

## 6. Storage & delivery

**Storage:** Supabase Storage bucket `podcast-episodes`, public (not authenticated-read) — the bucket path uses the episode's UUID as filename (`{episode_id}.mp3`), so files are unguessable without the RSS feed even though the bucket itself is public. This is the same trust model as the feed's token-gated URL: not real access control, just not indexed/discoverable. Acceptable given the content (a personal news brief, not sensitive data).

**`podcast-feed` Edge Function** (`GET /functions/v1/podcast-feed?token=<secret>`):
1. Compare `token` query param against `PODCAST_FEED_TOKEN` secret (constant-time compare not required — this isn't defending against a real adversary, just keeping the feed off crawlers/search).
2. Mismatch → 403, empty body.
3. Match → query `episodes WHERE status = 'ready' ORDER BY published_at DESC LIMIT 50`, render RSS 2.0 + `<itunes:*>` namespace XML: `<channel>` metadata (title "EJ Daily Brief", etc.) + one `<item>` per episode with `<enclosure url="{audio_url}" type="audio/mpeg">`, `<itunes:duration>`, `<pubDate>`.
4. `Content-Type: application/rss+xml`.

EJ adds `https://<project>.supabase.co/functions/v1/podcast-feed?token=<secret>` to a podcast app once; new episodes appear on the app's normal refresh cycle.

---

## 7. Explicitly out of scope (this spec)

- **Weekly deep dive** (two-host dialogue, synthesized from `insights` table changes) — separate spec once this daily pipeline has run for a bit.
- **Dashboard episode player / episode list UI** — EJ chose RSS-feed-only delivery; no dashboard changes here.
- **Episode retention/cleanup job** — audio kept indefinitely per EJ's call; revisit if Storage cost becomes real.
- **Exact audio duration via decoding** — word-count estimate only.

---

## 8. Error handling & scheduling

- `pipeline_runs` row (`job_name='generate-podcast'`) opened at start, closed with `status`/`metadata` on completion — same shape as `process-videos`.
- Any fatal error (Claude call fails, all TTS chunks fail, Storage upload fails) → `episodes.status='error'` with `error_message`, `pipeline_runs` marked `error`, `sendAlert('generate-podcast', ...)`.
- Partial TTS failure (some chunks succeed, one fails): treat as fatal for the whole episode rather than publishing a truncated brief — retry on the next scheduled run naturally overwrites nothing (a fresh `episodes` row each day), so a failed day just has no episode rather than a broken one.
- pg_cron addition to a new `supabase/pg_cron_podcast.sql` (following the `pg_cron_youtube.sql` file-per-feature convention):

| Job | Cron (UTC) | Note |
|---|---|---|
| `podcast-daily-brief` | `35 22 * * *` | 5 min after `distill-insights` daily (`30 22 * * *`) |

---

## 9. Risks & watch items

- **MP3 concatenation artifacts.** Byte-level joining is the pragmatic MVP choice; if chunk-boundary clicks are audible/annoying in practice, revisit with a proper stitching approach (e.g. shipping the concatenation step out to a tool that can re-encode) — don't pre-build this before hearing whether it's actually a problem.
- **ElevenLabs cost.** No monthly estimate yet (unlike the YouTube spec's §8) — get one real day's script length once this is live, multiply by ElevenLabs' per-character rate, and revisit if it's a surprise.
- **Duration estimate drift.** If word-count-based `duration_seconds` turns out visibly wrong against actual playback (podcast apps show a progress bar against it), that's the signal to add real audio parsing — not a reason to add it now.
- **Feed token in a plain query param.** Fine for "keep it off crawlers," not a real secret boundary — if the feed URL ever leaks, rotating `PODCAST_FEED_TOKEN` invalidates it immediately (single env var).

---

## 10. Success criteria

- A new episode appears in `episodes` (`status='ready'`) every evening, unattended, for a week straight.
- The RSS feed validates in a real podcast app (added once, episode shows up, plays start-to-finish with no obviously broken audio).
- A day with genuinely little news produces a shorter episode rather than padded filler; a heavy day produces a longer one — length tracks content per §4.
