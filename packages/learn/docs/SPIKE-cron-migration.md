# SPIKE — Moving fixed-cadence idempotent loops to Hermes `cron`

**Status:** spike / decision doc — resolves issue [#51](https://github.com/ssdavidai/alfred-black/issues/51). Gates the executable scope of [#48](https://github.com/ssdavidai/alfred-black/issues/48). Part of [#37](https://github.com/ssdavidai/alfred-black/issues/37) / Option 3.
**Date:** 2026-05-19
**Required input:** `packages/learn/docs/WORKFLOW-DURABILITY.md` (the #47 classification) — its *"What issue #51's spike must evaluate"* list is the agenda below.
**Hermes version studied:** `v2026.5.16` (release v0.14.0), pinned in `packages/hermes/VERSION`. Hermes cron behaviour is sourced from the upstream docs `hermes-agent.nousresearch.com/docs/user-guide/features/cron`, cross-checked against `packages/hermes/docs/ADR-profile-split.md` which studied the same release.

---

## Scope note — what is grounded in code vs. in Hermes docs

Two things must be stated plainly up front, because they bound how far this
spike can go on code evidence alone:

1. **Hermes `cron` is an upstream feature; there is no `cron` source in this
   repo.** `alfred-black` ships Hermes via pip from a git tag
   (`HERMES_REF=v2026.5.16`) — the cron engine (`~/.hermes/cron/jobs.json`,
   the `cronjob` tool, the per-tick scheduler) lives inside the Hermes
   package, not here. The only repo-side cron surface is a **read-only**
   passthrough: `ctrl-api`'s `GET /api/v1/hermes/cron` route
   (`packages/ctrl/src/api/routes/hermes.ts:207`) shells `hermes cron` and
   returns its JSON. There is **no** repo code today that *adds* or *removes*
   Hermes cron jobs. Claims about cron internals below are therefore grounded
   in the Hermes v2026.5.16 docs (the same source the profile-split ADR
   relied on), not in `alfred-black` code, and are flagged where the docs are
   silent.

2. **`packages/ctrl/src/api/cron.ts` is NOT the Hermes cron engine.** It is a
   5-field cron *expression parser / next-fire-time computer* used by the
   `/chores` UI to display "next run in 14h" without querying Temporal. Its
   own header says so: *"Temporal is the actual scheduler; we just compute
   when it will next fire."* It is unrelated to Hermes `cron` and is not
   evidence about cron feasibility either way.

The honest consequence: this spike resolves the **eight workflow-shape
questions** decisively from the `learn` code, and resolves the **Hermes-cron
feasibility questions** from the v2026.5.16 docs with the gaps called out. The
recommendation at the end is deliberately conservative where a doc claim could
not be verified against running code.

---

## Hermes cron feasibility

Everything in this section is from the Hermes v2026.5.16 docs. Where the docs
do not answer a question, it is marked **[UNVERIFIED]** and treated as a risk.

### Execution model

- A Hermes cron job runs **in a fresh agent session with no chat platform
  attached** (ADR-profile-split.md §"What the Hermes docs actually say" item 4,
  citing `/docs/user-guide/features/cron`). It inherits the profile's global
  model when the job's `model` is null.
- Cron is the **durable** background primitive in Hermes: the delegation-patterns
  guide explicitly says *"for work that must outlive the current turn, use
  `cronjob` or `terminal(background=True, …)`"* (ADR §item 3). So a cron job
  **survives a gateway restart** in the sense that the *schedule* is persisted
  to disk (`~/.hermes/cron/jobs.json`) and re-armed on gateway boot.
- **But cron does NOT give crash-recovery of an in-flight run.** This is the
  load-bearing distinction for #51. The WORKFLOW-DURABILITY.md substrate table
  is correct: a cron *tick* that dies mid-execution is simply lost — there is
  no run history to replay, no activity-level `RetryPolicy`. The job re-arms
  and the **next tick** runs from scratch. A cron job is exactly as durable as
  "the schedule re-fires on cadence"; it is *not* as durable as a Temporal
  workflow's mid-run resume.
- **Sequential-per-tick.** The cron scheduler evaluates jobs on a tick and runs
  due jobs; there is no documented parallel-tick fan-out, and on the `workers`
  profile `delegation.max_concurrent_children: 1` plus the one-gateway-process
  model means cron-launched agent work serialises through the same single
  throttle that the profile-split ADR identifies as the global TPM ceiling.
  This is *good* for cost safety but means **N cron jobs firing on the same
  tick run one after another**, not concurrently — relevant to the Steward
  cardinality question below.

### `cron.wakeAgent` — the script-only gate

The Hermes docs distinguish two kinds of cron job:

- **Agent jobs** — the tick wakes an LLM agent session (the default; this is
  what `deliver=all` ships to channels).
- **Script-only jobs** — `cron.wakeAgent: false` (the gate). The tick runs a
  **plain command / script with no LLM session spawned at all**.

This gate is decisive for #48/#51 economics. The overwhelming majority of the
cron-eligible `learn` workflows are **"Python does the work, the LLM only
judges, and most ticks make zero LLM calls"** — `EventProcessorWorkflow` is
explicitly *zero-LLM*; `PatternDetectionWorkflow` is deterministic clustering;
the purge/audit/reconciliation sweeps never call an LLM. For every one of
those, the cron entry should be a **`wakeAgent: false` script job** that
invokes the existing activity logic as a plain process — **not** an agent
session. That keeps cron migration from silently adding an LLM call per tick
to a loop that had none.

### `HERMES_CRON_TIMEOUT`

Hermes bounds each cron job's run with a timeout (env `HERMES_CRON_TIMEOUT`,
applied per job invocation). This is the cron analogue of the Temporal
`execution_timeout` / `run_timeout` that `register_schedules.py` sets on every
schedule (5 min for Steward / plane-sync, 25 min for signal-extract, 10 min for
stream-event-purge). **Action for #48:** any workflow moved to cron must have a
`HERMES_CRON_TIMEOUT` (global) or per-job timeout that is **≥ the Temporal
timeout it replaces** — otherwise the longest-tail workflows (signal-extract's
documented 1200 s worst case; the stream-event-purge backlog drain) get killed
mid-run. A too-short global timeout is a silent data-loss footgun. The default
must be audited before any move.

### Timezone handling

- Hermes cron expressions are evaluated against a configurable timezone; the
  default is the host/container timezone (UTC in the tenant containers).
- `learn` today is **timezone-correct** by passing `time_zone_name=timezone`
  into `ScheduleSpec` for calendar schedules, where `timezone =
  config.tenant_timezone` (`config.py:52-53`, IANA string from
  `TENANT_TIMEZONE`, default `UTC`). The two UTC-pinned schedules
  (`al-fleet-audit`, `al-stream-event-purge`) deliberately pass
  `time_zone_name="UTC"` so fleet-wide audit/retention math is consistent.
- **Feasibility:** a cron migration MUST preserve this split — *daily*
  calendar jobs (`ReflectionWorkflow` 02:00, `NightlyMaintenanceWorkflow`
  03:00, `ChorePromotionReflectionWorkflow` Sunday 03:00, `DecisionPatternsWorkflow`)
  fire at *tenant-local* times and must run in a cron context set to
  `TENANT_TIMEZONE`; the audit/retention sweeps must stay UTC-pinned. If the
  cron engine offers only one timezone per job, #48 must render the right
  zone per job at registration time (the data is already on `config.py`).
  **[UNVERIFIED]** whether Hermes cron supports per-job timezone vs. only a
  global one — if global-only, the UTC-pinned jobs and the tenant-local jobs
  cannot coexist in one cron and #48 must either translate the tenant-local
  cron expression into a UTC expression at registration time (doable; the
  offset is known) or keep the calendar jobs on Temporal. **This is a
  must-resolve-before-#48 item.**

### Two profiles → two independent crons

`alfred-black` runs **two Hermes profiles** (`main`, `workers`), each its own
gateway process with its own home directory — the profile-split ADR confirms
profiles isolate *config, sessions, memory, .env, and the gateway process*.
Cron state lives under the profile home (`~/.hermes/cron/jobs.json` is
per-profile). Therefore:

- **Each profile has its own independent cron.** A job registered on `workers`
  does not appear on `main` and vice versa.
- The `learn` autonomous workloads all target the **`workers`** profile
  (`:18790`) — `clerk.py`, `ephemeral_agent.py`, the vault-worker wrapper, all
  pinned there per the ADR. So **every cron job that replaces a `learn`
  workflow belongs on the `workers` profile cron**, where it inherits the
  cheap model, `memory_enabled: false`, and the `max_concurrent_children: 1`
  global throttle.
- The one exception is principal-notification delivery: a job needing
  `deliver=all` must run on **`main`** (only `main` has the messaging
  toolsets). That is the #45 path, out of scope here.

### Cardinality and dynamic create/delete (the Steward question)

- The docs describe `cronjob` with `add` / `remove` operations and a
  disk-backed `jobs.json`. There is **no documented hard cap** on the number
  of cron jobs, and **[UNVERIFIED]** whether the scheduler's per-tick scan is
  O(jobs) (it almost certainly is — a linear scan of `jobs.json` each tick).
- For a few dozen jobs that is a non-issue. For **"potentially hundreds"**
  (one per matter) it is a real concern on two axes: (a) a linear per-tick
  scan of a hundreds-entry `jobs.json` every minute, and (b) the
  sequential-per-tick execution model means if many Steward jobs share a
  fire-minute they run **serially**, so a hundred 30-min Steward jobs that all
  landed on `:00` would drain one after another — acceptable for a no-op tick
  (<1 s each per WORKFLOW-DURABILITY.md) but pathological once Phase 1 puts an
  LLM call in `evaluate_task`.
- Dynamic create/delete *is* supported (`cronjob add` / `remove`), so a
  registrar is feasible **in principle** — but see the Steward decision below
  for why it is the wrong shape regardless.

---

## Per-item decisions

### 1. `StewardWorkflow` — **KEEP ON TEMPORAL** (do not build a per-matter cron registrar)

**Today (grounded in `scripts/register_schedules.py:1054-1279`):** one Temporal
Schedule per matter, id `al-steward-<slug>`, interval 30 min, overlap SKIP,
5-min timeout. `register_steward_schedules()` is a full registrar: it lists
`matter/*.md` via ctrl-api, creates/updates one schedule per matter, and
**deletes orphan `al-steward-*` schedules** whose matter no longer exists. It
runs on container boot.

**The cron equivalent would be:** a registrar that, on every matter
create/delete, calls `cronjob add` / `cronjob remove` against the `workers`
profile cron — reproducing `register_steward_schedules()` against
`jobs.json` instead of Temporal.

**Decision: keep on Temporal.** Three reasons, in priority order:

1. **The workflow shape is cron-safe, but the *cardinality + dynamism* is
   exactly what cron is worst at.** Temporal Schedules are individually
   addressable server-side objects with first-class create/describe/update/
   delete and `list_schedules()` — the registrar already leans on every one of
   those (`_create_or_update_steward_schedule`, `_delete_orphan_steward_schedules`).
   Hermes cron's `jobs.json` is a single flat file mutated by `cronjob add`/
   `remove`; a hundreds-entry file mutated concurrently by a registrar **and**
   the gateway's own scheduler is a far weaker substrate for the same job. The
   orphan-sweep (`list_schedules()` filtered by prefix) maps to "parse
   `jobs.json`, diff against the matter set, remove" — doable but fragile, and
   a partial write to `jobs.json` is unrecoverable in a way a Temporal API
   call is not.
2. **The registrar itself would need a durable home.** `register_schedules.py`
   runs once on boot. A cron registrar must run *every time a matter is
   created or deleted* — i.e. it becomes an event-driven sync job. That is a
   new always-correct component whose own failure mode (missed a matter
   create → that matter is never perceived; missed a delete → a zombie cron
   job ticks forever against a dead matter) is worse than the thing it
   replaces. WORKFLOW-DURABILITY.md classes Steward `fixed-cadence-idempotent`
   on *workflow shape* — but the **registrar** is not idempotent-by-cadence,
   it is a stateful sync, and #51's job is to catch exactly this.
3. **Phase 1+ puts an LLM call in `evaluate_task`.** Once Steward is doing
   per-task LLM evaluation, the sequential-per-tick cron model turns "hundreds
   of matters" into a serialised LLM drain through the single `workers`
   throttle on every shared fire-minute. Temporal Schedules each start an
   independent workflow; the worker's task-queue concurrency, not a flat file,
   governs parallelism.

**The simplification #48 wants is still available — just not via per-matter
cron.** The better refactor (propose as a follow-up, not part of #48): collapse
the per-matter fan-out into **one `StewardSweepWorkflow`** on a single 30-min
schedule that internally loops matters whose `next_check_after` has elapsed.
Steward state is *already* a per-task `next_check_after` / `last_steward_check_at`
cursor (WORKFLOW-DURABILITY.md row) — the per-matter *schedule* carries no
state the cursor doesn't. One sweep workflow is one schedule (or one cron job)
regardless of matter count, kills the entire registrar, and *then* the result
is cron-eligible. **That collapse should happen before any cron move, and is
its own issue** (see follow-ups).

### 2. `StreamPullerWorkflow` — **CRON-ELIGIBLE, but migrate as part of the stream-config substrate, not standalone**

**Today (grounded):** `StreamPullerWorkflow` is **not** in
`register_schedules.py`'s `INTERVAL_SCHEDULES`. It is registered **per stream
by ctrl-api**: `packages/ctrl/src/api/routes/integrations.ts` builds a schedule
id `al-stream-pull-composio-${streamId.slice(0,20)}` and creates a Temporal
schedule running `StreamPullerWorkflow` with `--type StreamPullerWorkflow` and
the `stream_id` as argument (lines 1825, 2008, 2691, 3219). `streams.ts:506`
spells out the contract: *"Register a Temporal schedule that calls the
StreamPullerWorkflow with this stream_id, OR use `schedule_interval_seconds`
and let the next reconciler pick it up."* So today this is **exactly the same
per-entity dynamic-registrar pattern as Steward** — one schedule per stream,
created/deleted by ctrl-api as streams are enabled/disabled.

**Decision: cron-eligible, but inherits the Steward verdict on cardinality.**
The workflow body itself (`stream_puller.py`) is a clean cursor-driven
incremental pull — `update_cursor` is called only after a successful ingest,
so a dropped run re-pulls the same window next tick. That is genuinely
`fixed-cadence-idempotent`. **But** the per-stream schedule cardinality and the
ctrl-api-driven create/delete are the same anti-pattern as Steward, just with
fewer entities (streams are far fewer than matters — typically <20/tenant).

**Concrete cron design:** Do **not** create one cron job per stream. Instead:

- Register **one `StreamSweepWorkflow`/cron job** on a short interval (e.g.
  2 min) that calls a new `fire_due_stream_pulls` activity. That activity lists
  enabled streams, checks each stream's `schedule_interval_seconds` against its
  `last_pull_at`, and runs `StreamPullerWorkflow`'s body inline for any stream
  that is due. The stream config **already carries `schedule_interval_seconds`
  and `last_pull_at`** (referenced in `stream_puller.py` and `streams.ts:506`)
  — the per-stream "when" is a persisted field, exactly the persisted-timer
  pattern. This collapses N per-stream schedules to one cron job and deletes
  the ctrl-api schedule-registration code path entirely.
- This is the *same* "collapse the registrar into one sweep" move
  recommended for Steward. **The two should be done together** as the
  "retire the per-entity Temporal-schedule registrars" refactor — and that
  refactor is the prerequisite for either being cron-eligible.

Until that collapse lands, `StreamPullerWorkflow` should **not** be moved by
#48.

### 3. `SignalExtractWorkflow` / `SignalRouterWorkflow` — **SignalExtract: CRON-ELIGIBLE. SignalRouter: CONDITIONAL — see below.**

**`SignalExtractWorkflow` — cron-eligible, confirmed.** The drain is
cursor-driven: per WORKFLOW-DURABILITY.md and `register_schedules.py:862-921`,
it writes signals with a **deterministic slug (overwrite-by-path)** and marks
source events processed via a `signal_extracted_at` cursor; events without
that cursor are re-fetched next tick. The deterministic slug is the key
property — it survives a retry-less substrate because re-running the extractor
on the same source event *overwrites the same signal record* rather than
creating a duplicate. A cron tick that dies mid-batch leaves some events
un-cursored; the next 5-min tick re-extracts them, overwriting any partial
signal. **No correctness dependency on Temporal activity retries.** Caveat for
#48: the worst-case run is documented at ~1200 s (10 chunks × 120 s) — the
cron timeout (§`HERMES_CRON_TIMEOUT`) must be ≥ 25 min as the Temporal
schedule is.

**`SignalRouterWorkflow` — the `effect=mutation` path is cron-safe; the
`effect=action` path is NOT idempotent under *any* retry-less substrate, and
that is a pre-existing latent bug, not a cron regression.**

Tracing `route_signal_action` (`signal_actions.py:1336-1799`) end to end:

- There **is** an idempotency guard (line 1452): on re-entry, if the signal's
  status is already `routed_human` / `routed_agent`, it returns early without
  re-dispatching. The author added this after a real incident — *"38
  needs_attention cards from a single signal"* on david 2026-05-12.
- **But the guard only fires once `set_signal_status` has run — and that is
  step 9, the LAST step (line 1759), AFTER `dispatch_action_to_agent` at step 7
  (line 1675).** The ordering is: dispatch the agent → emit the audit record →
  *then* mark the signal `routed_agent`.
- Therefore there is a **window** — dispatch succeeded, status write not yet
  done — in which a re-run **re-dispatches the agent**. The signal is still
  `unrouted` (or `action_pending`) so the guard does not catch it. `_call_clerk`
  is a `POST /v1/runs` to Hermes; nothing about it is idempotent — a second
  call is a second real agent run that can take a second real-world action.
- **This window exists today on Temporal too.** Temporal's `RetryPolicy` (the
  `retry` with `maximum_attempts=3` in `signal_router.py`) retries the *whole
  activity* from the top on failure — so a status-write failure already causes
  Temporal to re-dispatch. The guard reduces the blast radius (it catches the
  *2-min-cadence* re-tick once status is set) but does **not** make
  action-dispatch exactly-once. Temporal does not save this path.

**Decision for `SignalRouterWorkflow`:** **conditional.** The mutation path
(`apply_signal_mutation` — `apply_state_change` is the audited idempotent
read-reason-write primitive) is cron-safe and can move. The **action path
should not move to cron until the dispatch is made idempotent at the dispatch
boundary** — and it *should* be fixed regardless, because the current ordering
is a latent double-dispatch bug Temporal only partially masks. The fix is
small and is the right thing to do before #48 touches this workflow:

- **Reorder to mark-before-dispatch with a `dispatching` intermediate status.**
  Set the signal to a non-terminal `dispatching` status *before* calling
  `dispatch_action_to_agent`, and extend the idempotency guard (line 1452) to
  also early-return on `dispatching`. Then a crashed/retried run finds the
  signal already `dispatching` and does **not** re-fire. The trade is the
  opposite failure mode — a crash *between* the `dispatching` mark and a
  successful dispatch leaves the signal stuck in `dispatching` with no agent
  run — but that is a *visible, sweepable* stuck state (a reaper or a `desk`
  surfacing), which is strictly safer than a silent double real-world action.

File this fix as a follow-up issue (below). `SignalExtractWorkflow` may move in
#48; `SignalRouterWorkflow` moves only **after** the dispatch-idempotency fix
lands.

### 4. `DecisionRouterWorkflow` — **KEEP ON TEMPORAL.** The idempotency claim is *partially* false; the conservative #47 classification is correct.

This was flagged as the highest-value item to adjudicate. Reading
`workflows/decision_router.py` + `activities/decision_router.py` end to end:

**What the docstring claims:** *"All work is per-decision idempotent (state
transitions are atomic PATCHes via ctrl-api), so a retry can't double-fire
side effects."*

