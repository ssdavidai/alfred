# RFC #842 — Steward Phase 6: conversational mutation channel

**Status:** Draft  
**Author:** Sir + Claude  
**Depends on:** #832 (Steward), shipped through Phase 5 on david.  
**Sequel to:** None — this is the natural next phase of #832 but is its own RFC because it introduces a new mutation pathway rather than extending an existing source.

## TL;DR

Today Steward gathers signals from Gmail, Sure, gcal, vault edits, Plane comments, and ctrl-api streams — every input *except* the conversations Sir has with Alfred itself. When Sir says to Alfred "no, the trkblint thing isn't a property issue, it's about the loan structure" or "I'm spending a lot of time on the Berlin office, that should be its own thing", that information goes into chat history and dies there.

This RFC proposes elevating **conversation with Alfred** to a first-class Steward signal source. Sir's natural-language corrections become structured mutation proposals (task state changes, matter context edits, parent-matter reassignments, *new matter creation*) that flow through Steward's existing audit / confidence / undo pipeline. No new auth model, no new dashboard tab, no new state machine — just a new entry in `signal_sources`.

This makes Sir's expectation real: he talks, the vault tracks his thinking.

## Diagnosis — what's broken today

Concrete failures Sir sees on david right now, all from the same missing capability:

1. **Misaligned matters fester.** Surveyor categorized 30 onboarding emails into a `household-cash-flow-multi-currency-finances` matter that's actually three different threads (utilities, business reimbursements, real-estate carry costs). Sir notices in conversation but never goes back to fix the matter manually. Tasks under it get evaluated against the wrong context.

2. **Matters with factual errors in their context drift unchecked.** Matter `boardy-pitch-collaboration` says Sir is actively pursuing the partnership; Sir mentioned two weeks ago in chat that Boardy went radio silent. The matter still reads as active, every task under it gets evaluated as `still_active`, the briefing surfaces it daily.

3. **Missing matters keep tasks orphan.** Sir has 5–8 tasks in `matter/inbox` about the Berlin office search. There's no `matter/berlin-office-search`. The tasks float, briefing batches them under "Inbox (8)" with no narrative coherence, and Steward can't reason about them as a coherent thread.

4. **Dormancy ≠ retirement.** Matter `kondorosi-ut-apartment-sale` had no signals for 3 weeks because Sir's waiting on a buyer. Steward's current evaluator is starting to flag tasks under it as `stale_archive_candidate`. Sir never told the system "park this, we're waiting" — he said it to me in chat.

5. **Sir won't fill out structured feedback forms.** Whatever per-task / per-matter "feedback" UI we ship, Sir won't use it. He talks. The system's job is to listen.

The pattern: every one of these is a correction Sir has already *made* in conversation. The vault just doesn't hear it.

## Architecture

### 1. Conversation events as a signal source

A new signal-source kind: `conversation:<channel>`. Channels Sir already talks to Alfred through:

- `conversation:openclaw-main` — the dashboard chat agent and its CLI / MCP surface.
- `conversation:omi` — OMI audio transcripts (already streamed to vault as `event/omi-*.md`).
- `conversation:slack` — DMs to the Alfred Slack bot.
- `conversation:meeting` — Vexa transcripts from meetings Sir attends (already in vault as `event/transcript-*.md` after Phase 4).

Each channel is wrapped as a stream Steward already knows how to read. No new transport layer — these are JSONL stream files just like Gmail or gcal in surveyor's eyes.

### 2. `extract_corrections` activity

Runs on every Steward tick (and reacts to webhook fan-out from new conversation events for sub-second latency on critical statements).

Input: rolling N-day conversation window (default 7 days, configurable per channel).  
Output: a list of `correction` records, each with shape:

```yaml
correction_id: corr-2026-05-06T08:30:12Z-x7f3
extracted_at: 2026-05-06T08:30:12Z
source_event: event/omi-2026-05-06T08-29-45Z-conversation.md  # the utterance
quote: "the trkblint thing isn't a property issue, it's about the loan structure"
classification: matter_context_edit                            # see taxonomy below
target:
  kind: matter
  ref: matter/trkblint-property-land-development.md
  confidence: 0.92                                             # how sure we are which target Sir meant
proposed_mutation:
  patch_path: matter/trkblint-property-land-development.md
  patch_op: rewrite_section
  section: context
  reasoning: |
    Re-frame this matter from "property/land development" to
    "loan structure for the trkblint property" per Sir's correction
    on 2026-05-06. The land aspect is incidental; the active work
    is the loan negotiation.
  confidence: 0.85                                             # how sure we are about the mutation itself
related_targets:                                               # cascade: tasks under this matter get re-surveyed
  - task/<...> (5 tasks)
```

