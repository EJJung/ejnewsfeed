# EJ Knowledge Center — Concept & Implementation Plan

*Drafted 2026-08-17 from discussion between EJ and Claude. Supersedes the "daily news summaries" framing of ejnewsfeed.*

---

## 1. Concept

ejnewsfeed evolves from an **ephemeral feed** (content arrives → summarized → expires) into a **compounding knowledge center** for four domains: AI, entrepreneurship, business, and UX. The purpose is to help EJ digest a heavy volume of trend information and convert it into durable understanding and better decisions.

The core architectural idea: **one knowledge layer, three consumers.**

The knowledge layer is a persistent store of *distilled* knowledge — insights/claims, decisions, hypotheses, contradictions, and open questions — each linked back to its sources. Everything else is a producer into or consumer of that layer:

- **Research** (weekly deep-research synthesis) writes insights into it
- **The podcast** reads from it (daily brief + weekly deep dive)
- **Meeting Packs** are assembled from it, and each discussion session **writes back** decisions, revised hypotheses, and new open questions

The write-back loop after each discussion session is a first-class pipeline stage, not an afterthought — it is what makes Meeting Pack N+1 smarter than Meeting Pack N.

This knowledge center also serves as the knowledge substrate for EJ's professional-reasoning system (the skills library with focus/required domains). The domain taxonomy and source-linking are therefore kept generic: any agent or skill can query "what do we currently believe about X, and what's contested?"

### AI stack decision

Claude remains the core intelligence for extraction, categorization, synthesis, research, Meeting Pack assembly, and post-meeting write-back (the existing pipeline already runs on it). **Revised 2026-08-20:** TTS is **ElevenLabs**, not OpenAI — EJ's call during Phase 2 implementation, prioritizing voice realism (existing ElevenLabs account) over vendor-count minimalism. OpenAI is now reserved solely for the **Realtime API** in Phase 3's live voice discussion sessions. The system runs on three AI vendors: Claude (reasoning), ElevenLabs (TTS), OpenAI (Realtime API only).

---

## 2. Architecture Overview

```
                    INGESTION (adapters)
  Gmail newsletters │ RSS articles │ YouTube transcripts │ Podcast audio→Whisper
                    └──────────────┬──────────────┘
                                   ▼
                          content items (articles table, generalized)
                                   ▼
              Claude: extract · categorize · summarize  (existing pipeline)
                                   ▼
        ┌──────────────────  KNOWLEDGE LAYER  ──────────────────┐
        │  insights · decisions · hypotheses · open_questions   │
        │  (all linked to sources; domain-tagged; status-tracked)│
        └──────┬──────────────────┬───────────────────┬─────────┘
               ▼                  ▼                   ▼
        Weekly research      Podcast gen         Meeting Packs
        (Claude synthesis)   (script→OpenAI TTS) (Claude assembly → EJ review)
                                                      ▼
                                             Realtime session (OpenAI Realtime API)
                                                      ▼
                                             Write-back (Claude: transcript →
                                             decisions/hypotheses/questions)──┐
                                                                              │
                                    KNOWLEDGE LAYER ◄─────────────────────────┘
```

Stack stays: Supabase (Postgres + Edge Functions + Storage + pg_cron), React/Vite/Tailwind dashboard on Vercel, Python local pipeline where needed.

---

## 3. Phases

### Phase 0 — Stabilize the pipeline (this week) — ✅ COMPLETE (2026-08-18/19)

The Aug 15 backlog fixes are committed but not deployed. Nothing new gets built on an unhealthy pipeline.

1. ✅ `supabase functions deploy process-emails fetch-emails` from repo root
2. ✅ Ran `supabase/triage_stale_backlog.sql` — stuck backlog dropped from 998 (Aug 14) to 0
3. ✅ Re-copied the launchd plist and reloaded — audits now fire at 11 AM, not 8:12 AM
4. Success target was stuck=0 / pending<~30 for one full week. Declared done early after finding and fixing the actual remaining defect: `process-emails` did Claude extraction and summary generation sequentially per email/category, so runs regularly exceeded the 5-minute EdgeRuntime ceiling and got killed by the stale-run watchdog (~half of all invocations). Parallelized extraction, article saves, and summary generation (`Promise.allSettled`), which cut run time from 2–5+ min to ~50s, and raised the per-run batch cap 4→8. Commit `6d49537`, deployed and verified live (backlog 33→23 pending in one afternoon, 0 stuck). Ongoing health should still be watched via the daily audits, but the root cause is fixed and the pipeline no longer needs babysitting to proceed to Phase 1.