**Where the claim holds:**

- The workflow only operates on `state=open` / `reversed` / `executing`
  decisions and `route_decision` re-checks `state != "open"` on entry
  (line 119) — a decision already advanced is skipped. For the **terminal,
  state-flip intents** (`done`, `defer` → `needs_attention` status flip;
  `take_mine` → `to_do` spawn) the claim is essentially true: a re-run finds
  the decision no longer `open`, or the `synchronous_flip` guard (line 117)
  short-circuits the redundant write.
- The `reversed` pass has an explicit `reversal_processed` marker
  (`decision_router.py` workflow lines 113-118; activity line 583) — a
  processed reversal is skipped. Safe.
- `check_decision_outcomes` is genuinely idempotent: it matches outcome
  signals to executing decisions and PATCHes `state=completed` — re-running
  re-matches the same pair and re-writes the same terminal state. The v2
  task-side fan-out's `propose_fn` returns `None` when the task is already
  closed (line 752-754), explicitly *"so a re-tick doesn't double-stamp"*.

**Where the claim FAILS — the `intent=delegate` path:**

- `route_decision` for `intent=delegate` with no time-bearing note (line 248)
  does `POST /api/v1/admin/needs-attention/{na_id}/dispatch` — **a real agent
  dispatch** — and *only then* (line 466) PATCHes the decision to
  `state=executing`. Identical ordering hazard to `SignalRouter`: dispatch
  is step 1, the state flip that makes the guard work is step 2. A run that
  dies (or whose activity is retried) **after the dispatch POST but before the
  decision PATCH** re-enters with the decision still `state=open` → the
  `state != "open"` guard does not catch it → **the agent is dispatched
  again.** The 60-second cadence means the *next tick* also re-runs it. The
  docstring's "a retry can't double-fire side effects" is **not true for the
  delegate dispatch**.
