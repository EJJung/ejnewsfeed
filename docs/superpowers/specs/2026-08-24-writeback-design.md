# Write-back (the flywheel) — Design

*Drafted 2026-08-24. Final sub-project of Phase 3's Capture half, following the companion session (`docs/superpowers/specs/2026-08-24-companion-session-design.md`), which is live. Turns a completed session's transcript into new knowledge-layer entries — decisions, hypotheses, open questions, and a meeting summary — behind an explicit propose→approve→commit gate. This is the step that closes the flywheel: pack N+1 reads what session N wrote.*

---

## 1. What this adds

From a `complete` meeting, an explicit **"Extract decisions & questions"** action has Claude read the `session_messages` transcript and propose new knowledge items. EJ reviews them (include/exclude/edit, same idiom as pack review), then **commits** the approved set — inserting new rows into `decisions`, `hypotheses`, `open_questions` and writing `meetings.summary`. The next pack assembly reads all of it.

**This is the first and only feature in the meeting flow that writes the knowledge layer.** Every prior Phase-3 spec was read-only or staging-only against it. That write is deliberately isolated: extraction writes only a staging table; the knowledge-layer INSERTs happen in a single, explicitly-triggered `commit` step, only for items EJ approved.

**Scope this spec (decided during brainstorming):**
- **Create-only.** Extract and insert NEW decisions/hypotheses/open_questions + a summary. No updating of existing rows (no flipping a prior decision to `revisited`, a hypothesis to `supported/refuted`, a question to `answered`). Existing-row updates are a deliberate follow-on once extraction is trusted.
- **Explicit, re-runnable trigger.** A button on the completed meeting, not automatic on session end.
- **Full provenance.** Every committed item carries the `meeting_id` it came from.

**Builds on, does not change behavior of:** the knowledge-layer schema (adds a nullable `meeting_id` to `hypotheses`/`open_questions`; `decisions` already has one — no behavior change to the daily/weekly pipeline), `session_messages` (read only), `meetings.summary` (reserved since Prep, now filled), and the repo's edge-function conventions.

---

## 2. Flow

```
  meeting.status = 'complete'  (from the companion session)
                    │  dashboard "Extract decisions & questions"
                    ▼
  writeback [mode='extract', Claude]
     reads session_messages transcript + agenda/decision questions
     Claude proposes: summary + new decisions / hypotheses / open questions
       (conservative: only what was actually decided/hypothesized/asked)
     deletes prior non-edited, non-committed proposals; inserts fresh ones
     → writeback_proposals rows (status='proposed')   [NO knowledge-layer write]
                    ▼
  EJ reviews (write-back review UI)
     edit the summary; per item: include/exclude, inline edit (text, detail, domains)
     optional Re-extract (regenerates; preserves edited proposals)
                    ▼
  EJ clicks "Commit to knowledge base"
                    │
                    ▼
  writeback [mode='commit', service role]   ◄── the ONLY knowledge-layer write
     for each included proposed item → INSERT decisions/hypotheses/open_questions
       (with meeting_id, domains, default status, decided_at=meeting date)
       set proposal.committed_ref_id + status='committed'
     summary proposal → meetings.summary
     included=false proposals → status='discarded'
                    ▼
  committed: the meeting shows what was written; pack assembly now reads it
```

**Function structure:** one new edge function `writeback` with `mode: 'extract' | 'commit'`, mirroring the `distill-insights` mode pattern. Both modes share `pipeline_runs` logging (`job_name='writeback'`), `sendAlert`, and the `AbortSignal.timeout` convention. Only `extract` calls Claude; only `commit` writes the knowledge layer.

---

## 3. Data model