### Phase 1 — Knowledge layer + multi-source ingestion (~2–3 weeks) — 1b/1c/1d ✅ COMPLETE, 1a IN PROGRESS (2026-08-19)

**1a. Generalize ingestion.** Extend `articles` (or introduce a `content_items` view of it) with `content_type` ('newsletter', 'web_article', 'youtube', 'podcast'), `transcript`, `duration_seconds`, `media_url`. Add adapters, each normalizing into the same shape the existing Claude extraction step already consumes:

- ~~**RSS/web articles**~~ — dropped from scope; EJ has no RSS feeds to ingest.
- ✅ **YouTube** — 8 subscribed channels (Lenny's Podcast, Dwarkesh Patel, Matt Wolfe, Riley Brown, Matt Pocock, Two Minute Papers, Hamel Husain, AI Engineer; Lex Fridman excluded as off-domain). New parallel lane (`raw_videos` buffer, mirrors `raw_emails`) rather than widening the newsletter lane — `fetch-emails`/`process-emails` untouched. Pipeline: `fetch-videos` (poll via free channel RSS + YouTube Data API overflow backfill → enrich/duration-gate via Data API before spending any transcript credit → transcribe via Supadata) → `process-videos` (Claude categorization/summarization → `articles` row, `content_type='youtube'`, `impact_score` = source-tier-only). Scheduled via `pg_cron` every 4h, staggered 15min per stage. Design spec: `docs/superpowers/specs/2026-08-19-youtube-ingestion-design.md`; plan: `docs/superpowers/plans/2026-08-19-youtube-ingestion.md`. Live-verified against production: 120 videos polled, 62 duration-gated as eligible, 32+ transcribed, 16+ real `articles` rows created; dashboard shows a thumbnail + duration badge on video cards. Two real bugs found and fixed during live testing: a Supadata rate-limit (switched from concurrent to ~1 req/sec-paced requests) and a silent whole-channel-outage alerting gap. **Remaining manual step:** `supabase/pg_cron_youtube.sql` still needs to be applied in the SQL Editor to turn on the automatic schedule (currently only runs on manual invocation). Source tiers left at default (all 8 channels tier C / 0.3 impact_score) — revisit later if warranted.
- ⏸️ **Podcasts** — deferred. Transcription requires Whisper, which conflicts with this doc's "AI stack decision" (OpenAI limited to TTS + Realtime API) — needs that question resolved before scoping.

**1b. Knowledge layer schema.** ✅ Complete. New tables, all domain-tagged and source-linked:

- `insights` — a claim or finding: text, domain(s), stance/confidence, status (candidate / active / superseded / contested / rejected), links to supporting and contradicting content items via `insight_sources`
- `decisions`, `hypotheses`, `open_questions` — schema created (matching the shape below), left empty until Phase 3's write-back loop populates them

Design rule for the professional-reasoning system: no ejnewsfeed-specific assumptions in these tables — generic domain taxonomy, generic source references — so skills can query them directly later.

**1c. Distillation jobs.** ✅ Complete.

- Daily: `distill-insights` extracts 0–3 candidate insights per domain from the day's top-impact articles (cheap, incremental)
- Weekly per domain: merges candidate insights against existing active insights, detects contradictions, promotes/merges/contests/rejects — live-tested against real data including the first-ever exercise of the promote and contest branches

Design spec: `docs/superpowers/specs/2026-08-18-knowledge-layer-schema-distillation-design.md`; plan: `docs/superpowers/plans/2026-08-18-knowledge-layer-distillation.md`.

**1d. Dashboard: Knowledge view.** ✅ Complete. Browse insights by domain; status filter (active/contested by default, toggle for candidate/superseded/rejected); each insight expands inline to its sources, with a supporting/contradicting split for contested insights. Design spec: `docs/superpowers/specs/2026-08-19-knowledge-view-design.md`; plan: `docs/superpowers/plans/2026-08-19-knowledge-view.md`. A pre-existing RLS bug (knowledge-layer tables granted `anon` instead of `authenticated` read access — this dashboard requires sign-in, so the tables were silently returning empty results for real users) was found and fixed live during this work, and a second instance of the same bug class was found and fixed on `pipeline_runs`/`AdminView`.

### Phase 2 — Podcast — daily brief ✅ COMPLETE (2026-08-20), weekly deep dive NOT STARTED

- ✅ **Daily brief (content-driven length, typically 5–20 min, single voice):** Claude turns the day's `daily_summaries` + top articles into one continuous spoken-word script (not read-aloud prose — written for the ear, ordered by impact across all categories) → **ElevenLabs TTS** (chunked ≤4500 chars on paragraph boundaries, synthesized sequentially, concatenated) → mp3 in Supabase Storage (`podcast-episodes` bucket). Scheduled via `pg_cron` at 22:35 UTC, 5 min after the evening `distill-insights` run. Live-verified against production: first real episode generated end-to-end (1,682 words, ~11 min, `status='ready'`, served correctly through the RSS feed) in ~70s. Design spec: `docs/superpowers/specs/2026-08-20-podcast-daily-brief-design.md`; plan: `docs/superpowers/plans/2026-08-20-podcast-daily-brief.md`. Scope was deliberately split from the original combined Phase 2 write-up above — daily brief first, to ship value sooner and build the shared delivery infra; weekly deep dive is its own follow-on spec.
- ⏸️ **Weekly deep dive (~15–20 min, two hosts):** not started. Claude writes a dialogue from the weekly synthesis — trends, contradictions, "what changed this week," open questions worth EJ's attention → two-voice TTS (ElevenLabs, matching the daily brief's vendor choice), stitched. Needs its own design pass — the `episodes` table already has a `kind` column (`'daily'`/`'weekly'`) so this slots in without a schema change, and `_shared/tts.ts`'s `synthesizeSpeech` helper is already vendor-agnostic enough to reuse.
- ✅ **Delivery:** `episodes` table + `podcast-feed` Edge Function serving a token-gated private RSS feed URL (deployed with `--no-verify-jwt` since real podcast apps can't send a Supabase auth header), so episodes appear in any podcast app automatically. Currently serves daily-brief episodes only; weekly episodes will appear in the same feed once built.
- ✅ `pg_cron` triggers the daily brief after its source summaries complete; a companion watchdog exemption (`pg_cron_watchdog_exclude_podcast.sql`) keeps the pipeline's existing global 5-minute stale-run alert from false-positiving on this job's longer TTS-synthesis runtime.

### Phase 3 — Discussion sessions (~3–4 weeks)

**3a. Meeting setup.** `meetings` table: agenda, prospective result, critical decision questions (EJ defines these), status. Simple creation form in the dashboard.

**3b. Meeting Pack assembly (Claude agent — the role EJ described for Codex).** Given the agenda and questions, it pulls from the knowledge layer: relevant insights (including contradicting pairs), prior related decisions, hypotheses in play, open questions, and fresh source material. Output: a structured pack of discrete context cards.

**3c. EJ review.** Dashboard UI listing the pack's context cards with include/exclude toggles and free-text additions. Nothing enters the meeting that EJ hasn't approved — this is the human-in-the-loop control point.

**3d. Realtime session (the "Realtime Founder Companion").** OpenAI Realtime API over WebRTC in the dashboard. System prompt = companion persona + the approved pack. Session behaviors: work the agenda toward the prospective result, press on the critical decision questions, surface the contradictory opinions in the pack rather than agreeing by default. Session audio/transcript captured.

**3e. Write-back (the flywheel).** After each session, Claude processes the transcript: decisions made → `decisions`; hypotheses formed/revised → `hypotheses`; new open questions → `open_questions`; meeting summary stored on the meeting record. The next pack assembly reads all of it.

### Phase 4 (later) — Compounding extras

Engagement-based recommendation layer (the `user_interactions` groundwork already exists); insight-graph visualization; exposing the knowledge layer as an API/MCP server for the professional-reasoning system's skills.

---

## 4. Risks & watch items

- **Transcription cost/volume:** Whisper on every podcast episode adds up — transcribe selectively (flagged/saved episodes) until value is proven
- **Insight quality drift:** distillation that extracts too much becomes a second feed to ignore; tune for few, high-confidence insights and let the weekly synthesis prune aggressively
- **Realtime API cost:** live voice sessions are the most expensive component per minute; cap session length and prefer weekly cadence initially
- **Write-back trust:** early on, EJ should review extracted decisions before they're committed to the knowledge layer (same approval pattern as pack review)
- **Sequencing discipline:** the podcast and companion are the exciting parts, but both degrade into generic AI content without the knowledge layer beneath them — Phase 1 stays first

## 5. Success criteria

- Phase 1: EJ checks the Knowledge view instead of reading every summary; contradictions between sources are surfaced automatically
- Phase 2: EJ listens to the daily brief on days the dashboard isn't opened; weekly deep dive replaces at least some raw newsletter reading
- Phase 3: each meeting ends with recorded decisions; a pack visibly references decisions and hypotheses from previous meetings