- This is the same class of bug as `SignalRouter` §3, and again **Temporal
  does not fully save it** — the activity-level `_ROUTE_RETRY`
  (`maximum_attempts=3`, lines 59-63) retries the whole `route_decision`
  activity from the top, so a transient ctrl-api blip on the post-dispatch
  PATCH already triggers a re-dispatch under Temporal today.

**So why keep it on Temporal anyway?** Because for `DecisionRouter` the move
to cron is **all downside, no upside**, independent of the idempotency bug:

1. **The 60-second latency budget.** `register_schedules.py:209-212` and the
   workflow docstring both state 60 s is *"the click→side-effect latency
   budget"* — when the principal clicks Delegate on the Desk, the agent must
   be dispatched within ~a minute. A cron interval honours this *only* at a
   60-s cadence, and a cron tick that is lost (gateway momentarily busy /
   restarting) pushes a *user-visible* click's effect out by the full
   downtime window with no catch-up. For an autonomous sweep that is fine; for
   a synchronous-feeling UI interaction it is a visible regression.
2. **`check_decision_outcomes` is a guaranteed-progress pass.** A delegate
   decision sits in `state=executing` until its outcome signal lands and this
   pass flips it to `completed`. On cron, an extended gateway-down window means
   delegate decisions hang `executing` indefinitely with the Desk showing a
   stale "Alfred is working" card — there is already a documented incident of
   exactly this ghost-card failure mode (`signal_actions.py:1606` comment, the
   2026-05-12 ghost cards). Temporal's crash-recovery is what bounds it.
