# State Mutation Architecture

**Status**: spec, not yet implemented. Supersedes nothing — extends what's already there.

## 0. The principle

Every actor that mutates a matter's or task's state must follow a read-then-write contract:

1. **Read** the current state (`current_state`, `as_of`, `status`, etc.)
2. **Read** the events since `as_of` (signals, decisions, prior briefings)
3. **Reason** over both — "given what I believed at as_of, and what arrived since, should my belief change?"
4. **Write** the new state AND a `state_change` audit entry into the target's `timeline`
5. **Optionally** trigger downstream fan-out (dependency signals, Plane writes, etc.) — these are extras, not the core write

The audit entry is non-negotiable. State cannot move without provenance.

Briefings (morning + evening) are **one writer among many**. They are not special, they are not the source of truth for state — they read the post-mutation matter set and *compose a snapshot of the world as it stands*. The matter+task records are the source of truth; briefings are a periodic view.

The arc of any matter is reconstructable by replaying its `timeline`.

## 1. Glossary

| Term | Meaning |
|---|---|
| **target** | The vault record being mutated. Either `matter/<slug>.md` or `task/<slug>.md`. |
| **state field** | A field whose change requires audit provenance. Currently: `current_state`, `as_of`, `status`. Extensible (see §4). |
| **writer** | Any code path that mutates a state field on a target. |
| **source** | A dotted identifier for *who* wrote — e.g. `briefing.morning`, `nightly_narrative`, `steward.evaluate_task`, `decision_router.promote`, `task_closure.match`, `chore_actions.recompute_health`. |
| **observed window** | The `[start, end]` interval the writer considered when reasoning. Usually `[target.as_of, now]`. |
| **state_change** | A timeline entry recording one mutation, with full provenance. |
| **state_mutator** | The shared library function every writer must call. Wraps the read-reason-write-log cycle. |

## 2. State surface

Per-target inventory of state fields and which actors today touch each. **Source of truth before this spec lands** (so the retrofit knows what to wrap).

### Matter (`matter/<slug>.md`)

| Field | Type | Writers today | Notes |
|---|---|---|---|
| `current_state` | str (markdown) | `nightly_narrative` | The narrative paragraph. |
| `as_of` | ISO datetime | `nightly_narrative` | When `current_state` was last composed. |
| `status` | enum {active, dormant, completed, archived} | manual vault edits; matter-creation paths | Status field on matter records. |
| `surface_class` | enum {high, normal, low} | manual | Determines Steward cadence. State-adjacent but not strictly "state". |
| `last_briefing_at` | ISO datetime | **new — briefing composer** | Tracks when this matter was last observed by a briefing. |

### Task (`task/<slug>.md`)

