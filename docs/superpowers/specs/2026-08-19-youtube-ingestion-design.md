# YouTube Ingestion — Implementation Plan

*Drafted 2026-08-19. Revised same day against the real subscription list of `ej.newsfeed@gmail.com`. Implements the **YouTube** adapter of Phase 1a in `knowledge-center-plan.md`. Vendor prices checked 2026-08-19; re-confirm before signup.*

*(Drafted in a separate session; brought into this session's workflow as the approved design. Verified against the live schema on 2026-08-19: `sources` and `articles` match the columns assumed below exactly — no YouTube-related columns exist yet, `articles.full_content` exists, `sources.email_address` is nullable. RSS was dropped from Phase 1a's scope by the user before this design was written — this document only covers YouTube. Two implementation-time unknowns to resolve during the task plan/Step 0, not design gaps: Supadata's exact "no captions" error response shape, and the YouTube Data API key's env var name — `YOUTUBE_DATA_API_KEY`, chosen for consistency with this codebase's existing naming.)*

---

## 1. What this adds

Eight YouTube channels become first-class sources alongside newsletters: new uploads are detected automatically, filtered, transcribed, categorized by Claude, and written into `articles` so everything downstream — daily summaries, `distill-insights`, the Knowledge view, and later the podcast and Meeting Packs — treats a video exactly like any other content item.

**Scope boundary:** ingestion only (video → `articles` row). Nothing in `process-emails`, `distill-insights`, or the summary path changes.

---

## 2. The source list (measured 2026-08-19)

All nine subscribed channels were checked; every RSS feed returned HTTP 200. **Lex Fridman is dropped** — recent uploads are largely off-domain (MMA, religion, politics) and 3–5 hour episodes are the single most expensive thing the pipeline could process.

| Channel | Channel ID | Raw rate | Character |
|---|---|---|---|
| Lenny's Podcast | `UC6t1O76G0jYXOAoYCm153dA` | ~13.1/wk | Full episodes + heavy 1–3 min clip cuts |
| Dwarkesh Patel | `UCXl4i9dYBrFOabk0xGmbkRA` | ~6.6/wk | Same pattern — long interviews + clips |
| Matt Wolfe (@mreflow) | `UChpleBmo18P08aKCIgti38g` | ~5.3/wk | 10–20 min AI news roundups |
| Riley Brown | `UCMcoud_ZW7cfxeIugBflSBw` | ~3.2/wk | AI agents, practitioner-focused |
| Matt Pocock | `UCswG6FSbgZjbWtdf_hMLaow` | ~3.1/wk | AI engineering, mixed length |
| Two Minute Papers | `UCbfYPyITQ-7l4upoX8nvctg` | ~1.9/wk | Genuinely short standalone videos |
| Hamel Husain | `UC__dUuqF5w4OnbW221JxmKg` | ~1.9/wk | Long-form ML talks |
| AI Engineer | `UCLKPca3kwwd-B59HNr-_lvA` | **bursty** | Conference dumps — 15 videos in 1 day |
| ~~Lex Fridman~~ | ~~`UCSHZKyawb77ixDdsGog4iWA`~~ | ~~0.5/wk~~ | **Dropped — off-domain, 3–5 hr episodes** |

Three facts from this measurement drive the whole design:

1. **Most uploads are short clips, not episodes.** Lenny's 15-item RSS window spans only 8 days; Dwarkesh's 16. Both cut their interviews into 1–3 minute promo clips. Transcribing the clip *and* the episode puts near-duplicate insights into the knowledge layer.
2. **`@aiDotEngineer` published 15 videos in one day.** Its RSS window is *one day deep*. Any polling gap during a conference dump silently loses videos.
3. **RSS carries no duration.** Confirmed by inspecting the feed XML — entries expose `yt:videoId`, `title`, `published`, `media:thumbnail`, `media:description`, `media:statistics`, and nothing about length. So the duration filter cannot happen at poll time from RSS alone.

---

## 3. The core design decision: a parallel lane, not a widened one

The existing pipeline is *newsletter-shaped*: one `raw_emails` row → Claude extracts **N** articles → N `articles` rows. A YouTube video is the opposite shape: one video **is** one item, and "extraction" is categorization + summarization of a single long transcript.

Bending `raw_emails` and `process-emails` to carry both shapes means touching the function just stabilized in Phase 0 after the EdgeRuntime timeout fix. Not worth it.

```
  NEWSLETTER LANE (existing, untouched)
  Gmail → fetch-emails → raw_emails → process-emails ─────────────┐
                                                                   ├→ articles → summaries → distill-insights
  VIDEO LANE (new)                                                 │
  RSS → fetch-videos(poll) ──────────── raw_videos: pending        │
      → fetch-videos(enrich)  [Data API, free] → duration gate     │
                                        ├→ too_short (dead end)    │
                                        └→ eligible                │
      → fetch-videos(transcribe) [Supadata] → transcribed          │
      → process-videos [Claude] ─────────────────────────────────── ┘
```

`fetch-videos` takes a `{"mode": "poll" | "enrich" | "transcribe"}` body rather than being three functions — mirroring the existing `distill-insights` daily/weekly mode pattern, keeping the function count down while letting each stage be scheduled and retried separately.

**The `enrich` stage is the important addition.** It costs nothing and it is what makes the duration filter possible *before* spending a transcript credit.

---

## 4. Tooling decisions

### 4a. Detection — YouTube channel RSS (free, no key)

```
https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxx
```

No API key, no OAuth, no quota. Returns the last 15 uploads with video ID, title, description, thumbnail, and published timestamp.

**Overflow detection.** Because the window is only 15 items — one day deep for `@aiDotEngineer` — the poller must notice when it has fallen behind:

> If the feed returns 15 entries **and** the oldest is newer than `sources.last_polled_at`, items were missed. Fall back to the Data API (§4b) `playlistItems.list` on the channel's uploads playlist and page back to `last_polled_at`.

The uploads playlist ID is the channel ID with `UC` → `UU` (`UCLKPca3kwwd-B59HNr-_lvA` → `UULKPca3kwwd-B59HNr-_lvA`), which saves a `channels.list` call. This is ~20 lines and it is the difference between a pipeline that quietly drops conference talks and one that doesn't.

### 4b. Metadata — YouTube Data API v3, for duration only

```
GET https://www.googleapis.com/youtube/v3/videos
      ?part=contentDetails,snippet&id=<up to 50 comma-separated ids>&key=API_KEY
```

**1 quota unit per call, 50 videos per call, 10,000 units/day free.** At ~200 raw videos/month that's ~4 calls a month — the quota is not a consideration. Needs only a plain API key (public data), not OAuth.

> This reverses the earlier "don't use the Data API" note, and the distinction matters: the Data API is useless for **captions** (`captions.download` only works on videos you own) but it is the correct, nearly free way to get **duration**. Use it for metadata, never for transcripts.

Also used for the overflow backfill above (`playlistItems.list`, 1 unit, 50/page).

### 4c. Transcripts — hosted API, not a library

The one thing worth paying for. `youtube-transcript-api` and `yt-dlp` are free and work perfectly from EJ's MacBook, but both fail from Supabase Edge Functions: YouTube blocks most known cloud-provider IP ranges (the library's own README says so), and yt-dlp hits "Sign in to confirm you're not a bot" from datacenter IPs. The workaround is rotating residential proxies — more expensive than a transcript API and a permanent maintenance surface.

