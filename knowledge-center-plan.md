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

Claude remains the core intelligence for extraction, categorization, synthesis, research, Meeting Pack assembly, and post-meeting write-back (the existing pipeline already runs on it). OpenAI is used only where it is uniquely strong: **TTS** for podcast audio and the **Realtime API** for live voice discussion sessions. This keeps the system to two AI vendors with clear responsibilities.

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

### Phase 0 — Stabilize the pipeline (this week)

The Aug 15 backlog fixes are committed but not deployed. Nothing new gets built on an unhealthy pipeline.

1. `supabase functions deploy process-emails fetch-emails` from repo root
2. Run `supabase/triage_stale_backlog.sql` in the SQL Editor
3. Re-copy the launchd plist and `launchctl unload/load` (loaded copy is stale — audits fire 8:12 AM instead of 11 AM)
4. Success: daily audits show stuck backlog = 0, pending < ~30, for one full week

### Phase 1 — Knowledge layer + multi-source ingestion (~2–3 weeks)

**1a. Generalize ingestion.** Extend `articles` (or introduce a `content_items` view of it) with `content_type` ('newsletter', 'web_article', 'youtube', 'podcast'), `transcript`, `duration_seconds`, `media_url`. Add three adapters, each normalizing into the same shape the existing Claude extraction step already consumes:

- **RSS/web articles** — feed list in `sources`, fetched on schedule
- **YouTube** — channel/playlist subscriptions; transcripts via captions API (fall back to Whisper on audio when captions are missing)
- **Podcasts** — RSS subscriptions; audio → Whisper transcription (transcribe on save/flag rather than every episode, to control cost)

**1b. Knowledge layer schema.** New tables, all domain-tagged and source-linked:

- `insights` — a claim or finding: text, domain(s), stance/confidence, status (active / superseded / contested), links to supporting and contradicting content items
- `decisions` — decision text, context, date, the meeting or moment it came from, status (standing / revisited / reversed)
- `hypotheses` — statement, current evidence for/against (links to insights), status (open / supported / refuted)
- `open_questions` — question, why it matters, status (open / answered → link to resolving insight)

Design rule for the professional-reasoning system: no ejnewsfeed-specific assumptions in these tables — generic domain taxonomy, generic source references — so skills can query them directly later.

**1c. Distillation jobs.**

- Daily: after summaries, Claude extracts candidate insights from the day's items (cheap, incremental)
- Weekly per domain: Claude deep-research synthesis — merges candidate insights, detects contradictions with existing insights, updates statuses, produces a weekly trend report (stored; becomes podcast + Meeting Pack input)

**1d. Dashboard: Knowledge view.** Browse insights by domain; filters for contested items and open questions; each insight expands to its sources. (This replaces "scroll the feed" as the primary way EJ engages.)

### Phase 2 — Podcast (~1–2 weeks)

- **Daily brief (~5 min, single voice):** Claude turns daily summaries into a spoken-word script (not read-aloud prose — written for the ear) → OpenAI TTS → mp3 in Supabase Storage
- **Weekly deep dive (~15–20 min, two hosts):** Claude writes a dialogue from the weekly synthesis — trends, contradictions, "what changed this week," open questions worth EJ's attention → two-voice TTS, stitched
- **Delivery:** `episodes` table + an Edge Function serving a private RSS feed URL, so episodes appear in any podcast app automatically
- pg_cron triggers both after their source summaries complete

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
