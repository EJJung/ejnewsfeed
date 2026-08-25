# Meeting Pack — Prep (setup · assembly · review) — Design

*Drafted 2026-08-24. First sub-project of Phase 3 ("Discussion sessions") in `knowledge-center-plan.md`. Builds the meeting-prep half of Phase 3 — meeting setup, Claude pack assembly, and pack review — on top of the existing knowledge layer. The companion chat session and transcript write-back are a deliberately separate follow-on spec (see §8).*

---

## 1. What this adds

A dashboard flow for preparing a **Meeting Pack**: EJ creates a meeting (agenda, prospective result, critical decision questions he authors), a Claude edge function assembles a set of **context cards** from the knowledge layer relevant to that agenda, and EJ reviews the cards — include/exclude/edit, plus free-text additions — ending in an **approved pack**.

This spec's terminal state is *"an approved pack exists."* It stops there on purpose: the approved pack is the input contract for the next spec (the companion session), and that contract should exist before the session is designed against it.

**Core safety property:** this spec is **read-only against the knowledge layer.** `assemble-pack` runs only `SELECT`s against `insights`, `decisions`, `hypotheses`, `open_questions` — it never `INSERT`s or `UPDATE`s them. No code path in this spec can create or mutate a knowledge-layer row. The worst a bad pack can do is show an irrelevant card, which EJ excludes. All write-back (proposing new decisions/hypotheses/questions from a session, behind an approval gate) lives in the follow-on spec.

**Builds on, does not change:** the knowledge-layer schema from Phase 1 (`insights`, `insight_sources`, `decisions`, `hypotheses`, `open_questions`, `articles` — read only), the existing dashboard auth (private single-user), and the repo's edge-function conventions (`pipeline_runs` logging, `sendAlert`, `AbortSignal.timeout`, background-task pattern). The `decisions` table already carries a `meeting_id` column, added in Phase 1 in anticipation of this feature.

---

## 2. Flow

```
  EJ authors meeting (agenda · prospective_result · decision_questions[])
                    │  dashboard "New meeting" form → INSERT meetings (status='draft')
                    ▼
  EJ clicks "Assemble pack"
                    │  status='assembling', invoke assemble-pack edge fn (background)
                    ▼
        assemble-pack [Claude]
          reads compact digest of the whole knowledge layer (active/contested
            insights, standing/revisited decisions, open/supported hypotheses,
            open questions) + recent high-impact articles (top-N across all domains)
          Claude selects relevant items BY ID + writes a why_relevant line + card_type
          hydrate selected ids from DB → INSERT context_cards (snapshots)
                    │  status='pack_ready' (or error state on failure)
                    ▼
  EJ reviews pack (meeting detail screen)
          include/exclude toggle · inline edit headline/body · add manual cards
          optional "Re-assemble" (regenerates sourced cards, preserves manual/edited)
                    │
                    ▼
  EJ clicks "Approve pack" → status='approved'   ◄── terminal state for this spec
```

**Function structure:** one new edge function, `assemble-pack`, following the `generate-podcast`/`distill-insights` shape — parses a JSON body (`{ meeting_id }`), logs a `pipeline_runs` row (`job_name='assemble-pack'`), does its work in a background task (`EdgeRuntime.waitUntil`) so a slow Claude call can't HTTP-timeout the caller, and alerts via `sendAlert` on fatal error. The dashboard polls `meetings.status` rather than holding a request open.

---

## 3. Data model

Two new tables. No changes to existing tables.

### `meetings`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `title` | text not null | |
| `agenda` | text not null | EJ-authored |
| `prospective_result` | text | the outcome EJ wants from the meeting |
| `decision_questions` | text[] not null default `'{}'` | the critical questions EJ defines |
| `status` | text not null | CHECK IN (`draft`, `assembling`, `pack_ready`, `approved`, `error`); follow-on spec adds `in_session`, `complete` |
| `error_message` | text | populated when `status='error'`, surfaced in the UI |
| `summary` | text | **reserved, unused this spec** — the follow-on write-back fills it |
| `created_at` | timestamptz default now() | |
| `updated_at` | timestamptz default now() | |