**Chosen: Supadata.** $5/mo Basic (300 credits, 1 credit per transcript), free tier 100 credits/month. Plain HTTPS GET, works from Deno:

```ts
const res = await fetch(
  `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`,
  { headers: { 'x-api-key': Deno.env.get('SUPADATA_API_KEY')! } },
)
// → { content: string, lang: string, availableLangs: string[] }
```

Runner-up if it disappoints: **TranscriptAPI** ($5/mo, faster, ships an MCP server). Because a swap is plausible, the call lives behind a single `getTranscript(videoId)` in `_shared/transcript.ts`, selected by a `TRANSCRIPT_PROVIDER` env var. Swapping vendors should be one file and one secret.

These channels caption reliably, so this path should cover ~95% of eligible videos.

### 4d. Fallback for missing captions — Groq Whisper, run locally, deferred

**Groq `whisper-large-v3-turbo`: $0.04/hour of audio, ~216× realtime** — roughly 25× cheaper than OpenAI's Whisper endpoint. But Whisper needs the audio file, which needs `yt-dlp`, which brings back the datacenter-IP problem. So the fallback runs **on the Mac**, in the existing `pipeline/` + launchd setup: poll Supabase for `raw_videos` stuck at `status='no_captions'`, pull audio, transcribe, write back.

