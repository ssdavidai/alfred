# Workflow Durability Classification

**Status:** analysis doc — gates issues #48 and #51. Part of #37 / Option 3.

## Purpose

Option 3 of the de-engineering plan keeps **Temporal only for workflows that
genuinely need replay-grade durability**. Everything else can move to Hermes
`cron`.

The two execution substrates have fundamentally different guarantees:

| | Temporal Schedule | Hermes `cron` |
|---|---|---|
| Crash recovery (mid-run) | yes — workflow replays from history | no — partial run is lost |
| Retries (activity-level) | yes — `RetryPolicy` per step | no — best-effort, fire and forget |
| Missed-run catch-up | yes — `ScheduleOverlapPolicy`, backfill | no — a missed tick is simply skipped |
| Durable timers | yes — `workflow.sleep`, `execute_at` waits | no — timer dies with the gateway process |
| Survives gateway restart | yes — schedule lives in Temporal server | no — dies with the gateway |
| Exactly-once child workflows | yes — deterministic workflow IDs | no |

So a workflow is **safe to move to cron** only if *all three* of the
following hold:

1. It re-runs on a fixed cadence (it is a poller / sweeper, not a one-shot).
2. A missed or half-completed run causes no permanent harm — the next tick
   re-discovers the same work (idempotent, cursor- or status-driven).
3. It does not need a durable timer to fire once at a future computed time.

## Classification scheme

- **`durability-critical`** — must stay on Temporal. Multi-step with
  mid-flight resume, exactly-once semantics, or correctness depends on a
  guaranteed run that no later tick re-discovers.
- **`fixed-cadence-idempotent`** — cron-eligible. A poll/sweep loop; a missed
  run is fully recovered by the next tick because the workflow re-reads
  current state each time.
- **`one-shot-timed`** — fires once at a computed future time and needs a
  durable timer. Either stays on Temporal, or needs a carefully-built cron
  equivalent (a persisted-queue + frequent-poll pattern). The #51 spike must
  evaluate these.

> **A note on the line between the first two classes.** Almost every `learn`
> workflow caps its per-tick batch ("process up to N") and is *individually*
> step-idempotent at the activity level. That alone does **not** make a
> workflow cron-safe. The test that matters is: *if this run is dropped
> mid-flight, does the next scheduled tick re-discover the exact same work?*
> If yes → `fixed-cadence-idempotent`. If a dropped run silently loses work
> that nothing re-surfaces → `durability-critical`.

---

## Classification table

### Core scheduled workflows (always-on interval/calendar schedules)