### `context_cards`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `meeting_id` | uuid not null | FK → `meetings(id)` on delete cascade |
| `card_type` | text not null | CHECK IN (`insight`, `decision`, `hypothesis`, `open_question`, `article`, `manual`) |
| `ref_table` | text | source table name for sourced cards; null for `manual` |
| `ref_id` | uuid | source row id; null for `manual` |
| `headline` | text not null | short card title |
| `body` | text not null | card content shown in review |
| `why_relevant` | text | Claude's one-line rationale; null for `manual` |
| `included` | boolean not null default true | the include/exclude toggle |
| `edited` | boolean not null default false | set true when EJ edits a sourced card's headline/body (protects it from Re-assemble) |
| `position` | int not null default 0 | display ordering within its group |
| `created_at` | timestamptz default now() | |

**Cards are snapshots, not live joins.** `headline`/`body` are copied in at assembly time from the source row, so the pack is stable even if the underlying insight later changes, and manual/edited cards coexist naturally with sourced ones. `ref_table`/`ref_id` are kept only for provenance/back-reference, not for re-reading content at display time.

**RLS:** both tables follow the existing knowledge-layer pattern — `service_role` full access (edge function), and the same authenticated-read policy the dashboard already uses for `insights` etc. (single private user; no per-user ownership column — see §8 non-goals).

---

## 4. `assemble-pack` — selection approach

**Chosen: Approach A — Claude-driven whole-layer selection.** The knowledge layer is small (~64 active insights + a handful of decisions/hypotheses/questions as of drafting), which makes handing Claude the *whole* digest viable and better than pre-filtering.

**Digest built by the function (all read-only SELECTs):**
- `insights` where `status IN ('active','contested')` → `{id, text, status, domains}`
- `decisions` where `status IN ('standing','revisited')` → `{id, text, context, domains, decided_at, status}`
- `hypotheses` where `status IN ('open','supported')` → `{id, statement, domains, status}`
- `open_questions` where `status='open'` → `{id, question, why_it_matters, domains}`
- recent high-impact `articles` (trailing ~14 days, top-N by impact across all domains — `meetings` has no domains field; the agenda is free text, and Claude filters these to the agenda during selection) → `{id, title, snippet}` — the "fresh source material / color" the plan calls for

For `contested` insights, the function also pulls their `insight_sources` supporting/contradicting article titles so Claude can present a genuine contradiction, mirroring how the weekly-podcast dialogue assembly surfaces contested pairs.

**Claude call:** one message. Input = the meeting's `agenda` + `prospective_result` + `decision_questions`, plus the digest. Instruction = select the items most relevant to *this agenda and these decision questions*, favoring contradictions and cross-domain links; for each selected item return `{ref_table, ref_id, card_type, why_relevant}`. Output = strict JSON (same "return only JSON, no fences" convention as `distill-insights`/weekly dialogue), model `claude-sonnet-4-6`, `AbortSignal.timeout`.

**Hydration + validation:** the function looks up each returned `ref_id` in its `ref_table`, and for valid rows copies `headline`/`body` from the row into a `context_cards` insert. Invalid/nonexistent ids are skipped (logged, not fatal). A pack with zero sourced cards is a **valid** result (empty/irrelevant layer) — not an error; EJ can still add manual cards and approve.

**Scale guardrail (written into the plan, not built now):** the digest SELECTs are capped per status/domain (e.g. top-N by recency). The spec records that when the knowledge layer outgrows what fits comfortably in one prompt, that is the trigger to revisit with a retrieval-first approach (pre-filter in SQL, then Claude ranks). No embedding/retrieval infra is built in this spec — YAGNI until the layer is actually large (§8).

---

## 5. Dashboard UX

A new **"Meetings"** entry in the sidebar, with two screens.

**Meetings list + creation.**
- List of meetings: title, status badge (`draft` / `assembling…` / `pack ready` / `approved` / `error`), date.
- "New meeting" form: title, agenda (textarea), prospective result (textarea), decision questions (repeatable add-a-line list, EJ authors each). Save → `draft` row.
- From a `draft` (or `error`): "Assemble pack" button → sets `assembling`, invokes `assemble-pack`, UI polls status until `pack_ready`/`error`.