**Deferred to Step 7** and possibly never needed. Ship the captioned path and let real `no_captions` counts decide.

> Groq is still the right tool for the Phase 1a **podcast** adapter, where audio URLs come straight from RSS and there's no bot detection — that one can run in the cloud. The local-runner constraint is YouTube-specific.

---

## 5. Schema changes

### 5a. `sources` — describe non-email sources

```sql
ALTER TABLE sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'newsletter'
  CHECK (source_type IN ('newsletter','youtube','rss','podcast'));
ALTER TABLE sources ADD COLUMN youtube_channel_id   TEXT UNIQUE;
ALTER TABLE sources ADD COLUMN feed_url             TEXT;
ALTER TABLE sources ADD COLUMN min_duration_seconds INT NOT NULL DEFAULT 300;
ALTER TABLE sources ADD COLUMN last_polled_at       TIMESTAMPTZ;
```

`email_address` is already nullable, so YouTube sources slot in without touching its UNIQUE constraint. Existing rows default to `'newsletter'` — no backfill.

`min_duration_seconds` defaults to **300 (5 minutes)** per the chosen clip policy. It's a per-source column rather than a constant because Two Minute Papers publishes genuinely short standalone videos and may want a lower threshold once there's data — but everything starts at 5 minutes.

### 5b. `raw_videos` — the ingestion buffer (mirrors `raw_emails`)

```sql
CREATE TABLE raw_videos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_video_id  TEXT UNIQUE NOT NULL,     -- dedup key, same role as gmail_message_id
  source_id         UUID REFERENCES sources(id),
  title             TEXT NOT NULL,
  description       TEXT,
  url               TEXT,
  thumbnail_url     TEXT,
  published_at      TIMESTAMPTZ,
  duration_seconds  INT,
  transcript        TEXT,
  transcript_lang   TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','enriched','too_short','transcribed',
                                      'no_captions','error','processed')),
  attempts          INT NOT NULL DEFAULT 0,
  error_message     TEXT,
  processed         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_raw_videos_status    ON raw_videos(status) WHERE processed = false;
CREATE INDEX idx_raw_videos_published ON raw_videos(published_at DESC);

ALTER TABLE raw_videos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_raw_videos" ON raw_videos FOR ALL TO service_role
  USING (true) WITH CHECK (true);
```

`too_short` is a terminal state, not an error — those rows stay as a cheap record that the video was seen and deliberately skipped, so the poller never reconsiders it.

The `attempts` counter matters: a transcript that isn't ready yet (YouTube takes minutes to hours to auto-caption a fresh upload) is a **retryable** failure, and without a cap it retries forever and burns credits. Give up at `attempts >= 4` → `status='error'`.

### 5c. `articles` — mark the content type

```sql
ALTER TABLE articles ADD COLUMN content_type TEXT NOT NULL DEFAULT 'newsletter'
  CHECK (content_type IN ('newsletter','web_article','youtube','podcast'));
ALTER TABLE articles ADD COLUMN raw_video_id     UUID REFERENCES raw_videos(id);
ALTER TABLE articles ADD COLUMN duration_seconds INT;
ALTER TABLE articles ADD COLUMN thumbnail_url    TEXT;

CREATE INDEX idx_articles_content_type ON articles(content_type);
```

**The transcript goes in the existing `full_content` column.** It's already defined as the Dive-view body, so Dive and chat work for videos on day one with no dashboard change. `raw_videos.transcript` is the raw store; `articles.full_content` is the serving copy.

---

## 6. The four jobs

### 6a. `fetch-videos` — mode `"poll"`

Free, fast, runs in seconds.

1. `SELECT * FROM sources WHERE source_type='youtube' AND active=true`
2. For each: fetch channel RSS, parse `<entry>` elements
3. Insert new entries into `raw_videos` as `status='pending'`, relying on `youtube_video_id UNIQUE` for idempotent dedup (same pattern `fetch-emails` uses for `gmail_message_id`)
4. **Overflow check:** if 15 entries returned and oldest > `last_polled_at`, run the `playlistItems.list` backfill (§4a) before stamping `last_polled_at`
5. Open/close a `pipeline_runs` row (`job_name='fetch-videos-poll'`) and `sendAlert` on failure — same shape as every other function here

### 6b. `fetch-videos` — mode `"enrich"` — the gate