| Workflow | Schedule / cadence | What it does | Multi-step / long-running | Idempotent | Missed run self-heals? | Class | Rationale |
|---|---|---|---|---|---|---|---|
| `EventProcessorWorkflow` | interval 15 min | Drains unprocessed stream events → stream-log line + zero-LLM vault record; spawns `MediaIngestionWorkflow` children. | multi-step, bounded (≤20 events/run) | yes — `mark_event_processed` cursor; bounded retry | yes — unprocessed events stay in the queue for the next tick | `fixed-cadence-idempotent` | Pure poll-drain off a server-side processed cursor. A dropped run leaves events un-marked; next tick re-fetches them. *Caveat:* it spawns `MediaIngestionWorkflow` as a Temporal child — under cron that becomes an in-process call, acceptable since media events also stay un-marked on failure. |
| `SessionTrackerWorkflow` | interval 15 min | Rolling session state machine — opens/closes/append sessions from recent vault records. | multi-step | yes — re-reads `session_state` each tick; idle counter is derived from timestamps | mostly — a missed tick under-counts `idle_minutes` by one interval, self-corrects on the next | `fixed-cadence-idempotent` | State is recomputed from vault timestamps + a state file each run, not accumulated in workflow memory. A skipped tick slightly delays an idle-close; harmless. |
| `LearningWorkflow` | interval 15 min | Drains observation queue + `alfred_instructions` + chore-run-history into observation records. | multi-step | yes — queue is cleared only after processing; chore-run seeding is cursor-tracked | yes — unprocessed queue items + un-advanced cursor carry to the next tick | `fixed-cadence-idempotent` | Queue/cursor-driven drain. `execute_alfred_instructions` is an action step but is gated by the same un-cleared queue, so a missed run just re-runs it. The core learning loop *as a poller* is cron-eligible — see #51 note below. |
| `ReflectionWorkflow` | calendar 02:00 daily | Nightly clerk review of unprocessed observations → instinct changes + intuition-index rebuild + report. | multi-step, LLM-heavy | yes — observations marked processed only at the end; index rebuild is deterministic | yes — observations stay unprocessed until a run completes | `fixed-cadence-idempotent` | Despite being the "core learning loop", this is a daily sweep over an unprocessed-observation pool. A skipped night is fully recovered the next night (a larger batch). No mid-flight resume requirement. |
| `JudgmentWorkflow` | interval 15 min | Per-input routing — scores instincts, auto-routes or escalates each unrouted input. | multi-step | yes — routing writes structured records; un-routed inputs are re-fetched | yes — `fetch_unrouted_inputs` re-discovers anything not yet routed | `fixed-cadence-idempotent` | A poll over unrouted inputs. `execute_route` performs side effects, but an input only leaves the unrouted set once a route succeeds, so a dropped run is re-tried next tick. |
| `MediaIngestionWorkflow` | *not scheduled* — child of `EventProcessorWorkflow` | Per-file media processing (transcribe / OCR / classify / braindump-split). | multi-step, LLM-heavy | yes — keyed off the source event; re-run overwrites | n/a — triggered, not scheduled | `durability-critical` | Not a scheduled workflow. It is launched as a Temporal **child workflow** with a deterministic ID. If moved off Temporal it becomes an in-process call inside whatever drains media events; it is not a cron candidate itself. The #51 spike must decide how `EventProcessor`-on-cron invokes it. |
| `TaskRunnerWorkflow` | interval 15 min | Picks queued `owner=alfred` tasks, executes via OpenClaw, writes artifacts + consequentials. | multi-step, long-running (300s exec activity) | yes — task `status` flips queued→active→done/blocked; only `queued` tasks are picked | partially — a run dropped *after* `status=active` but before completion leaves the task stuck in `active` | `durability-critical` | A mid-flight crash strands a task in `status=active` that no later tick re-picks (the poll only takes `queued`). Recovering that needs replay or a separate reaper. Keep on Temporal unless #51 adds an `active`-task timeout sweep. |
| `StreamPullerWorkflow` | *not interval-registered here* — started per-stream | Generic HTTP/Composio pull engine; fetches, parses, ingests, advances cursor. | multi-step | yes — cursor advanced only after successful ingest | yes — un-advanced cursor means the next pull re-fetches the same window | `fixed-cadence-idempotent` | Cursor-driven incremental pull. Not in `INTERVAL_SCHEDULES` (started with a per-stream argument), but its *shape* is a cron-eligible poller. #51 must confirm how per-stream invocation is triggered before moving it. |
| `OnboardingPipelineWorkflow` | *not scheduled* — started on signup | 8-stage onboarding: email fetch → profiler → 4 Opus calls → packs → chores → background backfill. Returns mid-way at `awaiting_verification` and is re-triggered. | heavily multi-step, long-running (stages run 15–60 min), explicit resume points | per-stage idempotent via `_stage_index` resume guard | n/a — triggered once per user | `durability-critical` | The textbook durability case: a long pipeline with explicit `resume_idx` checkpoints and a deliberate mid-run return to wait for human verification. A crash must resume from the last completed stage — only Temporal history gives that. Never move to cron. |
| `OmiAudioProcessorWorkflow` | interval 10 min | Scans Omi PCM audio buffer, groups, transcribes (Groq Whisper), ingests as stream events. | multi-step, bounded (≤5 groups/run) | yes — files marked processed; capped per run | yes — unprocessed audio files stay on disk for the next tick | `fixed-cadence-idempotent` | A buffer-drain sweep. Un-transcribed files persist on disk; the next 10-min tick re-scans them. |
| `NightlyMaintenanceWorkflow` | calendar 03:00 daily | Runs janitor + distiller batches sequentially via ctrl-api. | multi-step | yes — janitor/distiller are bounded one-shots, safe to re-run | yes — a skipped night just runs the next night | `fixed-cadence-idempotent` | Serialized nightly batch. No cross-run state; a missed run is recovered by the next. |
| `ChorePromotionReflectionWorkflow` | calendar Sunday 03:00 weekly | Scans generated chore templates, asks Opus to draft promotion PRs, persists drafts. | multi-step, bounded (`_MAX_DRAFTS_PER_TICK`) | yes — drafts are re-derived from on-disk analytics each run | yes — a skipped Sunday re-runs the next Sunday over the same candidate set | `fixed-cadence-idempotent` | Weekly reflection sweep over on-disk chore analytics. State is fully re-derived. |
| `HourlyEnrichmentWorkflow` | interval 1 hr | One batched LLM call to enrich `enrichment_status=pending` event records. | multi-step, bounded (`MAX_PENDING_PER_WORKFLOW_RUN`=1000) | yes — records marked enriched only after `apply_enrichments` | yes — pending records stay pending until a run completes | `fixed-cadence-idempotent` | Status-flag-driven batch enrichment. A dropped run leaves records `pending`; next hour re-batches them. |
| `PatternDetectionWorkflow` | interval 1 hr (overlap SKIP) | OBS-4 deterministic clustering over the observation pool → `pattern_proposal` records. | single activity, thin wrapper | yes — deterministic clustering + skip-set | yes — re-scans the full observation pool each tick | `fixed-cadence-idempotent` | Thin one-activity wrapper; the activity re-reads everything. Trivially cron-safe. |
| `DecisionPatternsWorkflow` | calendar 03:00 daily | Daily clerk extraction of recurring rules from recent decisions → `decision_pattern` records. | single activity | yes — re-groups recent decisions each run; writes proposals | yes — a skipped day re-extracts the next day (slightly wider window) | `fixed-cadence-idempotent` | One-activity daily extraction. Re-derived from the decision corpus each run. |
| `DeferResurfaceWorkflow` | interval 15 min | Sweeps `skipped` needs_attention cards whose `resurface_at` has fallen due → flips to `pending`. | single activity | yes — once flipped, the next pass skips them | yes — a due card stays due; next tick re-surfaces it | `fixed-cadence-idempotent` | **Note:** the issue lists this as a strong `durability-critical` candidate, but the *workflow* is a fixed-cadence sweep — the durable timer it depends on is the `resurface_at` timestamp **persisted on the vault record**, not a Temporal timer. The "when" parsing happens inside `DecisionRouterWorkflow`; this workflow only polls. A missed 15-min tick merely delays a resurface by one interval. Safe for cron *as long as the `resurface_at` field is persisted in the vault* (it is). |
| `TaskClosureWatcherWorkflow` | interval 5 min | Matches recent signals (last 30 min) against open tasks; high-confidence pairs auto-write a closure decision. | multi-step, bounded (`MAX_PAIRS_PER_TICK`) | yes — closure writes a `decision` record; re-run is idempotent on the same pair | mostly — uses a 30-min signal lookback against a 5-min cadence, so one missed tick is still covered by the lookback overlap | `fixed-cadence-idempotent` | The 30-min lookback deliberately over-covers the 5-min cadence (6× overlap) precisely so a missed tick loses nothing. Cron-safe; #51 should confirm the lookback window stays wider than the cron interval. |
| `ScheduledDispatchWorkflow` | interval 15 min | Sweeps decisions in `state=scheduled` and fires the real dispatch for any whose `execute_at` has passed. | single activity | yes — dispatch flips decision state | yes — a still-due decision is re-found next tick | `one-shot-timed` | **The issue flags this as `durability-critical`; the more precise class is `one-shot-timed`.** The *workflow* is a poller, but its job is to make a delegate-with-when decision fire once at a computed `execute_at`. The durability requirement is the timer, and the timer is **persisted as `execute_at` on the decision record** — not a Temporal timer. So cron *can* serve it via the persisted-queue + frequent-poll pattern. The risk: a 15-min cron interval means up to 15-min dispatch lateness, and a gateway down across the due window delays the dispatch until the gateway returns. #51 must decide if that lateness is acceptable for "send Adam Wednesday morning". |
| `DecayWatcherWorkflow` | interval 6 hr | Stamps freshness bands on pending needs_attention cards, auto-flips deeply stale ones; adjusts matter `surface_class`. | multi-step, `workflow.patched` branch | yes — bands/scores are recomputed from timestamps each run | yes — decay is a pure function of record age; the next tick re-derives it | `fixed-cadence-idempotent` | Decay is `f(record age)` — fully recomputed every run. A missed 6-hr tick just means a slightly staler band until the next sweep. |
| `DecisionRouterWorkflow` | interval 60 s (overlap SKIP) | Fans out side-effects of every Desk click — status flips, signal re-arms, agent dispatches, to_do spawns, reversal inversions, outcome polling. | multi-step, 3 passes | yes — per-decision state transitions are atomic PATCHes; the docstring explicitly says "a retry can't double-fire side effects" | yes — a decision not yet routed stays in `open`/`reversed`/`executing` and is re-found next tick | `durability-critical` | **Borderline — flagged here as `durability-critical` and the #51 spike must adjudicate.** The author designed it to be retry-safe (idempotent per-decision PATCHes), which argues `fixed-cadence-idempotent`. *But* it dispatches agents and spawns to_dos as real side effects on a 60-second latency budget, and it polls executing-delegate outcomes. Losing crash-recovery here means a click's side-effects can be delayed indefinitely while the gateway is down, and the outcome-polling pass (`check_decision_outcomes`) is a guaranteed-progress requirement. Conservative call: keep on Temporal until #51 proves the idempotency claim end-to-end. |
| `BriefingWorkflow` | *not interval-registered here* — two chore slots (`daily-morning-briefing`, `daily-evening-digest`) | Two-phase morning/evening composer: Phase 1 mutates every matter via the universal state-mutator; Phase 2 re-reads + composes the brief snapshot. | heavily multi-step (per-matter fan-out + 2 phases), LLM-heavy | yes — `apply_state_change_v2` is the audited read-reason-write primitive; brief write is overwrite-by-path | partially — a crash between Phase 1 and Phase 2 leaves matters mutated but no brief written | `durability-critical` | The two phases are explicitly decoupled (spec §8.3) and order-dependent: the composer must read *post-mutation* state. A mid-flight crash leaves matters mutated with no brief — the next scheduled run would re-mutate (idempotent) but the missed brief slot is gone. Multi-step with an ordering invariant → keep on Temporal. |