Two confidence dimensions, deliberately separated:
- **target confidence** — "did I correctly identify what Sir was talking about?"
- **mutation confidence** — "given the target, is this the right change?"

Both must clear the 0.6 floor for `live`; both must clear 0.85 for `live_high_confidence_only`.

### 3. Correction taxonomy (8 classes)

Each class maps to a specific mutation kind. The LLM is constrained to one of these in its output.

| Class | Trigger pattern | Mutation |
|---|---|---|
| `task_resolution` | "we already handled X" / "X is done" | `task/X.state = done` (+ Plane close if `plane_issue_id`) |
| `task_dismissal` | "drop X, not pursuing it" / "ignore X" | `task/X.state = archived` |
| `task_reframing` | "X isn't really about Y, it's about Z" | `task/X.title` + `task/X.context` rewrite |
| `task_blocked_on` | "X is waiting on Y" / "park X until Y comes back" | `task/X.blocked_on = <ref|external>` + `task/X.state = snoozed` |
| `matter_context_edit` | "the M thing isn't about A, it's about B" | rewrite `matter/M.context` section, re-survey member tasks |
| `matter_state_change` | "park M for now" / "M is done" / "kill M" | `matter/M.state = paused | done | archived` |
| `matter_creation` | "the Berlin thing should be its own matter" | propose new `matter/<slug>.md`, ingest candidate tasks |
| `matter_membership` | "X belongs under M, not where it is" | `task/X.parent_matter = matter/M.md` |

Anything that doesn't fit falls back to `unclassified` and is dropped (with a debug log entry). False positives here are worse than missed signal.

### 4. Target resolution

The LLM proposes a target by quote/intent; an activity `resolve_correction_target` does retrieval over vault to disambiguate:

- **Direct reference** ("the trkblint thing") → fuzzy-match against matter/task names + aliases.
- **Topical reference** ("the Berlin office stuff") → vector retrieval over matter contexts + recent task titles.
- **Pronoun chain** ("that") → resolve against the conversation's recent topic stack (last N messages).

Each resolved target gets a confidence score. If retrieval returns multiple candidates within 0.05 of each other, the correction is `pending_disambiguation` — surfaced to Sir in the brief as "I think you meant X but it could be Y; which?". Cheap to wire, prevents the worst class of error (right correction applied to wrong record).

### 5. Apply through existing Steward pipeline

The corrections feed `apply_state_change` (extended slightly to handle matter mutations, currently task-only). Same audit / undo / `pending_confirmation` semantics as #832. Sir gets:

- An `event/correction-applied-<ts>.md` audit record per mutation, with the full `undo_recipe`.
- An inline "auto-edited by Alfred — Undo" badge on the dashboard task / matter page.
- A "Closed since last brief" / "Edited since last brief" section in tomorrow's briefing.

The conversation source enters Steward's calibration loop at confidence 1.0 for explicit statements ("park M") and lower for inferred statements (general chat). No special-cased path; same machinery.

### 6. Matter creation — two trigger paths

This is the genuinely new mutation type, since every other Steward action mutates existing records.

**Path A — explicit:** Sir says "this should be its own matter" / "we should be tracking N separately". Classification: `matter_creation`. The activity:
1. Generates a slug + initial context from the conversation excerpt.
2. Proposes the new matter as a draft (`state: draft` until Sir confirms or implicitly endorses by editing).
3. Identifies candidate tasks for ingestion via vector similarity over `matter/inbox` + orphans + Sir's recent activity.
4. Either auto-ingests (if the cluster is tight, cohesion >0.8) or presents the cluster for one-tap confirm.

