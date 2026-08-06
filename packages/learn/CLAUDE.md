# Alfred Learn — Claude Code Context

## What This Is
Alfred Learn is the Python + Temporal intelligence layer. It runs as the
`alfred-learn` compose service alongside ctrl-api, hermes and temporal.

## Read First
- **`CONTRACT.md`** — the CURRENT contract: workflows, activities, schedules,
  configuration. Regenerated against `src/worker.py` +
  `scripts/register_schedules.py`. **This is the source of truth. Start here.**
- `SPEC.md` — HISTORICAL day-1 design doc. Kept for rationale only; several of
  the workflows it specifies (`JudgmentWorkflow`, `SessionTrackerWorkflow`)
  were deleted. Do not build against it.

## Key Constraints
- Python 3.12, temporalio SDK, httpx, pyyaml — no other dependencies without
  justification.
- **All LLM calls go through the Hermes gateway** (`activities/clerk.py`).
  NEVER call a provider API directly. The runtime is Codex-only.
  - workers profile (`:18790`) — the default for clerk traffic
  - heavy profile (`:18791`) — Reflection (`clerk_reflect`) and onboarding
  - main (`:18789`) is Sir's live chat and is never a clerk target
  - the gateway URL setting is still named `OPENCLAW_GATEWAY_URL` for legacy
    reasons; it points at `http://hermes:18789`
- **All vault writes go through ctrl-api** (`utils/vault_client.py`) — never
  direct filesystem writes from Python.
- Trust model is non-negotiable: Temporal=when, Python=structure, LLM=creative
  only.
- Terminology: observation (not cognition), instinct (not skill), intuition
  (not skill-graph), reflection (not synthesis), judgment (not router),
  discretion (not confidence gate), clerk (not subken).

## Monorepo Paths That Integrate With This
- `packages/ctrl` — tenant API (port 3100). Vault routes, state routes,
  workflow routes.
- `packages/web` — the Wasp dashboard. (There is no `packages/saas`.)
- `packages/hermes` — the Hermes runtime image; gateways on 18789/18790/18791.

## Temporal Task Queue
`alfred-learn` — every workflow uses this queue.

## Workflows
`src/worker.py` registers ~46 workflow classes and the live tenant runs ~36
Temporal schedules. **Do not maintain a list here — it goes stale.** Read
`CONTRACT.md`, or ask the box:

```sh
docker exec alfred-black-temporal-1 temporal schedule list --address temporal:7233
```

Deleted, despite what older docs claim: `SessionTrackerWorkflow` ("session"
was never a canonical vault type) and `JudgmentWorkflow` (its activity module
was removed with it).

## Temporal workflow rewrites

Temporal replays workflow history deterministically. Renaming an activity, reordering logic inside a workflow, or changing a workflow signature breaks replay for in-flight workflows started under the old code, surfacing as `NonDeterministicError` and stalling them until manually terminated.

Before merging any PR that touches `packages/learn/src/workflows/**` or `packages/learn/src/activities/**`, confirm:

- No activity renamed without a backwards-compat shim under the old name (`@activity.defn(name="old_name")`)
- No workflow signature change that breaks history replay (params added/removed/reordered)
- Logic-order changes inside a workflow gated with `workflow.patched(<name>)` or `use_compatible_version()`
- New activities registered in `packages/learn/src/worker.py`
- Pre-deploy plan documented for in-flight workflows: terminate, drain, OR rely on patched-version compat
- Tested locally with a workflow started under old code + replayed under new code, if the change is non-additive

Worked example: PR #628 (paginate `plane_sync.fetch_changed_tasks`) renamed activities and rewrote workflow logic without `workflow.patched()`. In-flight workflows hit `NonDeterministicError` post-deploy on two tenants, stalled for 12+ minutes, and required manual termination.

### Adding NEW activity calls is just as load-bearing as renames

Adding a new `workflow.execute_activity()` inside an existing `@workflow.run` is the SAME class of non-additive change as renaming — replay of pre-deploy history will diverge (old history has no record of the new activity, new code expects it). Use `workflow.patched()` even when the change "feels" additive:

```python
if workflow.patched("signal_extract_obs_v1"):
    await workflow.execute_activity(extract_observation_from_signal, ...)
```

Near-miss example: commit `289d6e2` (OBS-2) added `extract_observation_from_signal` to `SignalExtractWorkflow.run` unconditionally. No production incident because the schedule uses `overlap=SKIP` and each run completes in seconds, so no in-flight workflow spanned the deploy boundary — but the contract was violated. Future modifications to `signals.py:SignalExtractWorkflow.run` must use `workflow.patched()` for any new activity calls. See the in-file warning comment near the OBS-2 hook.

### Retroactively wrapping deployed unconditional code is unsafe

Once a non-gated change ships, adding a `workflow.patched("foo")` around it in a later commit *also* breaks replay: old history has the unconditional activity call but no patch marker, and the new code will skip the call on replay because `patched()` returns `False` for histories without the marker. The only safe options after the fact are (a) leave the contract violation in place and document it, or (b) terminate-and-restart all in-flight runs of the affected workflow before deploy. Never silently re-wrap.