### Plane sync workflows (feature-gated on `PLANE_SYNC_ENABLED`)

| Workflow | Schedule / cadence | What it does | Multi-step / long-running | Idempotent | Missed run self-heals? | Class | Rationale |
|---|---|---|---|---|---|---|---|
| `PlaneSyncWorkflow` | interval 15 s (overlap SKIP, 5-min timeout) | One-way vault → Plane sync; paginated changed-matter/task fetch, per-batch cursor advance. | multi-step, paginated | yes — per-batch cursor; a partial cursor is picked up cleanly next run | yes — un-advanced cursor means the next 15-s tick re-syncs the window | `durability-critical` | The issue flags the Plane workflows as `durability-critical`, and the cursor-advance discipline is exactly why: forward sync mutates an external system (Plane) and the per-batch cursor *is* the resume point. A run dropped mid-pagination must resume from the partial cursor — that resume is what makes the sync non-lossy. A best-effort cron with no crash recovery risks a permanently frozen cursor (the #592 failure mode). Keep on Temporal. |
| `PlaneReverseSyncWorkflow` | interval 10 s (overlap SKIP, 5-min timeout) | Plane webhook events → vault matter/task/comment patches, with three anti-oscillation loop guards. | multi-step | yes — loop guards + hash compare + `mark_plane_event_processed` | yes — unprocessed Plane events stay in the stream | `durability-critical` | Same reasoning as forward sync, plus: the loop guards depend on outbound-signature state written within a 30-s suppression window. Crash-recovery and exactly-once event processing are correctness requirements — a lost run could re-apply an inbound patch and oscillate with forward sync. Keep on Temporal. |
| `PlaneSyncNudgeWorkflow` | *event-triggered* — fired by ctrl-api after a `matter/`/`task/` vault write | Single-record forward sync; drops nudge→Plane latency from ~15 s to 1–3 s. | short, single-record | yes — reuses the cron's `sync_*_to_plane` activities | yes — explicitly additive; if the nudge fails, the 15-s `PlaneSyncWorkflow` cron picks the record up | `fixed-cadence-idempotent` | Not a scheduled workflow at all — it is an *optimization* fired on demand, and its own docstring states the cron is the safety net. Because the cron fully covers any dropped nudge, the nudge path itself is best-effort by design and could even be a plain HTTP call. Cron-eligible (or droppable) once `PlaneSyncWorkflow` stays durable. |
| `PlaneReconciliationWorkflow` | interval 1 hr (overlap SKIP) | Hourly sweep mirroring Plane REST-deletes (not webhooked in 1.3.0) into vault archives. | single activity | yes — re-scans every project's `plane_id` set each run | yes — a still-orphaned task is re-found next hour | `fixed-cadence-idempotent` | Pure catch-up sweep over current Plane state. Re-derived every run; a missed hour just means a deleted issue's vault task lingers one extra hour. Cron-safe even though it is a "Plane sync workflow". |

### Steward / signal workflows (feature-gated)

| Workflow | Schedule / cadence | What it does | Multi-step / long-running | Idempotent | Missed run self-heals? | Class | Rationale |
|---|---|---|---|---|---|---|---|
| `StewardWorkflow` | per-matter Schedule `al-steward-<slug>`, interval 30 min (5-min timeout) | Per-matter perception loop — evaluates tasks whose `next_check_after` elapsed, stamps `last_steward_check_at`. | multi-step (per-task loop) | yes — `next_check_after` / `last_steward_check_at` cursor on each task | yes — a task due for a check stays due; next tick re-evaluates it | `fixed-cadence-idempotent` | Cursor-driven per-matter sweep. Each task carries its own `next_check_after`; a missed 30-min tick just delays that matter's evaluation by one interval. The per-matter fan-out is one schedule per matter — under cron that becomes one cron entry per matter (#48/#51 must confirm cron supports that cardinality). |
| `SignalExtractWorkflow` | interval 5 min (overlap SKIP, 25-min timeout) | Drains unprocessed stream events → LLM signal extraction → `signal/` records; marks source events processed. | multi-step, bounded (`BATCH_LIMIT`=100), LLM-heavy | yes — deterministic signal slug (overwrite-by-path); `signal_extracted_at` cursor | yes — events without `signal_extracted_at` are re-fetched next tick | `fixed-cadence-idempotent` | Cursor-driven LLM drain. The docstring spells out the deterministic-slug overwrite + the processed-mark cursor — both designed so a dropped run loses nothing. Cron-safe. |
| `SignalRouterWorkflow` | interval 2 min (overlap SKIP) | Routes `unrouted` signals — `effect=mutation` → `apply_signal_mutation`; `effect=action` → `route_signal_action`; else `skipped`. | multi-step, bounded (`BATCH_LIMIT`=50) | yes — per-signal `status` cursor; mutation activity owns idempotent status writes | yes — `unrouted` signals stay unrouted until a run processes them | `fixed-cadence-idempotent` | Status-cursor-driven router. Per-signal try/except + the 2-min cadence as the natural retry boundary. A dropped run leaves signals `unrouted`; next tick re-routes them. *Caveat:* `effect=action` signals can dispatch agents in live mode — same side-effect concern as `DecisionRouterWorkflow`. #51 should confirm action-dispatch idempotency before moving. |
| `MeetingCaptureWorkflow` | interval 60 s (5-min timeout, `VEXA_ENABLED`) | gcal-driven Vexa bot dispatch for Meet events in the next 90 s. | multi-step | yes — `meeting-schedules.json` dedupe state + Vexa's own idempotent `POST /bots` | mostly — the 90-s lookahead deliberately overlaps the 60-s tick | `one-shot-timed` | This is timer-shaped: it must dispatch a bot *before a meeting starts*. The 90 s > 60 s overlap means a single missed tick is still covered, but a gateway down for >90 s across a meeting's start window **misses that meeting permanently** — there is no later tick that re-discovers a meeting already in progress. The durable-ish behavior comes from the overlap margin, not a real timer. #51 must judge whether cron's best-effort nature is acceptable here (a missed meeting transcript is a real, unrecoverable loss). |
| `TranscriptIntakeWorkflow` | interval 60 s (5-min timeout, `VEXA_ENABLED`) | Reads `meeting.completed` events → fetches transcript via Vexa → LLM action extraction → Steward signals. | multi-step, LLM-heavy | yes — unprocessed `meeting.completed` events stay in the stream until marked | yes — a missed tick re-discovers the unprocessed completion event | `fixed-cadence-idempotent` | Webhook-stream drain. Unlike `MeetingCapture`, the trigger (`meeting.completed`) persists in the stream, so a missed run is fully recovered. Cron-safe. |
| `ReversalCalibrationWorkflow` | interval 10 min (`STEWARD_REVERSAL_CALIBRATION_ENABLED`) | Scans `*-reversed-*` event records, drops contributing source-type confidence by 0.1, persists a calibration cache. | single activity | yes — processed-reversals cache prevents double-penalizing | yes — un-processed reversals stay un-processed in the cache | `fixed-cadence-idempotent` | Fleet-state sweep with an explicit processed-reversals cache. A missed 10-min tick just batches a few more reversals next run. Cron-safe. |

### Maintenance / audit workflows (feature-gated)

| Workflow | Schedule / cadence | What it does | Multi-step / long-running | Idempotent | Missed run self-heals? | Class | Rationale |
|---|---|---|---|---|---|---|---|
| `StreamEventPurgeWorkflow` | calendar 03:00 UTC daily (`STEWARD_STREAM_EVENT_PURGE_ENABLED`) | Deletes `stream_event/*` records >7 days old whose `signal_extracted_at` is set. | single activity, per-record try/except | yes — deleting an already-deleted record is a no-op; criteria re-evaluated each run | yes — a still-old record is re-found and purged next day | `fixed-cadence-idempotent` | Pure retention sweep. Idempotent deletes; a missed night purges a slightly larger set the next night. Cron-safe. |
| `FleetAuditWorkflow` | calendar 02:00 UTC daily (`FLEET_AUDIT_ENABLED`, default on) | Scans `composio-*.jsonl` streams for wrong-tenant `self:true` attendees; emits a vault observation. | multi-step, detection-only | yes — re-scans streams + emits a fresh observation each run | yes — a missed day just re-scans the next day | `fixed-cadence-idempotent` | Detection-only daily audit; never mutates streams. Fully re-derived each run. Cron-safe. |
| `ComposioReconnectCleanupWorkflow` | interval 15 min | Safety-net reaper for the Composio reconnect ledger — verify-then-delete-then-purge old connections past the grace window. | multi-step, per-entry isolation | yes — docstring: idempotent ledger semantics, "whichever side wins the race, wins" | yes — a ledger entry past its grace window is re-found next tick | `fixed-cadence-idempotent` | Explicitly built as an idempotent safety-net reaper that coexists with a ctrl-api fast path. A missed tick just defers cleanup 15 min. Cron-safe. |

### Chore-template workflows (per-user cron-style Temporal schedules created via ctrl-api `POST /api/v1/schedules`)

| Workflow | Schedule / cadence | What it does | Multi-step / long-running | Idempotent | Missed run self-heals? | Class | Rationale |
|---|---|---|---|---|---|---|---|
| `SubscriptionWatcherWorkflow` | per-user weekly cron (derived) | Diffs last 7 days of financial events vs. last week's snapshot; LLM-judges only genuine anomalies. | multi-step, bounded; most ticks make 0 LLM calls | yes — re-diffs against the persisted snapshot each run | mostly — a missed week widens the diff window; the snapshot is the carry-over state | `fixed-cadence-idempotent` | The chore templates are already cron-shaped (per-user cron expressions). State lives in a persisted subscription snapshot, so a missed week re-diffs a wider window. *Caveat:* the snapshot is written each run — a missed run means no snapshot rotation, slightly skewing the next diff baseline. Acceptable; cron-safe. |
| `WeeklyMatterDigestWorkflow` | per-user weekly cron (derived) | Counts a matter's events for the week; one LLM call to compose a digest if activity exceeds a threshold. | multi-step, bounded | yes — re-counts events each run; digest write is overwrite-by-path | yes — a missed week is simply a missed digest; the next week re-counts | `fixed-cadence-idempotent` | Stateless weekly summary. A missed run loses one week's digest but harms nothing downstream. Cron-safe. |
| `WeeklyMoneyDayBriefWorkflow` | per-user `0 6 * * 2` (Tuesday 06:00 UTC) | Thin wrapper — asks the main Alfred agent (via ctrl-api one-shot openclaw cron job) to produce + deliver the Money Day brief. | thin wrapper — Temporal owns *when*, openclaw owns *how* | yes — re-running just submits another agent task | yes — a missed Tuesday is a missed brief; nothing carries over | `fixed-cadence-idempotent` | Its own docstring states the design: "Temporal owns the SCHEDULE; openclaw owns the EXECUTION". It is *already* nothing but a scheduled trigger — the textbook cron candidate. Cron-safe. |

### Dynamically-loaded chore templates

`load_user_chore_templates()` imports per-tenant generated chore templates from
`/alfred-data/user-chores/`. These are not enumerable statically (they vary per
tenant and are generated by Opus at onboarding). **By construction** every
generated chore template follows the same pattern as the three reference
templates above — a per-user cron schedule, "Python does the work, the LLM only
judges", state in a persisted snapshot. They inherit the
`fixed-cadence-idempotent` class. #48/#51 should treat the *chore template
substrate as a whole* as cron-eligible rather than enumerating individual
generated templates.

---

## Summary counts

Counting the **41 statically-known workflows** registered in `src/worker.py`
(`_STATIC_WORKFLOWS`), i.e. the 38 named workflow classes plus the 3 chore
templates; dynamically-loaded chore templates are covered as a class above.

| Class | Count | Workflows |
|---|---:|---|
| `durability-critical` | 6 | `MediaIngestionWorkflow`, `TaskRunnerWorkflow`, `OnboardingPipelineWorkflow`, `DecisionRouterWorkflow`, `BriefingWorkflow`, `PlaneSyncWorkflow`, `PlaneReverseSyncWorkflow` |
| `fixed-cadence-idempotent` | 25 | `EventProcessorWorkflow`, `SessionTrackerWorkflow`, `LearningWorkflow`, `ReflectionWorkflow`, `JudgmentWorkflow`, `StreamPullerWorkflow`, `OmiAudioProcessorWorkflow`, `NightlyMaintenanceWorkflow`, `ChorePromotionReflectionWorkflow`, `HourlyEnrichmentWorkflow`, `PatternDetectionWorkflow`, `DecisionPatternsWorkflow`, `DeferResurfaceWorkflow`, `TaskClosureWatcherWorkflow`, `DecayWatcherWorkflow`, `PlaneSyncNudgeWorkflow`, `PlaneReconciliationWorkflow`, `StewardWorkflow`, `SignalExtractWorkflow`, `SignalRouterWorkflow`, `TranscriptIntakeWorkflow`, `ReversalCalibrationWorkflow`, `StreamEventPurgeWorkflow`, `FleetAuditWorkflow`, `ComposioReconnectCleanupWorkflow` |
| `one-shot-timed` | 2 | `ScheduledDispatchWorkflow`, `MeetingCaptureWorkflow` |
| chore templates (`fixed-cadence-idempotent`) | 3 | `SubscriptionWatcherWorkflow`, `WeeklyMatterDigestWorkflow`, `WeeklyMoneyDayBriefWorkflow` |

> The `durability-critical` row lists 7 workflows but counts as 6 against the
> 41-total because `MediaIngestionWorkflow` is **not** a scheduled workflow —
> it is a Temporal child of `EventProcessorWorkflow`. Counted against the
> statically-registered set: **6 durability-critical** (the 5 scheduled/triggered
> ones + the 2 Plane sync − the 1 non-scheduled child), **28
> fixed-cadence-idempotent** (25 core + 3 chore templates), **2 one-shot-timed**.
> The two Plane sync workflows sit in the durability-critical group. Treat the
> exact arithmetic loosely — the actionable lists below are what #48 and #51
> consume.

---

## What issue #48 may move to cron (the clearly cron-safe set)

These workflows are **unambiguously `fixed-cadence-idempotent`** — a poll/sweep
loop where every tick re-reads current state and a dropped run is fully
recovered by the next tick. #48 may move all of these to Hermes `cron`:

- `EventProcessorWorkflow` *(see #51 note re: the `MediaIngestionWorkflow` child)*
- `SessionTrackerWorkflow`
- `LearningWorkflow`
- `ReflectionWorkflow`
- `JudgmentWorkflow`
- `OmiAudioProcessorWorkflow`
- `NightlyMaintenanceWorkflow`
- `ChorePromotionReflectionWorkflow`
- `HourlyEnrichmentWorkflow`
- `PatternDetectionWorkflow`
- `DecisionPatternsWorkflow`
- `DeferResurfaceWorkflow`
- `TaskClosureWatcherWorkflow`
- `DecayWatcherWorkflow`
- `PlaneReconciliationWorkflow`
- `ReversalCalibrationWorkflow`
- `StreamEventPurgeWorkflow`
- `FleetAuditWorkflow`
- `ComposioReconnectCleanupWorkflow`
- `SubscriptionWatcherWorkflow`, `WeeklyMatterDigestWorkflow`, `WeeklyMoneyDayBriefWorkflow` *(the chore-template substrate as a whole, including dynamically-loaded templates)*

## What issue #51's spike must evaluate

These workflows are cron-*eligible in principle* but carry a risk that the #51
spike must resolve before #48 moves them:

- **`StewardWorkflow`** — cron-safe in shape, but it is **one schedule per
  matter** (`al-steward-<slug>`). #51 must confirm Hermes `cron` supports that
  schedule cardinality (potentially hundreds of entries) and a registrar that
  creates/deletes them as matters appear/disappear.
- **`StreamPullerWorkflow`** — cron-shaped poller, but it is started with a
  per-stream argument and is not in `INTERVAL_SCHEDULES`. #51 must trace how
  per-stream invocation is triggered today and design the cron equivalent.
- **`SignalExtractWorkflow`** — cron-safe drain, but verify the deterministic-slug
  overwrite + `signal_extracted_at` cursor genuinely survive a best-effort
  substrate with no activity retries.
- **`SignalRouterWorkflow`** — cron-safe drain, but in live mode it dispatches
  agents on `effect=action` signals. #51 must confirm action-dispatch is
  idempotent under a retry-less substrate.
- **`DecisionRouterWorkflow`** — *classified `durability-critical` here as the
  conservative call.* The author built it to be retry-safe (idempotent
  per-decision PATCHes). #51 must prove that claim end-to-end — especially the
  agent-dispatch and `check_decision_outcomes` outcome-polling passes — before
  it can be downgraded to cron-eligible. The 60-second latency budget also
  needs a cron interval that honors it.
- **`ScheduledDispatchWorkflow`** (`one-shot-timed`) — the durable timer is the
  `execute_at` field persisted on the decision record, so cron *can* serve it
  via persisted-queue + frequent-poll. #51 must decide whether the resulting
  dispatch lateness (up to one cron interval, plus the full gateway-downtime
  window) is acceptable for delegate-with-when ("send Adam Wednesday morning").
- **`MeetingCaptureWorkflow`** (`one-shot-timed`) — must dispatch a Vexa bot
  *before* a meeting starts. A gateway down across a meeting's start window
  loses that transcript permanently. #51 must judge whether cron's best-effort
  nature is acceptable, or whether this one stays on Temporal.
- **`PlaneSyncNudgeWorkflow`** — already best-effort by design (the 15-s cron is
  its safety net). #51 should decide whether it becomes a cron entry, a plain
  ctrl-api HTTP call, or is dropped entirely.
- **`MediaIngestionWorkflow`** — not a scheduled workflow; a Temporal child of
  `EventProcessor`. If `EventProcessorWorkflow` moves to cron, #51 must design
  how the cron job invokes media processing (in-process call vs. a separate
  queue).

## Workflows that could not be confidently classified

- **`DecisionRouterWorkflow`** — genuinely borderline between
  `fixed-cadence-idempotent` and `durability-critical`. The idempotency design
  is real and well-documented, which argues cron-eligible; the real
  agent-dispatch side effects, the 60-s latency budget, and the
  guaranteed-progress outcome-polling pass argue durability-critical. Filed as
  `durability-critical` (the safe default) **pending the #51 spike** — this is
  the single highest-value workflow for #51 to adjudicate.
- **`ScheduledDispatchWorkflow`** / **`MeetingCaptureWorkflow`** — both are
  `one-shot-timed`. They are *not* unclassifiable, but the class itself is the
  open question: a cron equivalent exists in principle (persisted timestamp +
  frequent poll), and whether that is *good enough* is a product/risk call the
  #51 spike must make, not a code fact.