### `writeback_proposals` (new staging table)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `meeting_id` | uuid not null | FK → `meetings(id)` on delete cascade |
| `kind` | text not null | CHECK IN (`decision`, `hypothesis`, `open_question`, `summary`) |
| `text` | text not null | decision text / hypothesis statement / question / summary body |
| `detail` | text | decision `context` or open-question `why_it_matters`; null for hypothesis/summary |
| `domains` | text[] not null default `'{}'` | for the three item kinds; empty for summary |
| `included` | boolean not null default true | include/exclude toggle |
| `edited` | boolean not null default false | protects EJ edits from re-extract |
| `status` | text not null default `'proposed'` | CHECK IN (`proposed`, `committed`, `discarded`) |
| `committed_ref_id` | uuid | id of the knowledge-layer row created at commit; null until committed / for summary |
| `created_at` | timestamptz not null default now() | |

Index on `writeback_proposals(meeting_id)`. RLS mirrors the meeting-pack pattern (`service_role` full; `authenticated` full).

### `hypotheses` / `open_questions` — add provenance

Add a nullable `meeting_id UUID` column to each, matching `decisions`' existing convention exactly (a plain `meeting_id UUID` with no FK constraint — that's how `decisions` declares it). Nullable, no default → existing rows and the daily/weekly `distill-insights` pipeline are unaffected. Write-back is the only writer that populates it.

No change to `decisions` (already has `meeting_id`), and no `meetings` schema change (`summary` already exists; `status` stays `complete` throughout — write-back adds no new meeting status).

---

## 4. `writeback` edge function

`POST /functions/v1/writeback`, body `{ meeting_id, mode }`.

