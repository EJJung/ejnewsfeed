# Podcast — Weekly Deep Dive — Design

*Drafted 2026-08-20. Second sub-project of Phase 2 in `knowledge-center-plan.md`, following the daily brief (`docs/superpowers/specs/2026-08-20-podcast-daily-brief-design.md`), which is live in production. Two-host dialogue synthesized from the knowledge layer's weekly insight changes.*

---

## 1. What this adds

A weekly ~15–20 minute two-host audio dialogue, generated unattended every Monday from that week's insight-layer changes (promoted insights, contested pairs, reinforced insights, open questions) plus that week's top articles for concrete color. Delivered through the same private RSS feed EJ already has installed from the daily brief — no new feed URL to add.

**Scope boundary:** this spec covers weekly generation only. Dashboard episode player, episode retention/cleanup, and named host personas are explicitly out of scope — see §7.

**Builds on, does not change:** the `episodes` schema (already has `kind IN ('daily','weekly')`), the `podcast-feed` Edge Function (already queries all kinds), and the daily brief's error-handling/scheduling conventions. Where this spec extends shared code (`_shared/tts.ts`), that's called out explicitly.

---

## 2. Pipeline flow

```
  insights WHERE updated_at/first_seen_at in trailing 7 days
    (promoted, contested, merged-into, rejected — from Monday's weekly distill-insights run)
  + that week's top articles per domain (for concrete examples/color)
                    │
                    ▼
        generate-podcast [mode='weekly', Claude] — writes two-host dialogue as JSON turns
                    │
                    ▼
        per-turn ElevenLabs TTS (speaker's voice_id) ──→ concatenate MP3 buffers in order
                    │
                    ▼
        Supabase Storage (podcast-episodes bucket, same as daily)
                    │
                    ▼
        INSERT episodes row (kind='weekly', status='ready')
                    │
                    ▼
        podcast-feed [unchanged] — already queries all kinds, ordered by published_at
```

**Function structure:** `generate-podcast` gains a `mode: 'daily' | 'weekly'` request body param, mirroring the existing `distill-insights` mode pattern in this codebase. Shared across modes: CORS, `pipeline_runs` row, `sendAlert`, Storage upload, `episodes` insert/update, background-task (`EdgeRuntime.waitUntil`) pattern. Mode-specific: data gathering, script-generation prompt/output shape, and TTS turn-building — these genuinely differ (single script vs. dialogue turns) so branching happens at those three points, not by duplicating the whole function.

No schema changes. No changes to `podcast-feed`.

---

## 3. Data gathering (weekly-specific)

Window = trailing 7 days ending at run time: `week_start = now() - interval '7 days'` (Monday 13:15 UTC, 15 minutes after the 13:00 UTC weekly `distill-insights` run that just updated everything this window reads).

