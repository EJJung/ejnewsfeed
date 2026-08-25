# Companion Session — Design

*Drafted 2026-08-24. First sub-project of Phase 3's **Capture half**, following the Prep half (`docs/superpowers/specs/2026-08-24-meeting-pack-prep-design.md`), which is live in production. A resumable text chat session with a "Challenger" companion over the approved pack, capturing a transcript. Transcript write-back (extraction → approval → knowledge-layer commit) is the deliberately separate follow-on spec.*

---

## 1. What this adds

From a `meetings` row whose pack EJ has approved, a **live text session** with a skeptical companion that works the agenda, presses the decision questions, and surfaces the pack's contradictions rather than agreeing by default. The conversation persists turn-by-turn (resumable across visits) and ends with an explicit "End session" that leaves a stored transcript on a `complete` meeting.

This spec's terminal state is *"a `complete` meeting with a stored transcript."* It stops there on purpose: that transcript is the input contract for the next spec (write-back), and that contract should exist — as real data — before write-back extraction is designed against it.

**Core safety property (same as Prep):** this spec **does not touch the knowledge layer at all.** The session reads the *pack* (`context_cards`, which are self-contained snapshots) and the meeting — never `insights`/`decisions`/`hypotheses`/`open_questions`. Its only writes are to `meetings` (status) and the new `session_messages` table. No code path here can read or mutate the knowledge layer. All knowledge-layer writes are the follow-on write-back spec's job, behind its own approval gate.

**Builds on, does not change:** the Prep half's `meetings`/`context_cards` schema (this spec extends the `meetings.status` CHECK — anticipated by Prep — and reads `context_cards`), the existing dashboard auth (private single-user), and the repo's edge-function conventions. The companion chat is a **real** backend, replacing the placeholder pattern of the mock `dashboard/src/components/ChatPanel.jsx` (which is `setTimeout` fake responses, unused by this feature).

---

## 2. Flow

```
  meeting.status = 'approved'  (from the Prep half)
                    │  dashboard "Start session" → /meetings/:id/session
                    ▼
  session-chat [start]  → status flips approved → in_session
     builds system prompt (Challenger persona + approved included pack cards
       + agenda + prospective_result + decision_questions)
     generates the companion's OPENING turn (frames the highest-tension decision)
     INSERT session_messages (role='assistant', seq=0)
                    ▼
  EJ types a turn ──▶ session-chat [message]
     INSERT user message → load history + system prompt → Claude (sync, non-stream)
     → INSERT assistant reply → return { reply }
                    │  (repeat; resumable — reopening an in_session meeting reloads the thread)
                    ▼
  EJ clicks "End session" → status = 'complete'
                    ▼
  complete meeting: transcript shown read-only   ◄── terminal state for this spec
     (the follow-on write-back spec reads session_messages from here)
```

**Function structure:** one new edge function, `session-chat`. Unlike `assemble-pack` (background task), this is **synchronous** request/response — a chat turn must return its reply — mirroring `generate-analysis`'s existing synchronous Claude-call pattern. It takes a JSON body, calls Claude once (`AbortSignal.timeout`), and returns the reply. No `pipeline_runs` background machinery (it's a short foreground request); failures optionally alert via `sendAlert`.

---

## 3. Data model

One new table; one CHECK change on an existing table. No other schema changes.