| Field | Type | Writers today | Notes |
|---|---|---|---|
| `current_state` | str (markdown) | `steward.apply_state_change` (when target_kind=task) | Inline task narrative (L1 #884). |
| `as_of` | ISO datetime | `steward.apply_state_change` | When state was last evaluated. |
| `status` | enum {open, in_progress, blocked, closed, archived} | `steward.apply_state_change`, `task_closure`, archival sweep | Lifecycle. |
| `outcome` | str | `steward.apply_state_change`, `task_closure` | Why the task closed. |
| `pending_confirmation` | bool | `steward.apply_state_change` | Awaiting principal confirmation in shadow/HC-only mode. |
| `last_steward_outcome` | dict | `steward.apply_state_change` | Audit pointer. |
| `parent_matter` | path | manual; `decision_router.promote` | Linkage. State-adjacent. |

### Out of scope

- `instinct/*`, `decision/*`, `event/*`, `signal/*`, `to_do/*`, `chore/*`, `pattern_proposal/*` — these are not "matter/task state". The contract does not apply. (`chore/*` does mutate `last_run` etc., but those are recorded via `record_chore_run` which is itself an audit emitter.)
- Manual vault edits via the SaaS `/vault` editor — see §10.

## 3. What we already have

This spec does **not** invent the audit emitter. It generalizes one that exists.

### `steward.apply_state_change` (Phase 0.5, #836)

Located at `packages/learn/src/activities/steward.py:3231`. Today:
- Accepts `target_kind` ∈ {task, matter} ✓
- Has shadow/live modes with env-gated cutover (`STEWARD_LIVE_MODE`) ✓
- Writes `event/steward-action-<ts>-<slug>.md` audit records with full undo recipe ✓
- Patches target frontmatter atomically with the audit write ✓
- For tasks: posts Plane comment + state transition, with partial-apply tracking ✓
- For matters: vault-only (Plane fan-out + related-task cascade explicitly TODO'd) ✓
- Emits dependency-change signals across `related_to` ✓
- Confidence-gated (default 0.6, HC-only 0.85) ✓

What it lacks for the universal contract:
- **Steward-shaped envelope.** It takes a `decision` dict shaped for Steward's evaluator; other writers don't speak that shape.
- **No `prior_as_of` check.** It reads current frontmatter but doesn't verify the writer's read was current. No optimistic concurrency.
- **Audit record only — no `state_change` entry on the target's `timeline`.** Today the matter's timeline is composed at read time by `ctrl-api/routes/matters.ts` joining signals + events; there's no first-class state-change record IN the matter's frontmatter.
- **Not used by `nightly_narrative`.** Narrative writes go via direct `vault_client.patch_frontmatter`.
- **Not used by `task_closure`, `decision_router.promote`, `chore_actions`, `archival_sweep`.** Each writes directly.

The spec is: extend `apply_state_change` into a universal primitive, wrap every state writer in it, and add a first-class `state_change` audit entry to the target's `timeline`.

## 4. The contract

### 4.1 Universal mutator signature

New module `packages/learn/src/activities/state_mutator.py`:

```python
@dataclass(frozen=True)
class ObservedWindow:
    start: datetime          # usually target.as_of
    end: datetime            # usually now
    signal_paths: list[str]  # signals considered, in order
    decision_paths: list[str]
    other_refs: list[str]    # e.g. prior briefing path, chore run id

@dataclass(frozen=True)
class ProposedMutation:
    fields: dict[str, Any]     # ONLY state fields (see §2). API rejects others.
    reason: str                 # one-sentence-or-more human-readable
    confidence: float           # 0.0-1.0; defaults to 1.0 for deterministic writers
    fan_out: list[str] = ()    # downstream effects to trigger (e.g. "steward.related_to_resignal")

@dataclass(frozen=True)
class MutationResult:
    target_path: str
    source: str
    applied: bool                       # False if writer decided no change is warranted
    mode: Literal["shadow", "live"]
    effective_mode: Literal["shadow", "live"]   # after env override
    audit_record_path: str              # event/state-change-<ts>-<slug>.md
    timeline_entry_id: str              # uuid for the state_change timeline entry
    prior_as_of: str | None
    new_as_of: str | None
    pending_confirmation: bool
    retried_count: int                  # optimistic-concurrency retries
    fan_out_triggered: list[str]

@activity.defn
async def apply_state_change_v2(
    *,
    target_path: str,                   # "matter/foo.md" or "task/foo.md"
    source: str,                         # "briefing.morning" etc.
    observed: ObservedWindow,
    propose_fn_name: str,                # activity name to invoke for reasoning
    propose_fn_args: dict[str, Any],     # passed to the propose activity
    mode: Literal["shadow", "live"] = "shadow",
    expected_as_of: str | None = None,   # optimistic concurrency
) -> MutationResult: ...
```

Why an activity-name string for `propose_fn`? Because Temporal activities can't take callables as args. The mutator invokes the named activity via `workflow.execute_activity` inside a *child* workflow (see §6 on workflow shape) or via in-process function dispatch if invoked from a non-workflow context.

The reasoning happens *outside* the mutator. The mutator handles: read → optimistic-concurrency check → call reasoner → if mutation proposed, write atomically (frontmatter + timeline + audit record) → fan-out triggers.

### 4.2 The atomic write

A successful `applied=True` mutation produces three artefacts in a single ctrl-api call (see §5):

1. **Target frontmatter patch.** Only state fields. `as_of` is updated to `observed.end`.
2. **Timeline append.** A `state_change` entry on the target's `timeline` list.
3. **Audit record.** `event/state-change-<iso-ts>-<source-slug>-<target-slug>.md` with the full reasoning blob, observed-window paths, and (where applicable) undo recipe.

This MUST be atomic. Today's `apply_state_change` does (1) and (3) but writes them in sequence with partial-failure tolerance. The new contract is stricter — see §5 for the ctrl-api change.

### 4.3 `state_change` timeline entry shape

```yaml
- when: 2026-05-13T07:00:14Z
  kind: state_change
  id: 01HXYZABC...      # ulid for cross-reference
  source: briefing.morning
  prior_as_of: 2026-05-12T18:00:02Z
  observed_window:
    start: 2026-05-12T18:00:02Z
    end: 2026-05-13T07:00:14Z
    signals: 3
    decisions: 1
    other: ['briefing/2026-05-12-evening.md']
  changes:
    current_state: { changed: true, prior_len: 412, new_len: 487 }
    as_of: { from: '2026-05-12T18:00:02Z', to: '2026-05-13T07:00:14Z' }
    status: { changed: false }
  reason: "Three signals about the property listing arrived; buyer offer requires response. Promoting status from dormant to active."
  confidence: 0.92
  mode: live
  audit_record: event/state-change-2026-05-13T0700-briefing-morning-property-listing.md
```

Why don't we embed full `current_state` diff in the timeline? Because timelines are read every time the matter detail page loads, and verbose state diffs would balloon read cost. The audit record carries the full diff; the timeline carries the summary.

### 4.4 `state_change` audit record shape

`event/state-change-2026-05-13T0700-briefing-morning-property-listing.md`:

```yaml
---
record_type: event
event_type: state_change
target_kind: matter
target_path: matter/property-listing.md
source: briefing.morning
when: 2026-05-13T07:00:14Z
mode: live
effective_mode: live
confidence: 0.92
prior_as_of: 2026-05-12T18:00:02Z
observed_window:
  start: 2026-05-12T18:00:02Z
  end: 2026-05-13T07:00:14Z
  signal_paths: [signal/2026-05-13-buyer-offer.md, signal/2026-05-12-...md, signal/2026-05-12-...md]
  decision_paths: [decision/dec-2026-05-12-property-followup.md]
  other_refs: [briefing/2026-05-12-evening.md]
changes:
  current_state:
    prior: |-
      The property listing has been live for 14 days...
    new: |-
      Buyer offer received Wednesday morning at €4.5M...
  as_of:
    from: 2026-05-12T18:00:02Z
    to: 2026-05-13T07:00:14Z
  status:
    from: dormant
    to: active
undo_recipe:
  vault_patch:
    target_path: matter/property-listing.md
    revert_fields:
      current_state: |-
        The property listing has been live for 14 days...
      as_of: 2026-05-12T18:00:02Z
      status: dormant
  expires_at: 2026-05-20T07:00:14Z
fan_out_triggered: ['steward.related_to_resignal']
---

# State change

[Reason markdown body, optional richer context]
```

The `undo_recipe` mirrors what `steward.apply_state_change` already produces for tasks — extended uniformly.

### 4.5 Mode resolution

Same as today's `apply_state_change`. Caller's `mode` is intent; `STEWARD_LIVE_MODE` env is the operator veto.

| caller `mode` | env `STEWARD_LIVE_MODE` | effective | Plane writes? |
|---|---|---|---|
| shadow | * | shadow | no |
| live | shadow | shadow | no |
| live | live | live | yes if `confidence ≥ 0.6` else `pending_confirmation` |
| live | live_high_confidence_only | live | yes if `confidence ≥ 0.85` else `pending_confirmation` |

We extend the env's meaning: today it gates Plane writes. Under the new contract it also gates `state_change.applied`. Sub-threshold writes still write the audit record (so reviewers see what was proposed), but don't touch target frontmatter.

This means **shadow mode is now genuinely safe for all writers**, not just Steward. We can ship the universal mutator under env=shadow on day one, validate the audit trail, then flip to live.

## 5. ctrl-api enforcement

The contract is enforceable at the data layer. The vault PATCH endpoint refuses to mutate state fields without provenance.

### 5.1 New endpoint: `POST /api/v1/state-changes`

Replaces direct PATCH for state fields on matter/task records.

```http
POST /api/v1/state-changes
Authorization: Bearer ...
Content-Type: application/json

{
  "target_path": "matter/property-listing.md",
  "source": "briefing.morning",
  "expected_as_of": "2026-05-12T18:00:02Z",
  "observed_window": {...},
  "fields": {
    "current_state": "...",
    "as_of": "2026-05-13T07:00:14Z",
    "status": "active"
  },
  "reason": "Three signals...",
  "confidence": 0.92,
  "mode": "live",
  "undo_recipe": {...}
}
```

ctrl-api side:
1. **Read** target. If `expected_as_of` is set and doesn't match current `as_of` on disk → return `409 Conflict` with current `as_of`. Caller retries the read-reason-write cycle.
2. **Validate** `fields` contains only declared state fields. Reject otherwise.
3. **Validate** `source` matches `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$` (forces dotted identifier).
4. **Atomic write** (single fs operation per record):
   - Patch target frontmatter (`fields` merged in)
   - Append `state_change` to target's `timeline` array
   - Write `event/state-change-<ts>-<source>-<slug>.md` audit record
5. Return `{audit_record_path, timeline_entry_id, new_as_of}`.

The atomicity is achieved by writing all three files under a per-tenant file lock. The vault is single-writer per-process; we rely on a small flock around the multi-file write.

### 5.2 Enforcement on the legacy PATCH endpoint

`PATCH /api/v1/vault/records/matter/<slug>` and `task/<slug>`:

- **Phase 1 (warning)**: if the patch touches `current_state` / `as_of` / `status`, log a warning with the caller's user-agent. Still accept it. This buys us a deploy window to retrofit writers.
- **Phase 2 (rejection)**: same patch returns `403 Forbidden` with a body explaining `POST /state-changes` is required for state fields. Manual vault edits via the SaaS editor bypass this via a `?via=manual` flag (see §10).

A flag flip on the env (`STATE_CHANGE_ENFORCEMENT=warn|reject`) switches between phases.

### 5.3 Reading state-change history

`GET /api/v1/state-changes?target=&source=&since=&limit=`

Reads from the union of every matter's and task's `timeline.state_change` entries (mtime-cached). Used by:
- /decisions page "State changes" tab
- /matters/:id detail page (inline in timeline)
- /tasks/:id detail page
- Debugging "why did this state move?"

The audit records are also discoverable by file path glob (`event/state-change-*`), but the indexed view is faster.

## 6. Temporal-side: workflow shape

Reasoning has to happen somewhere. The mutator activity itself is deterministic plumbing (read → patch → log); the reasoning is an LLM-or-deterministic function.

Two patterns, depending on caller:

### 6.1 Pattern A: writer is already inside a workflow

The writer's workflow calls (in order):
1. `state_mutator.read_target(path) -> {current_state, as_of, status, ...}`
2. `state_mutator.gather_observed(target, since=as_of) -> ObservedWindow`
3. **Reason** — execute writer-specific activity that proposes a mutation (e.g. `nightly_narrative.propose_matter_narrative`, `briefing.propose_matter_update`, `task_closure.propose_close`)
4. If propose returns None → done, no write.
5. `state_mutator.write(target, source, observed, proposed, mode, expected_as_of=read_step.as_of) -> MutationResult`
6. On 409 from ctrl-api: re-execute step 1 (read again) and retry — bounded at 3 attempts.

Each step is its own activity. The workflow stitches them deterministically.

### 6.2 Pattern B: writer is an activity, not a workflow

E.g. Steward's `evaluate_task` is itself `@activity.defn`. It needs to invoke the mutator without spinning up a child workflow.

`state_mutator.apply_state_change_v2` is exposed as a regular `async def` callable (in addition to its `@activity.defn` wrapping). When called from inside another activity, it executes in-process. This is consistent with how `apply_state_change` works today.

### 6.3 Temporal replay safety

This is the gnarliest part. Per `packages/learn/CLAUDE.md`:

- Adding new `workflow.execute_activity()` calls inside an existing `@workflow.run` is non-additive → requires `workflow.patched("...")`.
- Renaming activities → backwards-compat `@activity.defn(name="old_name")` shim.

The retrofit plan (§7) takes pains to avoid both:

| Workflow | Change | Patched? |
|---|---|---|
| Steward | `evaluate_task` (activity) internally switches from `apply_state_change` to `apply_state_change_v2` | No — activity internals are free to change |
| nightly_narrative | Workflow currently calls direct PATCH activities; retrofit adds new activity calls | **Yes — `workflow.patched("nightly_narrative_state_mutator_v1")`** |
| task_closure | Same | **Yes — `workflow.patched("task_closure_state_mutator_v1")`** |
| decision_router | Same | **Yes — `workflow.patched("decision_router_state_mutator_v1")`** |
| Briefing chore | New workflow | No — fresh history |

The patched gates ship in the same commit that adds the activity calls. We do NOT retroactively wrap unpatched code in a later deploy (per the in-file warning in `signals.py`).

`apply_state_change` (v1) is **not** renamed or removed. It stays as a backwards-compat shim that delegates to v2 with a fixed Steward-shaped envelope, so in-flight Steward histories continue to replay. The v1 shim is marked `@deprecated` in docstring and removed after one quarter of clean run.

## 7. Inventory of writers and retrofit plan

Every code path that touches matter/task state, with its retrofit shape. **Each row is a discrete task in the rollout.**

| # | Writer | File | Today | Retrofit |
|---|---|---|---|---|
| W1 | Steward `evaluate_task` | `activities/steward.py:2118` | Calls `apply_state_change(target_kind=task)` | Switch to v2; activity-internal change, no workflow patch |
| W2 | Steward matter-context edits (Phase 0.5 TODO) | `activities/steward.py` | Not yet wired | Implement directly through v2 |
| W3 | `nightly_narrative` workflow | `workflows/nightly_narrative.py` | Direct vault PATCH | Wrap in v2 with `workflow.patched("nightly_narrative_state_mutator_v1")`; source=`nightly_narrative` |
| W4 | `task_closure` watcher | `activities/task_closure.py` + workflow | Direct frontmatter writes when closing tasks | Route through v2; source=`task_closure.match` |
| W5 | Archival sweep | (TASK-LIFECYCLE-1) workflow | Sets `status=archived` directly | v2; source=`archival_sweep` |
| W6 | DecisionRouter promote-triage-to-task | `workflows/...decision_router` | Creates task records, sets matter linkage | v2 on the matter side when linkage changes; **not** required for fresh task creation (creation is not a mutation) |
| W7 | DecisionRouter outcome linkage (ARCH-6) | same | Sets task `outcome` + `status=closed` | v2; source=`decision_router.outcome_link` |
| W8 | DecayWatcherWorkflow | `workflows/...decay` | Adjusts `surface_class` (state-adjacent) | Add `surface_class` to declared state fields (§2); v2; source=`decay_watcher` |
| W9 | `chore_actions.recompute_matter_health` etc. | `activities/chore_actions.py` | Some chore actions touch matter state | v2; source=`chore_actions.<action_name>` |
| W10 | `task_creation` | `activities/task_creation.py` | Creates tasks (not state mutations on existing) | No retrofit — creation ≠ mutation. But `parent_matter` linkage on the matter side IS a mutation; route through v2. |
| W11 | `plane_reverse_sync` | `activities/plane_reverse_sync.py` | Mirrors Plane state changes back into vault | v2; source=`plane_reverse_sync` (Plane is the canonical writer in this direction) |
| W12 | `onboarding_pipeline` | `workflows/onboarding_pipeline.py` | Seeds initial matter/task state | Source=`onboarding`; arguably initial seed isn't "mutation" but for uniformity, route through v2 with `prior_as_of=null` |
| W13 | Manual vault edits via SaaS `/vault` editor | ctrl-api `PATCH /vault/records/...` | Direct PATCH | The editor sends `?via=manual` + a `reason` field the principal types; ctrl-api converts to a v2 state-change call internally with source=`manual.<user_id>` |
| W14 | **NEW — Briefing composer** | `workflows/briefing.py` (new) | — | Native v2 caller; source=`briefing.morning` or `briefing.evening` |

Ordering of the retrofit shipping is constrained by the enforcement flag flip (§5.2). Until every writer is on v2, enforcement stays `warn`.

## 8. Briefings as a state-mutating chore

With the universal contract in place, briefings are unremarkable.

### 8.1 Two chores, one workflow

`daily-morning-briefing` and `daily-evening-digest` both invoke the same workflow with a `slot` parameter:

```python
@workflow.defn
class BriefingWorkflow:
    @workflow.run
    async def run(self, slot: Literal["morning", "evening"]) -> str:
        prior = await execute_activity(get_prior_briefing, args=[slot])
        window_start = prior["composed_at"] if prior else (workflow.now() - timedelta(hours=24))
        window_end = workflow.now()

        matters = await execute_activity(list_active_matters)
        results: list[MutationResult] = []
        for m in matters:
            r = await execute_activity(
                briefing_visit_matter,    # writer-specific propose+apply
                args=[m["path"], slot, window_start, window_end],
            )
            results.append(r)

        brief_record_path = await execute_activity(
            compose_and_write_briefing,
            args=[slot, window_start, window_end, results],
        )

        await execute_activity(
            record_chore_run,
            args=[f"daily-{slot}-briefing", f"composed {brief_record_path}"],
        )
        return brief_record_path
```

`briefing_visit_matter` is the activity that does the read-reason-write per matter through `state_mutator.apply_state_change_v2`. Its `propose_fn` calls clerk with:
- The matter's current_state + as_of
- The signals + decisions + prior briefing in the window
- A prompt that asks: "Has anything happened that changes how this matter stands? If yes, write the new state. If no, return null."

### 8.2 Briefing record schema

New record_type `briefing`. Add to ctrl-api `KNOWN_TYPES` + frontmatter validator.

`briefing/2026-05-13-morning.md`:

```yaml
---
record_type: briefing
slot: morning
composed_at: 2026-05-13T07:00:14Z
prior_briefing: briefing/2026-05-12-evening.md
window:
  start: 2026-05-12T18:00:02Z
  end: 2026-05-13T07:00:14Z
observed:
  matters:
    - path: matter/property-listing.md
      state_changed: true
      state_change_audit: event/state-change-2026-05-13T0700-briefing-morning-property-listing.md
    - path: matter/health.md
      state_changed: false
  signals_count: 12
  decisions_count: 1
chore_run: alfred-data/chore-run-history.jsonl#daily-morning-briefing@2026-05-13T07:00
---

# Morning brief — Wednesday 13 May

[Composed body — letterpress prose, references matters by wikilink]
```

The briefing's `observed.matters[]` is the join key. To see "what did the briefing change about this matter?", click through to `state_change_audit`.

### 8.3 What changed about state changes is decoupled from what gets written into the brief body

The composer makes two passes:
1. **Mutation pass.** Walk each matter, propose+apply state changes through v2. This is where state actually moves.
2. **Composition pass.** Re-read every matter (post-mutation) and compose the brief body from the *current* state.

The brief body is therefore always consistent with on-disk state at `composed_at`. Even if a matter mutated *during* the mutation pass, the composition pass reads the freshly-written state. Two-phase write avoids "the brief said X but the matter says Y" drift.

### 8.4 Cadence configuration

Currently chore frontmatter has `schedule` (5-field cron). Per-user cadence is just editing this cron — already supported at the API level (PATCH the chore vault record).

UI: add a Schedule editor to `/chores/:slug` with:
- 5-field cron input + human description ("Daily at 7am UTC")
- Pre-canned options: Daily, Twice daily (morning + evening), Weekdays only, Custom
- Preview of next 5 fire times computed from the same cron parser already in ctrl-api (`packages/ctrl/src/api/cron.ts`)

This is UX work; no backend changes required.

### 8.5 What happens to DailyDigestWorkflow

Today's `workflows/daily_digest.py` produces the daily brief at 6pm via a separate path. After BriefingWorkflow is live:

1. Retire the standalone DailyDigestWorkflow schedule.
2. Move any logic unique to DailyDigestWorkflow (e.g. its prompt voice for evening brevity vs morning expansiveness) into `compose_and_write_briefing(slot=evening)`.
3. /brief route already reads "the most recent brief" — point it at the most-recent `briefing/*.md` record. The schema is similar enough; map the fields.
4. Keep DailyDigestWorkflow registered but unscheduled for one quarter, in case we need to roll back. After that quarter, remove.

### 8.6 What happens to nightly_narrative

After retrofit (W3), `nightly_narrative` still runs nightly at 2am, still produces matter narratives. The difference is it now goes through `state_mutator.apply_state_change_v2` with `source=nightly_narrative`. Briefings are not its replacement — they cover an overlapping but distinct cadence (morning + evening, oriented to what the principal needs to see at start/end of day).

Question raised in conversation: "should we tie state mutation to briefings or keep them separate writers?" Answer: separate. `nightly_narrative` stays. Briefings are additional. Both go through the same contract. If a matter mutates twice in one day (once by `nightly_narrative` at 2am, once by `briefing.morning` at 7am, plus maybe a `task_closure.match` at noon), that's three `state_change` entries in its timeline — fully auditable.

## 9. Concurrency

Two writers may race on the same matter (e.g. briefing.morning and a task_closure that fires from a 7am inbound email).

### 9.1 Optimistic concurrency

Every v2 call passes `expected_as_of`. ctrl-api rejects with `409 Conflict + current_as_of` if mismatch. Caller retries the read-reason-write cycle.

Retries are bounded at 3. If all three fail (genuine high-write-rate contention), the writer's workflow logs `state_mutator.retry_exhausted` and surfaces the failure; the next scheduled tick picks it up.

### 9.2 Why not pessimistic locking?

ctrl-api is single-process per tenant. We could trivially flock per file. But: (a) state-change-rate per matter is low (single-digit per day even on hot matters), so 409 retries are rare; (b) pessimistic locking blocks LLM-bound reasoning behind serializable ordering, which slows briefing composition by 5-10x; (c) optimistic gives us a clean failure surface for surfacing genuine conflicts.

### 9.3 Atomic write inside ctrl-api

The three artefacts of one state-change (frontmatter patch, timeline append, audit record write) MUST be atomic *within* the ctrl-api process. We achieve this with a per-tenant `vault.lock` flock around the multi-file write. The lock is held for <50ms typically (three small writes); contention is rare.

If the process crashes mid-write, we may end up with the frontmatter patched but the audit record missing. Mitigation: a startup-time `vault_integrity_check` activity walks each matter's timeline, confirms every `state_change.audit_record` resolves to an on-disk file, and surfaces orphans as `event/integrity-violation-*.md` for manual triage. Hopefully zero hits ever.

## 10. Manual vault edits

The principal can edit a matter's `current_state` directly via the SaaS `/vault` editor. This is a state mutation by a human. The contract still applies.

UX:
- When the editor saves a state-field edit, the SaaS frontend shows a small "Why are you changing this?" textarea (free-form, optional).
- The SaaS proxy converts the save into a `POST /state-changes` call with `source=manual.<user_id>`, `reason=<textarea>` (defaulting to "Manual edit — no reason given" if blank), `confidence=1.0`, `mode=live`.
- The audit record gets written and the timeline gets a `state_change` entry just like any other writer.

Manual edits to non-state fields (e.g. `title`, `tags`) continue to use the legacy PATCH endpoint without the envelope.

## 11. Observability

### 11.1 Endpoints

- `GET /api/v1/state-changes` — paginated feed of all state changes, filterable by `target`, `source`, `since`, `until`. Powers /decisions "State changes" tab.
- `GET /api/v1/matters/:slug` — already returns `timeline`; that timeline now includes `state_change` kind entries.
- `GET /api/v1/state-changes/sources` — distinct sources seen in the last 30 days, with counts.

### 11.2 UI

- **/matters/:id detail page** — timeline already renders; add `state_change` as a recognized kind with a special icon (a small marker) and inline summary (source · reason · confidence).
- **/decisions page** — new tab "State changes" — chronological list of all state changes across all matters and tasks. Filter pills by source.
- **/desk** — no change. State changes are background plumbing, not Desk cards.

### 11.3 Health metrics

Add to /admin observability:
- `state_changes_per_day_by_source` — sparkline. Sudden zero from a source = writer is broken.
- `state_change_409_retry_rate` — % of v2 calls that hit a 409. Sustained >5% means we have a contention problem.
- `pending_confirmation_count_by_source` — how many sub-threshold writes are stacking up waiting for principal confirmation.

## 12. Rollout phases

Each phase is shippable and verifiable independently.

### Phase A — Schema & primitive
1. Add `state_change` to matter+task timeline schema (validator, types).
2. Add `record_type: briefing` to ctrl-api `KNOWN_TYPES` + validator.
3. Add `surface_class` to the declared state-field list on matter records.
4. Build `state_mutator.py` with v2 signature, ObservedWindow, ProposedMutation, MutationResult dataclasses.
5. Build ctrl-api `POST /state-changes` endpoint. Atomic three-artefact write. Enforce field allowlist. 409 on as_of mismatch.
6. Build ctrl-api `GET /state-changes` listing endpoint.
7. Set `STATE_CHANGE_ENFORCEMENT=warn` on the legacy PATCH endpoint.

**Smoke**: end-to-end POST /state-changes from curl on david creates audit record + timeline entry + frontmatter patch atomically. 409 round-trip works.

### Phase B — Retrofit Steward to v2
8. Refactor `steward.apply_state_change` body into `apply_state_change_v2`. The v1 name becomes a thin shim that takes the Steward-shaped decision dict and translates to v2.
9. Verify Steward Phase 0.5 shadow audit records still come out identical (byte-for-byte if possible).
10. Add `state_change` timeline appends to Steward's writes (this is new — today's apply_state_change only writes the event/* audit; under v2 the matter/task timeline also gets the entry).

**Smoke**: Steward shadow tick on david — confirm both audit record + timeline entry land; confirm matter detail page renders the timeline entry.

### Phase C — Retrofit `nightly_narrative` (W3)
11. Add `workflow.patched("nightly_narrative_state_mutator_v1")` gate.
12. Inside patched branch: build `propose_matter_narrative` activity that reads + reasons + returns ProposedMutation. Wrap in v2.
13. Old unpatched branch keeps current behaviour.
14. Backfill the next nightly run on david; observe audit records.

**Smoke**: next 2am nightly_narrative run produces a state_change audit per matter that changed. Matter timeline shows entries with source=`nightly_narrative`.

### Phase D — Retrofit remaining writers (W4-W12)
For each: gate with `workflow.patched(...)`, build propose activity, route through v2. Ship one writer per PR.

### Phase E — Briefings (W14)
15. Build `BriefingWorkflow` from §8.1.
16. Build `compose_and_write_briefing` activity. Wire to clerk.
17. Update `daily-morning-briefing` and `daily-evening-digest` chore records to point at the new workflow.
18. Add `record_type: briefing` rendering to /matters detail page timeline (so briefing visits show up).
19. Add /briefings index page in SaaS (chronological list of briefing records, expandable bodies).
20. Wire /brief to read most-recent briefing instead of legacy DailyDigest output.

**Smoke**: trigger briefing manually on david. Confirm: state_changes for matters that warranted updates, briefing record written, /brief page renders new content.

### Phase F — Manual edits
21. Update SaaS `/vault` editor: when state field is touched, show reason textarea, route through `POST /state-changes`.

### Phase G — Enforcement flip
22. Verify every writer is on v2. Audit by grepping for direct PATCH of state fields outside `state_mutator.py`.
23. Flip `STATE_CHANGE_ENFORCEMENT=reject` on david.
24. Watch warning logs for 7 days. Any direct-PATCH-rejection means a missed writer; fix and reflip.
25. After 7 clean days: roll to remaining tenants.

### Phase H — Retire DailyDigestWorkflow
26. After 1 quarter of clean briefings on all tenants: delete DailyDigestWorkflow + its activities. Remove the scheduled trigger first; wait one cycle; then delete code.

### Phase I — UX polish
27. /chores/:slug Schedule editor (cron input + preview + presets).
28. /matters/:id timeline: render `state_change` entries with reason + source + audit link.
29. /decisions State Changes tab.
30. Admin observability dashboard panels.

## 13. Failure modes (catalog)

| Mode | Symptom | Detection | Mitigation |
|---|---|---|---|
| Writer skips v2 and patches directly | State moves with no audit record | Phase G enforcement rejects; warning logs in Phase 1 | Code review + grep lint in CI |
| Mid-write crash | Frontmatter patched, audit/timeline missing | `vault_integrity_check` startup walk | Manual triage from `integrity-violation` events |
| 409 retry exhaustion | Writer logs retry_exhausted; no state change | `state_change_409_retry_rate` metric | Investigate contention; bump retry bound or fix racing writer |
| Clerk timeout during propose | Briefing workflow times out per-matter | Per-matter activity timeout; matters skipped logged | Continue with remaining matters; next briefing picks up |
| Source string typo | Audit records pile up under wrong source name | sources endpoint shows unexpected new source | Manual rename via `event/*` patch + correction note |
| Sub-threshold writes accumulate pending_confirmation | Stale pending tasks pile up | `pending_confirmation_count_by_source` metric | Surface on Desk as "X items await confirmation"; principal clears in bulk |
| undo recipe expires (>7 days) | Old state changes can no longer be reverted | UI shows undo button disabled past 7d | Document in /decisions; principal can still manually edit |

## 14. Tests

| Layer | Test | Lives in |
|---|---|---|
| `state_mutator` unit | Read-reason-write happy path | `packages/learn/tests/test_state_mutator.py` |
| `state_mutator` unit | propose returns None → no PATCH, no audit | same |
| `state_mutator` unit | 409 retry, succeeds on 2nd attempt | same |
| `state_mutator` unit | 409 retry exhausted → raises | same |
| `state_mutator` unit | mode downgrade by env veto | same |
| ctrl-api integration | POST /state-changes atomic three-artefact write | `packages/ctrl/tests/api/state_changes.test.ts` |
| ctrl-api integration | 409 on as_of mismatch | same |
| ctrl-api integration | reject patch to non-state field via state-changes | same |
| ctrl-api integration | legacy PATCH with state field → warn in Phase 1, reject in Phase G | same |
| BriefingWorkflow integration | 3 matters, mock clerk → 2 mutations, 1 no-mutation, brief composed | `packages/learn/tests/workflows/test_briefing.py` |
| BriefingWorkflow integration | Two-phase write — composition reads post-mutation state | same |
| Steward regression | Existing test suite still green after v1→v2 shim | `packages/learn/tests/test_steward.py` (existing) |
| End-to-end smoke | curl POST → matter timeline includes state_change | `scripts/smoke-test.sh` (extended) |

## 15. Open questions (parked)

1. **State-change cap per matter timeline.** If `matter.timeline` grows unbounded, matter detail reads get slow. Today's timeline composition is mtime-cached, so this only hurts editors. Cap or archive at, say, 200 entries with overflow to `event/timeline-archive-<matter>-<yyyy-mm>.md`? Park until first hot matter actually accumulates.
2. **State-change *outside* matter/task.** Decisions don't really mutate after creation, but `decision.outcome` is set when the cascade closes. Bring `decision/*` into the contract? Probably yes, but as a Phase J after the main rollout.
3. **Cross-tenant.** This spec is per-tenant. The shared SaaS plane has no state-change concept (it has its own `Activity` model in Postgres). Not bridging.
4. **State-change replay for "what would happen if".** Could in principle replay a matter's timeline against a hypothetical writer set to preview "what would the briefing do?". Not in scope.
5. **Pattern proposals as observable input.** If a pattern-proposal gets accepted between briefings, should the briefing reason over it? Today: yes, because it shows up as a new `event/pattern-accepted-*` — list these in `ObservedWindow.other_refs`.
6. **Steward's `surface_class` decay vs `state_change`.** Today DecayWatcher adjusts `surface_class` directly. After retrofit (W8), surface_class moves are state_changes. Is that the right granularity, or should decay be silent? Sir's call. Default: yes, decay is observable.

## 16. Dependencies

This spec depends on, and respects:

- **L0/L1 #884** — matter+task `current_state` schema (already shipped).
- **ARCH-1..14** — decision record schema, DecisionRouter, outcome linkage.
- **TASK-LIFECYCLE-1..5** — closure + dedupe + decision_origin.
- **OBS-1..8** — observation extractor + pattern proposals.
- **Decay system** — surface_class adjustments.
- **`apply_state_change` Phase 0.5 + Phase 3** — the audit emitter we generalize.
- **`record_chore_run`** (Phase 1 chore work) — emits to chore-run-history.jsonl; we link briefings to chore runs.
- **mtime-keyed cache** — `matters/:slug` read path; new state-changes invalidate the cache via mtime bump.
- **ctrl-api `KNOWN_TYPES` + frontmatter validator** — needs `briefing` and `state_change` entries.
- **`packages/learn/CLAUDE.md` Temporal replay rules** — every workflow retrofit follows the patched-gate discipline.

## 17. Non-goals (explicit)

- Replacing the matter timeline composition logic in `ctrl-api/routes/matters.ts`. That stays as it is; we just add `state_change` as another source the composer reads.
- Centralizing all state mutation through a single Temporal workflow. The contract is the API, not the topology.
- Making briefings the sole source of truth for matter state. They are one writer.
- Removing nightly_narrative. It stays, retrofitted.
- Making Steward's confidence formula universal. Other writers default to `confidence=1.0` (deterministic logic + LLM reasoning that the writer trusts); confidence gating remains a Steward-specific safety belt.

## 18. Steward's per-task emitter is shadow-by-design (#378)

`steward.py`'s per-task `apply_state_change(..., mode="shadow")` call (the
Phase 0.5 audit emitter, ~line 2840) **hardcodes shadow and deliberately
bypasses the `state_mutator_mode` resolver**. The `/study` "Agent
autonomy" toggle therefore does NOT govern this path — Steward's per-task
sweep only ever writes audit rows, never frontmatter. This is a safety
choice, not an oversight: flipping Steward's high-volume sweep to live
mutation is a behavior change the principal must opt into knowingly (it
would touch every task the sweep visits, versus the state_mutator's
scoped, confidence-gated transitions). If that opt-in is ever wanted,
route the call through the same resolver `state_mutator` uses and add a
DEDICATED settings key — do not silently widen `state_mutator_mode` to
cover it.