- **Promoted insights** — `status = 'active' AND updated_at >= week_start` (newly promoted from candidate this week). This is the "what's new" material.
- **Contested insights** — `status = 'contested' AND updated_at >= week_start`, joined to `insight_sources` for both `'supporting'` and `'contradicting'` relations. This is the "surface contradictions" material — the reason the plan doc wants two hosts instead of one narrator.
- **Reinforced insights** — `last_confirmed_at = this week's Monday` (received additional supporting evidence via a weekly merge, without being newly promoted). Framed briefly as "still holding" rather than "new."
- **Rejected candidates** — count only per domain (from that run's `pipeline_runs.metadata`), not full text. Used for a one-line "N things didn't hold up this week" framing, not full discussion — keeps the prompt focused on durable material rather than relitigating rejected noise.
- **Open questions** — `status = 'open'`, all of them (small table, no time filter; these persist until answered by a future insight).
- **Color articles** — for each domain, top 3 articles by `impact_score` from the trailing 7 days (title + snippet), same shape as the daily brief's per-category article pull (`docs/superpowers/specs/2026-08-20-podcast-daily-brief-design.md` §4 step 2). Gives the hosts something concrete to point to when discussing an insight, rather than debating abstractions.

**Skip condition:** if promoted + contested + reinforced + open-questions are all empty (a week with zero insight-layer activity — expected in the knowledge layer's first few weeks per §9), skip entirely: no episode, `pipeline_runs` success with `metadata: { skipped: 'no_content' }`, same pattern as the daily brief's no-`daily_summaries` skip.

---

## 4. Script generation — two-host dialogue

One Claude call, **structured output** (tool-call/JSON schema — not free text, unlike the daily brief's plain script):

```json
{
  "turns": [
    { "speaker": "A", "text": "..." },
    { "speaker": "B", "text": "..." }
  ]
}
```

Prompt instructs:

- **Two peer co-hosts**, generic labels `A`/`B` (not named personas — see §7). Both can introduce points, both can push back — genuine back-and-forth, not host-plus-expert.
- **Structure:** open with the week's headline trend → work through contested insights as real disagreement ("X says one thing, but Y contradicts it — what do you make of that?") → touch reinforced insights briefly → close on the open questions worth EJ's attention.
- **Length is content-driven, not target-driven** (same philosophy as the daily brief's §4): typical range 2200–3000 words across all turns (~15–20 min at 150 wpm). Do not pad a quiet insight-week; do not cut a heavy one.
- **Written for the ear** — same rules as the daily brief (short sentences, no visual-only references, spell out anything a listener can't see).
- **Turn size:** each turn is one short conversational beat, 1–4 sentences — not an alternating-essay dump. This is what makes per-turn TTS synthesis (§5) produce something that sounds like dialogue rather than two monologues stitched together.

Stored on `episodes.script` as the turns array serialized to text (kept for debugging/re-synthesis without a fresh Claude call, same rationale as the daily brief).

---

## 5. TTS synthesis — two voices

Extends `supabase/functions/_shared/tts.ts` rather than duplicating it:

- New export: `synthesizeDialogue(turns: {speaker: 'A'|'B', text: string}[], apiKey: string, voiceIds: {A: string, B: string}): Promise<Uint8Array>`. For each turn, one ElevenLabs call using that speaker's `voice_id`; resulting MP3 buffers concatenated in turn order. Same byte-concatenation tradeoff as the daily brief (its §9 risk note on chunk-boundary artifacts applies here too, now at every turn boundary rather than every ~4500-char chunk boundary).
- Existing `synthesizeSpeech` (single-voice, used by the daily brief) is untouched.
- `chunkScript`'s paragraph-based chunking is not used for turn-building — turns are already natural-sized conversational units, expected well under the 4500-char ElevenLabs limit given the "1–4 sentences" prompt instruction. Defensive fallback: if a single turn's text ever exceeds the limit, run it through the existing `chunkScript` and synthesize its pieces sequentially with that same speaker's voice before moving to the next turn.
- Two new secrets: `ELEVENLABS_VOICE_ID_A`, `ELEVENLABS_VOICE_ID_B` (`supabase secrets set`, same mechanism as existing keys). The daily brief's `ELEVENLABS_VOICE_ID` is left as its own separate config — no requirement that the daily narrator share a voice with either weekly host.

---

## 6. Delivery & error handling

**Delivery:** no changes to `podcast-feed`. It already queries `episodes WHERE status = 'ready' ORDER BY published_at DESC LIMIT 50` across all `kind` values, so weekly episodes appear automatically in the feed EJ already has installed, interleaved with daily episodes by `published_at`.

**Error handling:** identical pattern to the daily brief —
- `episodes` row inserted as `status = 'generating'` before synthesis starts.
- Any fatal error (Claude call fails, any TTS turn fails, Storage upload fails) → `episodes.status = 'error'` with `error_message`; `pipeline_runs` marked `error`; `sendAlert('generate-podcast', ...)`.
- Partial TTS failure (some turns succeed, one fails) is treated as fatal for the whole episode, not published truncated — a fresh `episodes` row next Monday means a failed week just has no episode rather than a broken one.

**Scheduling:** new entry in the existing `supabase/pg_cron_podcast.sql` (alongside the daily entry, not a new file):

| Job | Cron (UTC) | Note |
|---|---|---|
| `podcast-weekly-deep-dive` | `15 13 * * 1` | Mondays, 15 min after `distill-insights` weekly (`0 13 * * 1`) |

---

## 7. Explicitly out of scope (this spec)

- **Named host personas / distinct personality writing** — `A`/`B` generic labels for now; naming and personality differentiation is a cheap follow-on once the mechanics are proven live.
- **Dashboard episode player / episode list UI** — same call as the daily brief; RSS-feed-only delivery.
- **Episode retention/cleanup job** — same call as the daily brief; audio kept indefinitely.
- **Turn-batching optimization** (merging consecutive same-speaker turns before synthesis to reduce ElevenLabs call count) — considered and deferred; see §8 risk on call-count overhead. Revisit only if it proves to be a real cost/reliability problem in practice.
- **Per-domain weekly episodes** — one combined episode across all four domains, matching the daily brief's cross-category structure, not a per-domain split.

---

## 8. Risks & watch items

*Additive to the daily brief's §9, which still applies unchanged (MP3 concatenation artifacts, ElevenLabs cost, duration-estimate drift, feed token security model).*

- **Two-voice call-count overhead.** A 20-minute dialogue with short (1–4 sentence) turns means many more ElevenLabs calls per episode than the daily brief's ~4 chunks — plausibly 60–100+ turns. More latency, more surface area for one call to fail mid-run. Watch the actual per-episode call count and wall-clock time once live; if it's a real problem, the deferred turn-batching approach (§7) is the fix — don't pre-build it before confirming it's needed.
- **Dialogue quality drift.** Structured-turn generation risks stilted or repetitive back-and-forth ("great point!" filler, artificial disagreement for its own sake) — a known failure mode of LLM-generated dialogue in general. Listen to the first few real episodes before trusting this unattended; this is exactly why success criteria (§9) require confirming a *genuine* contested pair shows up, not just that turns alternate.
- **Insight-table sparsity early on.** The knowledge layer went live 2026-08-18/19 — the first few weekly runs may find little promoted/contested material to work with. That's a legitimate skip case (§3), not a bug; it should resolve naturally as the daily distillation job accumulates candidates over more weeks.

---

## 9. Success criteria

- A weekly episode (`kind = 'weekly'`, `status = 'ready'`) appears every Monday, unattended, for 2–3 weeks straight.
- In a real podcast app, the dialogue is recognizably two distinct voices/perspectives, not a single narrator reading alternating lines.
- At least one real episode surfaces a genuine contested-insight pair with both sides represented, and at least one open question — confirming the insights-table plumbing is actually feeding content, not just theoretically wired up.
- A week with little insight activity either produces a shorter episode or is correctly skipped (§3) — not padded filler.