3. **It is genuinely multi-step with three ordered passes** and real
   side-effects (agent dispatch, `to_do` spawn, reversal inversion). Even
   setting aside the latency budget, it sits closer to the
   `durability-critical` end of the spectrum than the clean sweep loops in
   #48's safe set.

**Decision: `DecisionRouterWorkflow` stays on Temporal.** The #47 doc's
conservative `durability-critical` filing is **upheld** — and the spike found a
concrete, independent reason (the delegate-dispatch idempotency hole + the
60-s UI latency budget) rather than just inheriting the default. Two
follow-ups fall out: (a) the delegate-dispatch double-fire window should be
closed with the same mark-before-dispatch fix as §3 — it is a real bug today;
(b) it is *not* worth migrating even after that fix.

### 5. `ScheduledDispatchWorkflow` — **CRON-ELIGIBLE.** Dispatch lateness is acceptable.

**Today (grounded):** `scheduled_dispatch.py` is a 30-line thin wrapper — one
`fire_due_scheduled_dispatches` activity, 15-min interval. The durable timer is
**not** a Temporal timer: it is the `execute_at` field persisted on the
`decision` record (`decision_router.py:240,246,458-460` stamps `execute_at` +
`state=scheduled`; this workflow sweeps `state=scheduled` decisions whose
`execute_at` has passed). This is the textbook **persisted-queue +
frequent-poll** pattern — the timer already survives independently of any
workflow runtime.