1. `SELECT youtube_video_id FROM raw_videos WHERE status='pending' LIMIT 50`
2. One `videos.list` call with all 50 IDs
3. Parse ISO-8601 `contentDetails.duration` (`PT1H23M45S`) → seconds
4. `duration < sources.min_duration_seconds` → `status='too_short'` (terminal). Otherwise `status='enriched'`
5. A video ID absent from the response (deleted/private) → `status='error'`

This stage is what keeps the transcript bill down: on the measured rates it discards roughly **half of all raw uploads** before a single credit is spent.

### 6c. `fetch-videos` — mode `"transcribe"`

1. `SELECT ... WHERE status='enriched' AND attempts < 4 ORDER BY published_at ASC LIMIT 15`
2. `Promise.allSettled` over `getTranscript(videoId)` — fast HTTP calls (~50–500ms), so 15 concurrent sits comfortably inside the runtime ceiling
3. Success → store `transcript`, `transcript_lang`, `status='transcribed'`
4. No-captions error → `status='no_captions'` (Step 7 territory)
5. Other errors → `attempts + 1`, stay `'enriched'`; at 4 attempts → `'error'` + alert

### 6d. `process-videos` — transcript → `articles` row

Modeled on `process-emails`' concurrency shape, smaller batch because payloads are 10–100× bigger.

1. `SELECT ... WHERE status='transcribed' AND processed=false ORDER BY published_at ASC LIMIT 4`
2. Load `categories` (same as `process-emails`)
3. `Promise.allSettled`, one Claude call per video:
   - **Single pass, essentially always.** With Lex dropped, the longest routine input is a ~90-minute Lenny episode (~12k tokens) and AI Engineer talks run 15–30 min (~4k). Sonnet handles these trivially.
   - **Map-reduce above ~20k tokens** stays in the design as a safety valve for the occasional 3-hour stream — split on transcript time offsets into ~15k-token chunks, summarize each, one synthesis call over the summaries. **Do not build this in Step 5**; add it the first time a video trips the threshold.
   - Output: `title` (cleaned — YouTube titles are clickbait-shaped), `snippet` (3–5 sentence summary), `category`, `category_tags`, `relevance_score`
4. Insert one `articles` row: `content_type='youtube'`, `raw_video_id`, `source_id`, `url`, `full_content` = transcript, `duration_seconds`, `thumbnail_url`, `published_at`
5. Set `raw_videos.processed = true`, `status='processed'`
6. Add affected dates to the same `daily_summaries` backfill path `process-emails` already uses, so videos land in the day's summary alongside newsletter articles

**`impact_score` needs a decision.** `computeStoryReachScores` derives impact from how many newsletters mention the same story — a signal a video doesn't have. Options: (a) constant `0.5`, (b) source-authority-only via the existing `getSourceAuthorityScore`, (c) keyword overlap against the same week's articles, so a video covering a story several newsletters also covered scores higher. **Start with (b)**; (c) is the interesting version but shouldn't block shipping.

---

## 7. Rollout

| Step | Work | Gate before moving on |
|---|---|---|
| **0** | Supadata free tier + a Google API key. `curl` three videos — one recent, one 90-min episode, one AI Engineer talk. | Transcripts come back clean; `videos.list` returns durations |
| **1** | Run the §5 migrations in the SQL editor | `raw_videos` exists; next daily audit still green |
| **2** | Seed the 8 channels from §2 into `sources` (`source_type='youtube'`, `youtube_channel_id`, `min_duration_seconds=300`) | All 8 RSS feeds return 200 (already verified) |
| **3** | `fetch-videos` poll mode + overflow detection | Manual invoke creates rows; second invoke creates zero; overflow path testable by setting `last_polled_at` back a week on `@aiDotEngineer` |
| **4** | Enrich mode | Rows split `pending → enriched` / `too_short`; the split ratio matches expectation |
| **5** | Transcribe mode + `_shared/transcript.ts` | Rows reach `transcribed`; credit burn matches the enriched count |
| **6** | `process-videos` + `pg_cron` + dashboard treatment | Video `articles` rows with sane titles/categories; videos appear in `daily_summaries` |
| **7** | *(Deferred)* Local Whisper fallback in `pipeline/` | Only if `no_captions` turns out to be a meaningful share |

### Suggested schedule (`supabase/pg_cron_youtube.sql`)