**Pack review (meeting detail).**
- Meeting's agenda / prospective result / decision questions pinned at top for context.
- Context cards grouped by type: **Insights, Contradictions, Decisions, Hypotheses, Open Questions, Articles**. "Contradictions" is a *display grouping* of contested `insight` cards and their pairs — not a separate `card_type`.
- Each card shows headline, body, and `why_relevant`; an **include/exclude** toggle (excluded → greyed, `included=false`); inline **edit** on headline/body (sets `edited=true`).
- **"Add card"** control for free-text `manual` cards.
- **"Re-assemble"** action: regenerates the Claude-sourced cards but **preserves** `manual` cards and any card with `edited=true`. (Implementation: delete non-manual, non-edited cards for the meeting, re-run assembly.)
- **"Approve pack"** → `status='approved'`. Terminal state for this spec.

The dashboard has no real chat backend today — `ChatPanel.jsx` is a mock (`setTimeout` fake responses). No chat is added here; the companion is the follow-on spec's work.

---

## 6. Error handling

Following existing edge-function conventions:

- `assemble-pack` logs a `pipeline_runs` row (`job_name='assemble-pack'`), sets `AbortSignal.timeout` on the Claude call, and on fatal error sets `meetings.status='error'` + writes `error_message` (never leaves the row stuck at `assembling` — the "never strand the row" lesson from the podcast work) and calls `sendAlert`.
- Claude returns malformed/empty JSON, or selects nonexistent ids → skip the bad ids, build the pack from valid ones; only hard-fail (`status='error'`) if the Claude call itself fails or returns unparseable output. Zero *valid* cards from good JSON is a success with an empty pack, not an error.
- Empty/irrelevant knowledge layer → valid empty pack; the review screen shows an "AI found nothing relevant — add cards manually" empty state.
- The watchdog (`pg_cron_watchdog_stale_runs.sql`) keys on stale *running* `pipeline_runs`; `assemble-pack` is user-triggered and short, so no watchdog exemption is needed (unlike the long-running podcast job).

---

## 7. Testing

- **Edge function unit tests** (mocked Supabase + fetch, mirroring the TTS/dialogue local tests): digest-building SELECT shaping; JSON parsing of Claude output; id hydration/validation (malformed output, nonexistent ids, empty layer → empty pack); the "skip bad ids, keep valid" path.
- **Dashboard**: manual verification against production (this dashboard has no test harness) — create a meeting, assemble, review (toggle/edit/add/re-assemble), approve.
- **Live end-to-end**: one real meeting assembled against the actual knowledge layer, confirming cards return with sensible `why_relevant` and that contested insights surface as contradictions. Confirm the read-only property by checking no knowledge-layer row counts/rows changed across an assembly.

---

## 8. Non-goals

Every item here is either the follow-on spec's job (blocked on this spec's output) or infra for a scale/modality not yet present.

1. **Companion chat session → follow-on spec.** No chat UI wired to a real backend, no conversation history, no persona/system-prompt design, no streaming. Out because the chat's input contract *is* the approved pack, which should exist first.
2. **Transcript capture → follow-on spec.** No session transcript storage/structuring. `meetings.summary` is reserved (nullable) for that spec's write-back summary but is untouched here.
3. **Write-back (the flywheel) → follow-on spec.** No proposing/committing of new `decisions`/`hypotheses`/`open_questions` from a session. This spec only READS those tables. The propose→approve→commit gate is the follow-on's payload. Keeping writes out is the §1 safety property.
4. **Voice / Realtime → Phase 3d, separate spec.** No OpenAI Realtime, WebRTC, audio, or mic handling. Its cost profile, ephemeral-token auth, and failure modes deserve their own design pass.
5. **Retrieval / embedding infra → deferred.** No pgvector/embeddings/semantic search. Approach A relies on the layer being small enough for a whole-digest prompt; the cap in §4 is the trigger to revisit.
6. **Multi-user / sharing → out.** Private single-user system; reuses existing dashboard auth. No `user_id`/ownership model on the new tables.

---

## 9. Success criteria

- EJ can create a meeting with an agenda + decision questions and generate a pack of context cards drawn from his actual knowledge layer, each with a plausible relevance rationale.
- Contested insights surface as visible contradictions in the pack, not one-sided claims.
- EJ can shape the pack (exclude noise, edit wording, add his own cards) and approve it, leaving a stable `approved` pack the follow-on session spec can consume.
- No knowledge-layer row is created or mutated by anything in this spec.