**The risk to weigh:** dispatch lateness = up to one cron interval + any
gateway-downtime window. For "send Adam Wednesday morning":

- "Wednesday morning" is an inherently fuzzy target — the clerk parses a
  natural-language "when" into `execute_at` (`parse_resurface_time`,
  `decision_router.py:207-217`). The principal's mental model is "sometime
  Wednesday morning," not "09:00:00." A 15-min (or even a tightened-to-5-min)
  cron poll is **well inside that tolerance**.
- A gateway-down window: the gateway is an always-on daemon; the profile-split
  ADR and #51's own framing note downtime is rare. If the gateway is down
  *across* the `execute_at` moment, the dispatch fires on the **first tick
  after recovery** — late, but **not lost**, because `execute_at` is a
  persisted field and the sweep re-discovers any still-due decision. The only
  unrecoverable case is the gateway being down for *hours* across a
  time-critical dispatch — and a delegate-with-when is by nature not
  second-critical.

**Decision: cron-eligible.** Move it. Concrete approach: one `wakeAgent: false`
script cron job on the `workers` profile, 15-min interval (matching today),
running `fire_due_scheduled_dispatches`. No registrar, no per-entity
cardinality — it is a singleton sweep over a persisted-`execute_at` queue.
This is one of the cleanest cron candidates in the whole set.

