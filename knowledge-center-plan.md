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

### Phase 1 — Knowledge layer + multi-source ingestion (~2–3 weeks) — ✅ COMPLETE (1a confirmed 2026-08-20)

**1a. Generalize ingestion.** Extend `articles` (or introduce a `content_items` view of it) with `content_type` ('newsletter', 'web_article', 'youtube', 'podcast'), `transcript`, `duration_seconds`, `media_url`. Add adapters, each normalizing into the same shape the existing Claude extraction step already consumes:

- ~~**RSS/web articles**~~ — dropped from scope; EJ has no RSS feeds to ingest.
- ✅ **YouTube** — 8 subscribed channels (Lenny's Podcast, Dwarkesh Patel, Matt Wolfe, Riley Brown, Matt Pocock, Two Minute Papers, Hamel Husain, AI Engineer; Lex Fridman excluded as off-domain). New parallel lane (`raw_videos` buffer, mirrors `raw_emails`) rather than widening the newsletter lane — `fetch-emails`/`process-emails` untouched. Pipeline: `fetch-videos` (poll via free channel RSS + YouTube Data API overflow backfill → enrich/duration-gate via Data API before spending any transcript credit → transcribe via Supadata) → `process-videos` (Claude categorization/summarization → `articles` row, `content_type='youtube'`, `impact_score` = source-tier-only). Scheduled via `pg_cron` every 4h, staggered 15min per stage. Design spec: `docs/superpowers/specs/2026-08-19-youtube-ingestion-design.md`; plan: `docs/superpowers/plans/2026-08-19-youtube-ingestion.md`. Live-verified against production: 120 videos polled, 62 duration-gated as eligible, 32+ transcribed, 16+ real `articles` rows created; dashboard shows a thumbnail + duration badge on video cards. Two real bugs found and fixed during live testing: a Supadata rate-limit (switched from concurrent to ~1 req/sec-paced requests) and a silent whole-channel-outage alerting gap. ✅ `supabase/pg_cron_youtube.sql` has been applied — confirmed 2026-08-20 via `cron.job`/`cron.job_run_details`: all 4 jobs (`youtube-poll`/`-enrich`/`-transcribe`/`-process`) active and succeeding on the 4-hour staggered schedule. Source tiers left at default (all 8 channels tier C / 0.3 impact_score) — revisit later if warranted.
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

### Phase 2 — Podcast — daily brief ✅ COMPLETE (2026-08-20), weekly deep dive ✅ COMPLETE (2026-08-24, live-verified)

- ✅ **Daily brief (content-driven length, typically 5–20 min, single voice):** Claude turns the day's `daily_summaries` + top articles into one continuous spoken-word script (not read-aloud prose — written for the ear, ordered by impact across all categories) → **ElevenLabs TTS** (chunked ≤4500 chars on paragraph boundaries, synthesized sequentially, concatenated) → mp3 in Supabase Storage (`podcast-episodes` bucket). Scheduled via `pg_cron` at 22:35 UTC, 5 min after the evening `distill-insights` run. Live-verified against production: first real episode generated end-to-end (1,682 words, ~11 min, `status='ready'`, served correctly through the RSS feed) in ~70s. Design spec: `docs/superpowers/specs/2026-08-20-podcast-daily-brief-design.md`; plan: `docs/superpowers/plans/2026-08-20-podcast-daily-brief.md`. Scope was deliberately split from the original combined Phase 2 write-up above — daily brief first, to ship value sooner and build the shared delivery infra; weekly deep dive is its own follow-on spec.
- ✅ **Weekly deep dive (~15–20 min, two hosts):** code-complete, merged, and live-verified end-to-end on the first real Monday (2026-08-24). `generate-podcast` gained `mode: 'daily'|'weekly'` (mirroring `distill-insights`'s existing mode pattern); weekly mode gathers that week's promoted/contested/reinforced insights + open questions + top articles from the knowledge layer, has Claude write a two-host JSON dialogue (peer co-hosts, real back-and-forth on contested insights), and synthesizes it via a new `synthesizeDialogue` helper in `_shared/tts.ts` (one ElevenLabs call per speaker turn, two distinct voice IDs, byte-concatenated — same MVP tradeoff as the daily brief's chunk concatenation). No schema change needed (`episodes.kind='weekly'` already existed) and `podcast-feed` needed no changes (already serves all kinds). Scheduled via `pg_cron` at 13:15 UTC Mondays, 15 min after the weekly `distill-insights` run. Design spec: `docs/superpowers/specs/2026-08-20-podcast-weekly-deep-dive-design.md`; plan: `docs/superpowers/plans/2026-08-20-podcast-weekly-deep-dive.md`. **Two things blocked full live verification at merge time, both external/data conditions rather than code defects:** (1) the ElevenLabs account's TTS quota was exhausted mid-implementation (195/10,000 credits remaining), so no real audio was synthesized for either podcast mode in that session; (2) the knowledge layer is only ~2 days old in production and has zero `active`/`contested` insights and zero `open_questions` yet, so the first live weekly invoke correctly hit the "skip, no content" branch rather than exercising the dialogue-generation/two-voice-synthesis path. Voice-routing/chunking logic was verified via a local mocked-fetch script instead. A whole-branch code review approved the merge (no Critical/Important blockers) but flagged one non-damaging risk to watch on the first real run: a 15–20 min episode is 60–100+ sequential ElevenLabs calls inside one background task, and if the platform kills a run mid-synthesis, the `episodes` row would stay stuck at `'generating'` (invisible to the RSS feed, which only serves `'ready'` rows, but with no error alert either) rather than transitioning to `'error'`. **Next step:** confirm on the first real Monday after a weekly `distill-insights` run has populated some promoted/contested insights and ElevenLabs quota has refreshed — listen for two distinct alternating voices, confirm no mid-run 429, and confirm the run completes within the background-execution window. **Update 2026-08-20:** added a pre-flight `checkQuota()` guard (`_shared/tts.ts`, deployed) that both daily and weekly modes call before spending any ElevenLabs credits — skips cleanly with a `pipeline_runs`/alert message instead of burning partial credits into a broken episode if quota is too low; fails open (proceeds) if the key can't read quota, so it never blocks a legitimate run on an unverifiable check. Both real blockers cleared today: the ElevenLabs key gained `user_read` permission and the monthly billing period reset (225/121,179 characters used, next reset 2026-09-20 — plenty for a ~15-20 min episode). Only remaining gap is the knowledge layer still having zero `active`/`contested` insights as of today (15 `candidate` insights exist from 2026-08-19, awaiting the weekly promotion run) — expected to resolve before Monday's cron fires. A scheduled cloud check-in (routine `trig_012VbUyofuAui5SxsxDe4pxu`, one-time run at 2026-08-24T14:00Z / 10:00am America/Detroit, 45 min after the `podcast-weekly-deep-dive` cron fires) will verify `pipeline_runs`/`episodes`/`insights` directly against production and report PASS/PARTIAL/FAIL — that result is what actually closes out this line. **Closed out 2026-08-24 (PASS):** the weekly `distill-insights` run fired 13:00 UTC and promoted candidates into 64 `active` insights; `podcast-weekly-deep-dive` fired 13:15 UTC and completed `success` in ~90s, producing episode `d74a4f87-0568-41f5-8f94-8fb8aa9adfdb` — 57 dialogue turns (balanced A=29 / B=28), `status='ready'`, `duration_seconds=899` (~15 min), audio reachable (HTTP 200, `audio/mpeg`, 14.2 MB). No `no_content` skip, no ElevenLabs 429, quota guard passed. Only manual step remaining is EJ's by-ear confirmation that the Antoni/Rachel voice pairing sounds right (env-var swap if not — no code change).
- ✅ **Delivery:** `episodes` table + `podcast-feed` Edge Function serving a token-gated private RSS feed URL (deployed with `--no-verify-jwt` since real podcast apps can't send a Supabase auth header), so episodes appear in any podcast app automatically. Serves all `episodes.kind` values by design (no `kind` filter in the query) — weekly episodes will appear in the same feed automatically once the weekly path produces its first `'ready'` row, no delivery-side change needed.
- ✅ `pg_cron` triggers the daily brief after its source summaries complete; a companion watchdog exemption (`pg_cron_watchdog_exclude_podcast.sql`) keeps the pipeline's existing global 5-minute stale-run alert from false-positiving on this job's longer TTS-synthesis runtime.

### Phase 3 — Discussion sessions (~3–4 weeks)

**Prep half (3a–3c) ✅ COMPLETE (2026-08-24), backend live-verified.** Shipped as its own spec/plan (`docs/superpowers/specs/2026-08-24-meeting-pack-prep-design.md`, `docs/superpowers/plans/2026-08-24-meeting-pack-prep.md`), deliberately split from the live-session half so the approved-pack format exists before the companion is designed against it. Read-only against the knowledge layer (pack assembly only SELECTs insights/decisions/hypotheses/open_questions/articles — no code path can mutate the layer; verified in prod: knowledge-layer row counts unchanged across a real assembly). Smoke test produced a 16-card pack (insights + articles) with agenda-aware relevance rationales.

**3a. Meeting setup.** ✅ `meetings` table (agenda, prospective result, decision_questions[], status) + dashboard "Meetings" view with a creation form.

**3b. Meeting Pack assembly (Claude agent).** ✅ `assemble-pack` edge function: hands Claude a compact digest of the whole knowledge layer + recent top articles, Claude selects relevant items by id with a `why_relevant` rationale (favoring contested/contradicting pairs), hydrated into `context_cards` snapshots. Background task + `pipeline_runs` logging + `sendAlert`, same conventions as the other edge functions. Whole-layer digest works while the layer is small; a documented cap is the trigger to add retrieval later.

**3c. EJ review.** ✅ Pack review UI: cards grouped by type with include/exclude toggles, inline edit, free-text manual additions, re-assemble (preserves manual/edited cards), and approve. Human-in-the-loop control point; terminal state `status='approved'`.

**Capture half (3d–3e), text-first. ✅ COMPLETE (2026-08-24, backend live-verified).** Split into a session spec (the companion + transcript) and a write-back spec, so the write-back extraction was designed against a real transcript. Both shipped. **This closes the core Phase 3 flywheel end-to-end:** a pack (Prep) → a companion session → write-back → and the next pack assembly reads what write-back wrote. Remaining follow-ons (not blocking the loop): update-existing-rows write-back (revisit/support/refute/answer) and the Realtime voice swap of the session.

**3d. Companion session.** ✅ (text stand-in) Shipped as `docs/superpowers/specs/2026-08-24-companion-session-design.md` / `docs/superpowers/plans/2026-08-24-companion-session.md`. From an approved pack, a resumable text chat with a skeptical "Challenger" companion (`session-chat` edge function): system prompt = persona + the approved pack's included cards + agenda + decision questions; opens with a provocation, presses the decision questions, argues the pack's contradictions rather than agreeing. Transcript persists in a new `session_messages` table; `meetings.status` gains `in_session`/`complete`. Read-only against the knowledge layer (reads context_cards snapshots, never insights/decisions/etc; verified in prod). The **Realtime voice swap remains the eventual 3d** — it reuses this same input contract (approved pack) and output contract (transcript); only the modality changes.

**3e. Write-back (the flywheel).** ✅ Shipped as `docs/superpowers/specs/2026-08-24-writeback-design.md` / `docs/superpowers/plans/2026-08-24-writeback.md`. From a completed meeting, an explicit "Extract" has Claude read the `session_messages` transcript and propose new `decisions`/`hypotheses`/`open_questions` + a summary into a `writeback_proposals` staging table; EJ reviews (include/exclude/edit/domains) and commits the approved set — inserting rows into the knowledge layer with `meeting_id` provenance and writing `meetings.summary`. Create-only for now (no updating existing rows — the deferred follow-on). This is the first and only meeting-flow feature that writes the knowledge layer, and that write is isolated to the explicit `commit` step behind the propose→approve→commit gate (verified in prod: extraction touches no knowledge-layer table; commit only INSERTs). `hypotheses`/`open_questions` gained a nullable `meeting_id` for provenance.


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