Every 4 hours rather than 8 — `@aiDotEngineer`'s one-day RSS window makes a tighter cadence worth the (free) polling. Offset from the newsletter lane so the two don't burst Claude calls at each other. Times UTC.

| Job | Cron | Note |
|---|---|---|
| `youtube-poll` | `0 */4 * * *` | 6×/day; RSS is free |
| `youtube-enrich` | `10 */4 * * *` | 10 min later; 1 quota unit per run |
| `youtube-transcribe` | `25 */4 * * *` | 15 min after enrich, giving YouTube time to auto-caption |
| `youtube-process` | `45 */4 * * *` | 4 videos × 6 runs = 24/day capacity vs ~4/day arrivals — ample burst headroom |

Same `net.http_post` + `_pipeline_config` pattern as `pg_cron_distill_insights.sql`.

### Dashboard

Minimum viable: a video badge + duration on the article card, thumbnail as the card image. The Dive view needs no change — `full_content` already renders. Add a content-type filter once videos exceed ~20% of the feed.

---

## 8. Volume and cost

Applying the 5-minute gate to the measured rates:

| | Raw uploads/mo | After 5-min gate |
|---|---|---|
| 7 regular channels | ~155 | **~72** |
| `@aiDotEngineer` (bursty avg) | ~25–50 | ~30 |
| **Total** | **~180–205** | **~100/mo** |

| Line item | Monthly |
|---|---|
| Supadata Basic (~100 credits used of 300) | $5 |
| Claude `process-videos` (~100 videos × ~5k tokens, Sonnet) | ~$1.50 |
| YouTube Data API v3 | $0 |
| YouTube RSS | $0 |
| Groq Whisper fallback (if built) | <$0.50 |
| **Total** | **~$7/mo** |

Two things changed the economics versus the first draft (~$12–14): dropping Lex removed the 3–5 hour episodes that dominated the Claude line, and the enrich gate stops ~half the volume before it costs anything. **The transcript API is now the largest line item, and Claude is nearly free** — the reverse of the first estimate.

Worth noting the free tier is 100 credits/month, which is *almost exactly* the projected steady-state volume. Start there; move to Basic the first time a conference dump blows through it.

---

## 9. Risks & watch items

- **The 5-minute gate is a guess until measured.** It's derived from sampling titles, not durations. After Step 4, check what `too_short` actually caught — if full Lenny segments are being discarded, raise or per-channel it. This is why `min_duration_seconds` is a column, not a constant.
- **Conference bursts overrun the free tier.** A 100-talk AI Engineer dump is 100 credits in a day. The overflow backfill makes sure they're all *captured*; the credit ceiling decides whether they're all *transcribed*. Consider a per-run credit budget so a burst degrades gracefully instead of failing hard.
- **Transcript vendor is a single point of failure.** Mitigated by `_shared/transcript.ts` — but actually test the swap path once, don't assume it works.
- **Auto-caption quality.** No punctuation, no speaker labels, mangled proper nouns. Fine for Claude summarization, bad shown verbatim to a human — so don't surface raw transcripts in the Dive view without a cleanup pass.
- **Fresh uploads have no captions yet** — the most likely source of `no_captions` false positives. The 15-minute enrich→transcribe gap plus 4 retries should cover it; if `no_captions` runs high, widen the gap before building the Whisper fallback.
- **No relevance filter by design.** Dropping Lex removed the off-domain problem at its source rather than adding a pre-filter stage. If another channel drifts off-domain, prefer dropping or replacing it over building the filter — it's the simpler lever.
- **`process-videos` runtime.** Keep the batch at 4 and use the background-task pattern `process-emails` already uses (`processAll` invoked without awaiting the response).
- **Scope creep into podcasts.** The podcast adapter shares ~70% of this design (RSS → audio → transcript → article). Resist merging until the YouTube lane has run two weeks — but keep `raw_videos` column names generic enough to copy.

---

## 10. Success criteria

- New uploads from the 8 channels appear in the feed within ~4 hours, unattended, for two consecutive weeks
- A conference dump from `@aiDotEngineer` is captured completely — count in `raw_videos` matches the channel's actual upload count for that day
- `distill-insights` produces at least one insight whose supporting sources include both a video and a newsletter — the knowledge layer is genuinely cross-source
- No regression in the newsletter lane: daily audits stay at 0 stuck, pending < ~30