### `session_messages` (new)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `meeting_id` | uuid not null | FK → `meetings(id)` on delete cascade |
| `role` | text not null | CHECK IN (`user`, `assistant`) |
| `content` | text not null | |
| `seq` | int not null | monotonic turn order within the meeting (0 = companion's opening turn) |
| `created_at` | timestamptz not null default now() | |

This table **is** the transcript the follow-on write-back spec consumes (ordered by `seq`). Index on `session_messages(meeting_id, seq)`. RLS mirrors the knowledge-layer/Prep pattern: `service_role` full access; `authenticated` full access (single private user).

### `meetings.status` CHECK (extended)

The Prep half's CHECK is `('draft','assembling','pack_ready','approved','error')` and explicitly reserved `in_session`/`complete` for this spec. This spec drops and recreates that CHECK to add them:

`('draft','assembling','pack_ready','approved','error','in_session','complete')`

Lifecycle additions: `approved → in_session` (first session-chat call), `in_session → complete` (End session). `meetings.summary` remains reserved and untouched (the write-back spec fills it).

---

## 4. `session-chat` edge function

Synchronous `POST /functions/v1/session-chat`.

**Request body — two modes:**
- `{ meeting_id, start: true }` — begin the session: flip `approved → in_session`, generate and store the companion's opening turn (seq 0), return it as `{ reply }`. Idempotency: if the meeting is already `in_session` with existing messages, `start` returns the existing opening turn rather than generating a second one.
- `{ meeting_id, message }` — a normal turn: insert the user message, get the companion's reply, return `{ reply }`.

**Guards:** `meeting_id` required (400 if missing). The meeting must be `approved` (for `start`) or `in_session` (for a `message`); any other status → 400 (e.g. can't chat a `complete` or `draft` meeting).

**Per-turn processing:**
1. Load the meeting (`id, status, agenda, prospective_result, decision_questions`). Validate status per mode.
2. Load the approved pack: `context_cards` where `meeting_id = … AND included = true`, ordered by `card_type`, `position`.
3. Build the system prompt: the Challenger persona (see §5) + agenda + prospective_result + decision_questions + the included cards rendered by group (headline / body / why_relevant).
4. Load prior `session_messages` (ordered by `seq`) as the Claude `messages` history.
5. For a `message` turn: insert the user message (`role='user'`, next `seq`), then append it to the history. For a `start` turn with no prior messages: history is empty and the user-role seed is a single synthetic "Begin the session" instruction so Claude produces the opener.
6. Call Claude: `claude-sonnet-4-6`, `system` = the system prompt, `messages` = history, `AbortSignal.timeout(120_000)`, non-streaming. Throw on non-ok and on `stop_reason === 'max_tokens'`.
7. Insert the assistant reply (`role='assistant'`, next `seq`). On a `start` call, also flip `status` to `in_session`.
8. Return `{ reply }`.

**Read-only property:** the function reads only `meetings` and `context_cards`; writes only `meetings` (status) and `session_messages`. It never references a knowledge-layer table.

---

## 5. Companion behavior (system prompt)

A **Challenger**: a sharp, skeptical thinking partner whose job is to stress-test EJ's reasoning toward a real decision — not to validate. The system prompt (assembled per turn) directs it to:
- Work toward the meeting's `prospective_result`.
- Press hard on each `decision_question`.
- When the pack's cards contain contradicting evidence, surface that tension and argue the uncomfortable side rather than agreeing by default.
- Be concise and direct; challenge weak reasoning; avoid agreeable filler.

The included pack cards are rendered into the prompt grouped by type with each card's `headline`, `body`, and `why_relevant`, so the companion argues from EJ's actual knowledge base. The **opening turn** frames the single highest-tension decision from the pack, so EJ arrives to a provocation rather than a blank input.

(Exact prompt copy is finalized in the plan; the intent above is binding.)

---

## 6. Dashboard UX

- **Start.** On `MeetingPack` (Prep), when `status='approved'`, a "Start session" button appears → navigates to a new route `/meetings/:id/session` and calls `session-chat` with `{ start: true }`.
- **Session view** (`MeetingSession.jsx`, a real chat UI): agenda / prospective result / decision questions collapsed at the top for reference; a message list (user vs. companion); an input box that calls `session-chat` per turn with a "thinking…" indicator during the round-trip; an "End session" button → sets `status='complete'` and returns to the meeting detail.
- **Resume.** Opening a meeting that is `in_session` (from the Meetings list or detail) routes straight to the session view with the full prior thread loaded from `session_messages` (ordered by `seq`).
- **Complete.** A `complete` meeting shows the transcript **read-only** (no input), with a placeholder note that write-back arrives in the next spec. One session per meeting for now (no restart from `complete`).
- **Sidebar:** unchanged; sessions live under the existing Meetings section.

---

## 7. Error handling

- `session-chat` sets `AbortSignal.timeout` on the Claude call; on failure returns a 500 with the error message. The UI shows an inline "couldn't reach the companion — retry" affordance and keeps the user's unsent text so they can resend. The meeting **stays `in_session`** — a failed turn never advances or strands state.
- If the Claude call fails *after* the user message was inserted but before an assistant reply, the dangling user message is harmless (it's just history); the retry produces the reply. No partial-assistant rows are ever written.
- Invalid/missing `meeting_id`, or a meeting whose status doesn't match the requested mode → 400.
- No `pipeline_runs` machinery (short synchronous request). Failures MAY call `sendAlert` for visibility; this is best-effort and must not block the response.

---

## 8. Testing

- **Edge function**: unit-test the pure prompt-assembly logic (rendering included cards + agenda + decision questions into the system prompt string; ordering by group; excluding `included=false` cards) with `deno test`, mirroring the Prep half's `pack_logic` tests. The DB/Claude I/O path is verified by live invoke.
- **Live end-to-end**: from a real approved meeting, start a session (confirm an opening turn appears and status flips to `in_session`), exchange a few turns (confirm the companion pushes back and cites pack content), reload mid-session (confirm resume), End session (confirm `complete` + read-only transcript). Confirm the read-only property: knowledge-layer row counts unchanged across a full session.
- **Dashboard**: manual drive-through (no test harness in this repo), plus `npm run build`.

---

## 9. Non-goals

1. **Write-back (the flywheel) → next spec.** No extraction of decisions/hypotheses/open_questions from the transcript, no knowledge-layer writes, no `meetings.summary` fill. This spec ends at a `complete` meeting with a stored transcript. This is the §1 safety property: the session cannot touch the knowledge layer.
2. **Voice / Realtime → Phase 3d proper, later.** Text only. This text session is the deliberate stand-in whose input contract (approved pack) and output contract (transcript) the eventual Realtime swap reuses.
3. **Streaming responses.** Request/response per turn (repo norm, matches `generate-analysis`). Streaming is later polish.
4. **Multiple sessions per meeting; message edit/delete; mid-session pack editing.** One session per meeting; the pack is fixed at approval.
5. **Multi-user / sharing.** Private single-user; reuses existing dashboard auth. No ownership column on `session_messages`.

---

## 10. Success criteria

- From an approved pack, EJ can hold a real text conversation with a companion that pushes back — pressing the decision questions and surfacing the pack's contradictions rather than agreeing.
- The conversation persists and resumes across visits; ending it leaves a `complete` meeting with an ordered, stored transcript.
- No knowledge-layer row is read or mutated by anything in this spec.
- The stored `session_messages` transcript is a clean, ordered input the follow-on write-back spec can consume.