### `mode: 'extract'`
- Guard: `meeting_id` required (400); meeting must be `complete` (400 otherwise); 404 if not found.
- Load the `session_messages` transcript (ordered by `seq`) + the meeting's agenda/decision_questions for context.
- Claude (`claude-sonnet-4-6`, `AbortSignal.timeout`): returns strict JSON — `{ summary, decisions:[{text,context,domains}], hypotheses:[{statement,domains}], open_questions:[{question,why_it_matters,domains}] }`. The prompt is conservative: extract only what EJ actually concluded/hypothesized/asked; a session that reached no real decisions returns empty arrays (a valid outcome, not an error).
- Delete prior `writeback_proposals` for the meeting where `status='proposed' AND edited=false` (re-runnable; preserves committed and edited rows).
- Insert the new set as `status='proposed'` rows (one `summary` row, plus one row per item; each item's `domains` populated; `decision`/`open_question` fill `detail`).
- Writes ONLY `writeback_proposals`. No knowledge-layer write in this mode.

### `mode: 'commit'`
- Guard: meeting must be `complete`.
- Load `writeback_proposals` for the meeting with `status='proposed'`.
- For each `included` item row, INSERT into its table:
  - `decision` → `decisions` (text, context=detail, domains, `decided_at` = the meeting's completion date, `meeting_id`, `status='standing'`)
  - `hypothesis` → `hypotheses` (statement=text, domains, `meeting_id`, `status='open'`)
  - `open_question` → `open_questions` (question=text, why_it_matters=detail, domains, `meeting_id`, `status='open'`)
  - then set that proposal's `committed_ref_id` + `status='committed'`.
- The `summary` proposal (if `included`) → write its `text` to `meetings.summary`; mark it `committed`.
- `included=false` proposals → `status='discarded'`.
- **Validation:** an item with empty `domains` cannot be committed (the knowledge tables require non-empty `domains`). Skip it, leave it `proposed`, and return the count of skipped items so the UI can prompt EJ to add domains and re-commit. Committing is idempotent per row via the `status='proposed'` filter (already-committed rows aren't re-inserted).
- This is the ONLY code path in the meeting flow that writes `decisions`/`hypotheses`/`open_questions`.

---

## 5. Dashboard UX

- **Entry.** On a `complete` meeting (the `MeetingPack` detail and/or the session's read-only view), an **"Extract decisions & questions"** button calls `writeback[extract]`, then routes to a write-back review at `/meetings/:id/writeback`. If proposals already exist, the button reads **"Review write-back."**
- **Review view** (`MeetingWriteback.jsx`):
  - The **summary** proposal at top as an editable textarea.
  - Proposed items grouped by kind — **Decisions / Hypotheses / Open Questions** — each showing its text, detail, and domains, with an **include/exclude** toggle and **inline edit** (text, detail, domains as a comma-separated field; editing sets `edited=true`).
  - **Re-extract** (regenerates proposals, preserving `edited` ones — warns like re-assemble).
  - **Commit to knowledge base** → calls `writeback[commit]`. On success shows a committed state (what was written); if any item was skipped for empty domains, surfaces that inline so EJ can fix + re-commit.
  - After commit, committed items render read-only with a note that they're now in the knowledge base; the meeting's `summary` is set.
- **Sidebar:** unchanged; write-back lives under the existing Meetings section.

---

## 6. Error handling

- `writeback` logs a `pipeline_runs` row (`job_name='writeback'`, metadata includes `mode`), sets `AbortSignal.timeout` on the Claude call (extract mode), and returns JSON 500 on fatal error with `sendAlert` (best-effort). No background-task machinery for `commit` (short DB work); `extract` may run synchronously with a spinner or as a background task — the plan picks one (extraction is a single Claude call, so synchronous with a spinner is acceptable, matching `generate-analysis`).
- Malformed/empty Claude JSON in extract → hard-fail (500) only if unparseable; well-formed-but-empty (no items) is a **valid** proposal set (just a summary, or nothing) — not an error.
- `commit` is safe to re-run: the `status='proposed'` filter means committed rows are never double-inserted. A partial commit failure (some rows inserted, then an error) leaves the succeeded rows `committed` and the rest `proposed` — re-commit finishes the remainder; no duplicates.
- Empty-`domains` items are skipped at commit (not silently dropped) and reported back.

---

## 7. Testing

- **Edge function**: unit-test the pure transform logic (parsing Claude's extraction JSON into proposal rows; mapping a proposal `kind` → its target table + column mapping; the empty-domains validation filter) with `deno test`, mirroring the earlier phases' pure-logic tests. DB/Claude I/O verified live.
- **Live end-to-end**: from a real `complete` meeting with a transcript, run extract (confirm sensible, conservative proposals + a summary), edit/exclude a couple, commit, and verify the exact approved rows appear in `decisions`/`hypotheses`/`open_questions` with the right `meeting_id`, that excluded items did NOT land, that `meetings.summary` is set, and that re-commit inserts nothing new. Confirm an empty-domains item is skipped and reported.
- **Dashboard**: manual drive-through + `npm run build`.

---

## 8. Non-goals

1. **Updating existing knowledge — the next follow-on.** No flipping a prior decision to `revisited`/`reversed`, a hypothesis to `supported`/`refuted`, or a question to `answered`; no linking new evidence to existing hypotheses. Create-only. This is the biggest deferred piece and needs reliable transcript-claim → existing-row matching.
2. **Voice / Realtime** — unrelated; the session that produces the transcript is text (its own spec).
3. **Auto-extraction on session end** — extraction is an explicit, opt-in button.
4. **`insight`/`insight_sources` writes** — write-back produces decisions/hypotheses/questions, not insights (insights come from the article pipeline). No `resolving_insight_id` linking here.
5. **Multi-user / sharing** — private single-user; reuses existing auth. `writeback_proposals` has no ownership column.

---

## 9. Success criteria

- From a completed session, EJ can extract a conservative set of proposed decisions/hypotheses/open-questions + a summary, review and shape them, and commit the approved set into the knowledge layer with correct `meeting_id` provenance.
- Excluded items never reach the knowledge layer; the knowledge-layer write happens only at the explicit commit step, only for approved items.
- A subsequent pack assembly (Prep half) surfaces a decision/hypothesis/question that this write-back created — the flywheel visibly closes.
- Re-running commit is safe (no duplicate rows); empty-domains items are skipped and reported, not silently dropped.