### 6. `MeetingCaptureWorkflow` — **KEEP ON TEMPORAL.**

**Today (grounded):** `meeting_capture.py`, 60-s interval, `VEXA_ENABLED`-gated.
It reads the gcal stream for Meet events starting within `LOOKAHEAD_SECONDS`
(600 s) and asks Vexa to dispatch a transcription bot. The workflow's own
docstring is honest about the durability story: *"a gateway down for >90 s
across a meeting's start window misses that meeting permanently — there is no
later tick that re-discovers a meeting already in progress."*

**The asymmetry that decides it:** unlike every other workflow in this spike,
`MeetingCapture`'s failure is **permanently unrecoverable**. Every cron-eligible
loop above self-heals because the work *persists* — un-cursored events, due
`execute_at` decisions, `unrouted` signals all wait for the next tick. A
meeting that has *started* without a bot dispatched cannot be recaptured; the
transcript for that meeting is gone forever. There is no persisted queue to
re-poll because the thing being raced is wall-clock-vs-meeting-start.

The 600-s lookahead does give a generous margin (a gateway blip well under
10 min is absorbed), and Vexa's `POST /bots` is itself idempotent. But cron's
defining property — *a lost tick is simply skipped, no catch-up* — is exactly
the wrong property when a lost tick across a meeting's lookahead window equals
a permanently lost transcript. Temporal does not make the gcal-vs-clock race
go away either, **but** it gives crash-recovery of an in-flight tick and
guaranteed re-execution, which materially shrinks the unrecoverable window.

**Decision: keep on Temporal.** This is the one `one-shot-timed` workflow where
cron's best-effort nature crosses from "acceptable lateness" into "real,
unrecoverable data loss." The cost of keeping one Temporal schedule (gated to
david-only via `VEXA_ENABLED` today) is trivial; the downside of a missed
client meeting transcript is not. `TranscriptIntakeWorkflow` — its
sibling — *is* cron-safe (the `meeting.completed` event persists in the
stream) and is already in #48's safe set; the split is correct.

### 7. `PlaneSyncNudgeWorkflow` — **DROP the workflow; replace with a plain ctrl-api HTTP call.**