**Path B — pattern detection (the case where Sir won't think to say it):** a periodic activity (`detect_matter_candidates`, daily) that:
1. Pulls embeddings from surveyor for all tasks in `matter/inbox` + matters with single-task orphans.
2. Runs HDBSCAN clustering. Clusters of ≥3 tasks with cohesion >0.6 become candidate matters.
3. Generates a proposed name + context for each cluster via LLM.
4. Surfaces the proposals in the daily brief as "I noticed N tasks about X — should this be its own matter?"
5. One-tap accept / reject from the brief or via conversation ("yes, do it").

Path B reuses surveyor's existing embedding pipeline. The clustering pass is roughly 200 LOC of activity code; the brief surface is a new section.

### 7. Conversation event ingestion

OMI and chat already write to vault as `event/*.md`. The deltas needed:

- **OpenClaw main agent**: dashboard / MCP / CLI conversations need to be persisted as `event/conversation-<channel>-<ts>.md` (today they live in openclaw's per-session SQLite and are not in vault). One activity per conversation transport, ~50 LOC each.
- **Slack**: the alfred Slack bot already logs to alfred-learn; route through the same vault-event emission.
- **Meetings**: Phase 4 already emits transcripts as vault events; reuse.

Each conversation event has frontmatter: `channel`, `participants`, `started_at`, `ended_at`, `topic_hint` (LLM-generated 1-line summary). The body is the transcript / message log.

### 8. False-positive guards

Conversation is noisy. Sir thinks out loud, asks Alfred to look things up, makes hypotheticals. A correction needs to be a *commitment*, not exploration. Three guards:

**Guard 1 — assertion-vs-question filter.** The extractor's prompt explicitly asks: "is this a statement of intent / fact / decision, or is Sir thinking out loud / asking a question / discussing a hypothetical?" Only the former category becomes a correction. Test set: hand-labeled 50 conversation excerpts pre-cutover.

**Guard 2 — re-state-and-confirm for high-impact mutations.** Anything that archives a matter or rewrites matter context with confidence < 0.85 lands as `pending_confirmation`. The next time Sir is in chat with Alfred, the agent surfaces the pending correction: "Earlier you said the trkblint thing is about the loan structure, not the property — should I update the matter?" Sir says yes/no and the correction fires or drops.

**Guard 3 — undo telemetry feeds calibration.** If Sir undoes a correction within 5 min of seeing it on the dashboard, that's a strong negative signal: the conversation channel's confidence drops by 0.1 and the prompt seeds itself with the false-positive example. Self-correcting loop on top of the existing calibration machinery.

### 9. Privacy / scope

Conversation transcripts are highly sensitive. Constraints:

- Conversation events stay strictly in tenant vault — never cross-tenant, never aggregated.
- The LLM extractor runs through the same OpenClaw gateway that Steward already uses (no new external API surface).
- Corrections are attributable — each `event/correction-applied-*.md` records the source utterance verbatim, so Sir can audit "why did Alfred think I wanted that?"
- A conversation can be marked `do_not_extract` via a magic phrase ("off the record") — the extractor skips that conversation entirely.

### 10. Cost & rate

Two new LLM call patterns:

- **Per-tick extract pass** — on each Steward tick (per-matter cadence, currently 5–60 min), one LLM call processes the new conversation events since last extract. ~1 call/min/tenant peak when Sir is actively talking.
- **Per-correction target resolution** — one cheap retrieval + one disambiguation LLM call per extracted correction. Bounded by extraction rate.
- **Daily clustering pass for matter proposals** — one LLM call per cluster found. Bounded to ~5 clusters/day in practice.

Honors the existing `rate_guard` budget (#832 §7): 6 evals/task/day, 50 evals/matter/day. New caps: 200 conversation extracts/day/tenant (catches a runaway loop where Alfred keeps re-extracting from its own utterances), 10 matter creations/day (hard cap, bypassable only by Sir's explicit instruction).

## Phasing

Each phase ships in shadow first, then live with `live_high_confidence_only`, then full `live` after the soak.

| Phase | Days | Deliverable |
|---|---:|---|
| 6.0 | 2 | Conversation event ingestion (openclaw-main, slack); OMI + meetings already done. Vault has every utterance. |
| 6.1 | 3 | `extract_corrections` activity — task-only mutation classes (`task_resolution`, `task_dismissal`, `task_reframing`, `task_blocked_on`, `matter_membership`). Shadow only. |
| 6.2 | 2 | Live cutover for task-only mutations (high-confidence-only, then live after 7-day soak). Calibration data flows into source confidence scoring. |
| 6.3 | 3 | Matter mutation classes (`matter_context_edit`, `matter_state_change`). Shadow → live with the same gating. |
| 6.4 | 4 | Matter creation — Path A (explicit). Includes the disambiguation surface in the brief / chat. |
| 6.5 | 5 | Matter creation — Path B (pattern detection via surveyor clustering). Daily proposal in briefing. |
| 6.6 | 2 | False-positive guards: assertion-filter prompt tuning, re-state-and-confirm flow, undo-telemetry calibration loop. |

**Total: ~21 days.** Each phase ships independently and is undoable; we don't have to commit to the whole sequence up front.

## Deployment plan — david first, same pattern as #832

- **alfred-learn:** new activities live in `packages/learn/src/activities/corrections.py`, registered in `worker.py`. Bind-mounted dev on david for fast iteration. Once stable, CI build + image push + tenant pull.
- **No SaaS dashboard work needed** for Phases 6.0–6.3 — the existing audit / undo / pending-confirmation surfaces handle everything. Phase 6.4 needs a "matter draft → confirm" card in the briefing (small Wasp action). Phase 6.5 reuses the same surface.
- **No new ctrl-api routes** until Phase 6.4 (when matter creation needs a `POST /api/v1/admin/matters` endpoint).

Conversation event ingestion (Phase 6.0) is the only piece that touches openclaw-main — adds a hook to persist each conversation turn to vault. Risk is low; openclaw already emits events.

## Pre-deployment decisions to lock

| # | Decision | Default proposal |
|---|---|---|
| 1 | Conversation retention window for extraction | 7 days rolling |
| 2 | Hard cap on auto-created matters per day | 10 (settable per-tenant) |
| 3 | Disambiguation surface | Brief + chat (not its own page) |
| 4 | "Off the record" magic phrase | `"off the record"` exactly, prefix-match |
| 5 | Default confidence floor for live actions | 0.85 (high-confidence-only) for first 30 days, then 0.6 (live) |
| 6 | Conversation channels in scope for v1 | openclaw-main, slack, omi, meetings (defer dashboard chat to v1.1) |
| 7 | Matter context edit — rewrite vs append? | Append-with-strikethrough for v1 (full audit; rewrite is a v2 add) |

Sir locks these before the first phase starts; they're hard to change later without re-soaking.

## Conflicts

- **vs. #687 (World Model RFC):** corrections become first-class projection inputs — every conversation correction is a canonical event. No conflict; this RFC produces the events that #687's projections will consume.
- **vs. surveyor:** surveyor still does initial categorization on ingest. Corrections override surveyor's labels. Calibration loop sends repeated overrides back into surveyor's prompt as negative examples. Light coupling; no rewrites needed.
- **vs. existing Steward (#832):** zero conflict. The conversation source is just a new entry in `signal_sources` with the existing calibration / confidence / audit machinery. The matter mutation pipeline extends `apply_state_change` from task-only to (task | matter) — additive, not breaking.
- **vs. #832 Phase 5 calibration:** corrections feed the same calibration loop. Conversation source's confidence is tracked, scored, and pruned by the existing mechanism. Free integration.

## Out of scope

- **Multi-tenant correction sharing.** Each tenant's conversations stay strictly local. (Same constraint as #832.)
- **Voice synthesis / speaking back to Sir.** Conversation flows in but corrections surface as text in dashboard / briefing. Voice in v2.
- **Real-time interruption** ("hey wait, I noticed you said X, want me to update Y?"). The agent infrastructure to do this exists in openclaw-main, but the prompting + UX is its own design problem. v2.
- **Backfill of historic conversations.** Phase 6.0 starts fresh — events from cutover forward only. Historic OMI / chat data isn't re-extracted. Backfill is a manual one-shot if Sir wants it.
- **Cross-conversation reasoning.** Each correction is extracted from one conversation event. Themes that span weeks ("I've been saying for a month that X is dead") aren't synthesized in v1. Phase 7 territory.

## What this gives Sir, concretely

After Phase 6.5 lands, the daily flow looks like:

1. Sir talks to Alfred normally. He says "the szabostuban kft tasks shouldn't be under household, they're business" while reviewing the brief.
2. Within ~5 minutes (or sooner if webhook fan-out is wired), 3 tasks under `matter/household-cash-flow` get re-parented to `matter/szab-stubn-kft-formation-business-restructuring`. Audit event written. Inline badge appears.
3. Tomorrow's brief shows: "Moved 3 tasks from Household to Szabó-Stuban Kft per yesterday's correction." One-click undo if wrong.
4. Sir sees the brief, sees it's right, doesn't undo, doesn't think about it. Vault is now correct. He never had to open a settings page or fill out a form.

That's the point — *the correction is the side effect of normal conversation*. The vault tracks Sir's thinking without Sir having to instruct the vault.

---

**Filing instructions:** post this as GitHub issue #842 on `ssdavidai/alfred-platform`, labels: `rfc`, `pkg:learn`, `steward`, `P1:high`. Cross-link to #832 in the body.