**Today (grounded):** `plane_sync_nudge.py` is **not a scheduled workflow at
all** — it is event-triggered. `ctrl-api` fires it after a `matter/` or `task/`
vault write (`packages/ctrl/src/api/routes/plane.ts:257,274,1382` —
`triggerPlaneSyncNudge` shells `docker exec temporal temporal workflow start`).
Its own docstring is explicit: it is a **latency optimization** (drops
nudge→Plane from ~15 s to 1–3 s), it is **purely additive**, and *"if the nudge
fails for any reason the cron's next tick picks the record up."* The 15-s
`PlaneSyncWorkflow` is the safety net and stays `durability-critical` on
Temporal (#47 — and that classification is unchanged).

**Decision: do not make it a cron job — drop the Temporal workflow entirely
and inline its body as a direct ctrl-api call.** Reasoning:

- A cron job is the wrong primitive: the nudge is *event-triggered*, not
  cadence-driven. Putting it on cron would mean polling for "recently written
  records," which is just a slower, worse re-implementation of the
  `PlaneSyncWorkflow` cron that already exists. There is no "cron entry" shape
  for an event-triggered optimization.
- Today `ctrl-api` does `docker exec temporal temporal workflow start
  PlaneSyncNudgeWorkflow` — a Temporal round-trip whose *only* durability
  benefit is workflow-ID-reuse dedup of rapid back-to-back nudges. But the
  nudge is **best-effort by design** (the cron covers any miss), so it needs
  **no durability at all**. The whole Temporal hop is ceremony.
- The nudge body reuses `sync_matter_to_plane` / `sync_task_to_plane` and
  PATCHes `project_map` / `issue_map` on new-UUID mint. That logic can run
  **synchronously inside the ctrl-api route handler** that already detects the
  vault write — a direct in-process call (or a fire-and-forget to a
  `learn`-side HTTP endpoint), no workflow engine involved. If it fails, the
  15-s `PlaneSyncWorkflow` cron catches the record. The dedup that
  workflow-ID-reuse gave for free becomes a trivial in-memory debounce or is
  simply tolerated (a double single-record sync is idempotent — upsert by
  `plane_id`).

This is the rare case where the right #48 outcome is **delete code**, not
migrate it. `PlaneSyncNudgeWorkflow` and its `triggerPlaneSyncNudge` Temporal
shell-out both go away; the optimization becomes a plain function call.

### 8. `MediaIngestionWorkflow` — **in-process call inside the cron job that drains media events** (no separate queue).

**Today (grounded):** `media_ingestion.py` is **not scheduled** — it is a
Temporal **child workflow**. `event_processor.py:77-81` does
`workflow.execute_child_workflow("MediaIngestionWorkflow", event,
id=f"media-{event_id[:16]}")` for every `stream_type == "media"` event, then
marks the source event processed (line 83-88).

**Question:** if `EventProcessorWorkflow` moves to cron (it is in #48's safe
set), how does the cron job invoke media processing?

**Decision: in-process call, not a separate queue.** Reasoning:

- The deterministic child-workflow ID (`media-<event_id[:16]>`) gives Temporal
  exactly-once child execution today. Under cron there is no child-workflow
  primitive — and there does not need to be one, because the idempotency does
  not actually come from Temporal: it comes from the **source event staying
  un-marked-processed on failure**. WORKFLOW-DURABILITY.md's `EventProcessor`
  caveat says exactly this — *"media events also stay un-marked on failure,"*
  so a dropped media-processing run is re-discovered by the next
  `EventProcessor` tick.
- Therefore the cron `EventProcessor` job should, for a `media` event, **call
  the media-ingestion logic directly inline** (a plain function call into the
  `MediaIngestionWorkflow` activity bodies) and **only mark the source event
  processed after the inline call returns successfully**. Crash mid-media-run
  → event stays un-marked → next `EventProcessor` cron tick re-processes it.
  Same self-healing property the rest of the drain has.
- A *separate queue* would be over-engineering: it reintroduces a second
  durable component to replace the one (Temporal) being removed, for a media
  volume that is bounded (`EventProcessor` caps at 20 events/run) and where
  the source-event cursor already provides the retry semantics. Media
  processing is LLM-heavy and slow, so the inline call must run **before**
  `mark_event_processed` and the cron job's `HERMES_CRON_TIMEOUT` must be
  sized for it (a media batch can be minutes) — but that is a timeout-sizing
  task, not a queue.

One consequence to flag for #48: inline media processing makes one
`EventProcessor` cron tick potentially long (multiple media files × LLM
transcription). If that pushes past a reasonable `HERMES_CRON_TIMEOUT`, the
mitigation is to **lower the per-tick media cap** (process ≤N media events
per tick, leave the rest un-marked for the next tick) — not to add a queue.

---

## Summary table

| # | Workflow | Decision | One-line reason |
|---|----------|----------|-----------------|
| 1 | `StewardWorkflow` | **Keep on Temporal** (collapse to a single sweep workflow first; *then* cron-eligible) | Per-matter cron registrar reproduces the worst of cron — hundreds-entry flat-file `jobs.json` + a new stateful sync component. Collapse the fan-out to one sweep instead. |
| 2 | `StreamPullerWorkflow` | **Cron-eligible only after the per-stream registrar is collapsed** to one `fire_due_stream_pulls` sweep over the persisted `schedule_interval_seconds`/`last_pull_at` fields | Same per-entity dynamic-registrar anti-pattern as Steward; workflow body itself is a clean cursor-driven pull. |
| 3 | `SignalExtractWorkflow` | **Cron-eligible — move** | Deterministic-slug overwrite + `signal_extracted_at` cursor genuinely survive a retry-less substrate. (Cron timeout ≥ 25 min.) |
| 3 | `SignalRouterWorkflow` | **Conditional** — mutation path moves; action path moves only **after** a mark-before-dispatch idempotency fix | `route_signal_action` dispatches the agent *before* writing the status the idempotency guard reads → a real double-dispatch window that Temporal only partially masks. |
| 4 | `DecisionRouterWorkflow` | **Keep on Temporal** | The `intent=delegate` path has the same dispatch-before-state-flip double-fire hole; plus a 60-s *user-visible* latency budget and a guaranteed-progress outcome-poll. All downside, no upside on cron. #47's conservative call upheld. |
| 5 | `ScheduledDispatchWorkflow` | **Cron-eligible — move** | `execute_at` is a persisted field; "Wednesday morning" tolerates a 15-min poll; a gateway-down dispatch is late, never lost. Cleanest candidate. |
| 6 | `MeetingCaptureWorkflow` | **Keep on Temporal** | The only workflow whose missed tick = *permanently* lost data (a meeting transcript); no persisted queue can re-poll a wall-clock race. |
| 7 | `PlaneSyncNudgeWorkflow` | **Drop the workflow** — replace with a direct ctrl-api in-process call | Event-triggered best-effort optimization; the 15-s `PlaneSyncWorkflow` cron is the safety net. Needs zero durability — the Temporal hop is pure ceremony. |
| 8 | `MediaIngestionWorkflow` | **In-process call** inside the cron `EventProcessor` job (no separate queue) | Idempotency comes from the un-marked source-event cursor, not from Temporal's child-workflow ID. Inline call before `mark_event_processed`; size the cron timeout / cap media-per-tick. |

---

## Recommendation — what #48 should actually execute vs. defer

### #48 EXECUTABLE NOW (in addition to WORKFLOW-DURABILITY.md's already-safe set)

From this spike's eight items, the only ones #48 may move **as-is**:

- **`SignalExtractWorkflow`** → `workers`-profile cron, 5-min interval,
  `wakeAgent: false`-eligible only for the non-LLM scaffolding (the extractor
  itself is LLM-heavy, so this one *is* an agent-or-script job that calls the
  extractor — confirm the cron timeout ≥ 25 min).
- **`ScheduledDispatchWorkflow`** → `workers`-profile cron, 15-min interval,
  `wakeAgent: false` script job over the persisted-`execute_at` queue.

Plus the unconditional execution of WORKFLOW-DURABILITY.md's "clearly cron-safe
set" (the 19 + 3 chore-template workflows) — with two cross-cutting
preconditions #48 must satisfy *before* moving any of them:

1. **Audit `HERMES_CRON_TIMEOUT`** (global + per-job) so no moved workflow's
   longest-tail run is killed mid-flight. Several `learn` schedules carry
   deliberately generous Temporal timeouts (25 min, 10 min); the cron timeout
   must match the *largest* one moved.
2. **Resolve the per-job timezone question.** If Hermes cron is global-timezone
   only, the tenant-local daily jobs (`Reflection`, `NightlyMaintenance`,
   `ChorePromotion`, `DecisionPatterns`) must have their cron expressions
   rendered into UTC at registration time using `TENANT_TIMEZONE` — otherwise
   they fire at the wrong local hour. This is a hard blocker for those four.

### #48 DEFER (do NOT move in #48)

- **`StewardWorkflow`, `StreamPullerWorkflow`** — blocked on the
  "collapse the per-entity registrar into one sweep workflow" refactor. Until
  that lands, these stay on Temporal. The refactor is the actual prerequisite,
  not the cron move.
- **`SignalRouterWorkflow` (action path)** — blocked on the mark-before-dispatch
  idempotency fix. The mutation path may move; the action path waits.
- **`MediaIngestionWorkflow`** — moves *with* `EventProcessorWorkflow` as an
  inline call; it is not an independent migration. #48's `EventProcessor` cron
  job must be built to call media-ingestion inline.

### #48 KEEP ON TEMPORAL permanently (this spike's verdict)

- **`DecisionRouterWorkflow`** — durability-critical confirmed.
- **`MeetingCaptureWorkflow`** — best-effort cron is unacceptable; missed =
  permanent loss.

### #48 DELETE (not migrate)

- **`PlaneSyncNudgeWorkflow`** + its `triggerPlaneSyncNudge` ctrl-api
  shell-out — replace with a direct in-process ctrl-api call.

**Overall:** #51's premise — *"the gateway is an always-on daemon, downtime is
rare, is the risk acceptable?"* — holds for the **clean cursor/queue sweep
loops** but breaks on two distinct sub-classes the spike surfaced: (a) the
**per-entity dynamic registrars** (Steward, StreamPuller), where the *registrar*
— not the workflow — is the durability-sensitive component cron handles badly;
and (b) the **agent-dispatch paths** (SignalRouter action, DecisionRouter
delegate), which carry a pre-existing dispatch-before-status double-fire bug
that *no* retry-less substrate makes safe and that should be fixed regardless
of #37. #48's executable scope is therefore **narrower than the raw
`fixed-cadence-idempotent` count suggests**: the safe-set sweeps + 2 of these 8
items, gated on the timeout and timezone preconditions.

---

## Proposed follow-up issues (titles + one-line scope — not filed by this spike)

1. **`refactor(learn): collapse per-matter StewardWorkflow into one StewardSweepWorkflow`** — replace the `al-steward-<slug>` per-matter Temporal-schedule registrar with a single sweep over per-task `next_check_after` cursors; prerequisite for Steward cron-eligibility.
2. **`refactor(learn,ctrl): collapse per-stream StreamPullerWorkflow registration into one stream-sweep`** — replace the ctrl-api per-stream `al-stream-pull-*` schedule registration with one `fire_due_stream_pulls` sweep over the persisted `schedule_interval_seconds`/`last_pull_at` fields.
3. **`fix(learn): close the action-dispatch double-fire window in route_signal_action`** — mark the signal `dispatching` *before* `dispatch_action_to_agent` and extend the idempotency guard to it; a pre-existing latent double-dispatch bug Temporal only partially masks.
4. **`fix(learn): close the delegate-dispatch double-fire window in route_decision`** — same mark-before-dispatch fix for `DecisionRouterWorkflow`'s `intent=delegate` path (dispatch happens before the `state=executing` flip the guard relies on).
5. **`chore(learn,hermes): audit HERMES_CRON_TIMEOUT against the longest Temporal schedule timeout before any cron migration`** — ensure no moved workflow's worst-case run (signal-extract ~25 min, stream-event-purge ~10 min) is killed mid-flight.
6. **`spike(hermes): confirm Hermes cron per-job timezone support`** — verify whether `~/.hermes/cron` supports per-job timezone or global-only; if global-only, design the UTC-translation of tenant-local daily cron expressions. Hard blocker for migrating the four tenant-local daily calendar workflows.
7. **`refactor(ctrl,learn): drop PlaneSyncNudgeWorkflow, inline single-record sync into the ctrl-api vault-write path`** — remove the event-triggered Temporal workflow + `triggerPlaneSyncNudge` shell-out; replace with a direct best-effort in-process call (the 15-s PlaneSync cron is the safety net).
