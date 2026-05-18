# Alfred Learn — Claude Code Context

## What This Is
Alfred Learn is a Python + Temporal Docker container that provides Alfred Black's self-improving intelligence layer. It sits alongside existing tenant Docker services (openclaw, temporal, alfred, alfred-ctrl).

## Read First
- `docs/SPEC.md` — full production spec. This is the source of truth. Read it in full before writing any code.
- Build exactly what the spec says. No improvisation on architecture or naming.

## Key Constraints
- Python 3.12, temporalio SDK, httpx, pyyaml — no other dependencies without justification
- All LLM calls go through OpenClaw gateway (clerk.py) — NEVER direct Anthropic API
- All vault writes go through alfred-ctrl API (vault_client.py) — NEVER direct filesystem writes from Python
- Trust model is non-negotiable: Temporal=when, Python=structure, LLM=creative only
- Terminology: observation (not cognition), instinct (not skill), intuition (not skill-graph), reflection (not synthesis), judgment (not router), discretion (not confidence gate), clerk (not subken)

## Monorepo Paths That Integrate With This
- `packages/ctrl` — tenant API (port 3100). Vault routes, streams routes, workflow routes
- `packages/saas` — SaaS platform (Wasp/Prisma). Streams dashboard, webhook receiver
- `packages/openclaw` — OpenClaw Docker image. Gateway at port 18789

## Environment Variables
- TEMPORAL_HOST=temporal:7233
- OPENCLAW_GATEWAY_URL=http://openclaw:18789
- OPENCLAW_GATEWAY_TOKEN_FILE=/alfred-data/.gateway-token
- VAULT_PATH=/vault
- TASK_QUEUE=alfred-learn
- ALFRED_LEARN_ENABLED=true

## Temporal Task Queue
`alfred-learn` — all 6 workflows use this queue

## 6 Workflows
1. EventProcessorWorkflow — schedule: every 2 min. Simplified: fetch events → drop raw content to inbox → mark processed. No LLM classification — the curator handles everything.
2. SessionTrackerWorkflow — schedule: every 5 min
3. BriefingWorkflow — schedules: `chore-briefing-morning` (cron `0 5 * * *`, tenant-local) and `chore-briefing-evening` (cron `0 17 * * *`, tenant-local). Same workflow class, dispatched with `slot="morning"` or `slot="evening"`. Visits every active matter through `state_mutator.apply_state_change_v2`, then composes the brief body from the freshly-written `current_state` paragraphs and writes a snapshot to `briefing/<YYYY-MM-DD>-<slot>.md`. The SaaS `/brief` page reads those records via the `getBriefing` operation. (Replaced the old `DailyDigestWorkflow` / `DailyMorningBriefingWorkflow` / `DailyEveningDigestWorkflow` trio in commit f20556d.)
4. LearningWorkflow — schedule: every 5 min
5. ReflectionWorkflow — schedule: daily 2am
6. JudgmentWorkflow — schedule: every 2 min

## Build Order (phases in SPEC.md)
Phase 1: Core infrastructure (config, clients, validators, worker, Dockerfile)
Phase 2: Processor layer (event processor, session tracker, briefing composer)
Phase 3: Intuition engine (learning, reflection, judgment)
Phase 4: Integration hooks + scripts
Phase 5: Dashboard (`packages/saas` changes)
Phase 6: Tests + polish

Start with Phase 1. Get the worker booting and connecting to Temporal before writing any workflow logic.

## Temporal workflow rewrites

Temporal replays workflow history deterministically. Renaming an activity, reordering logic inside a workflow, or changing a workflow signature breaks replay for in-flight workflows started under the old code, surfacing as `NonDeterministicError` and stalling them until manually terminated.

Before merging any PR that touches `packages/learn/src/workflows/**` or `packages/learn/src/activities/**`, confirm:

- No activity renamed without a backwards-compat shim under the old name (`@activity.defn(name="old_name")`)
- No workflow signature change that breaks history replay (params added/removed/reordered)
- Logic-order changes inside a workflow gated with `workflow.patched(<name>)` or `use_compatible_version()`
- New activities registered in `packages/learn/src/worker.py`
- Pre-deploy plan documented for in-flight workflows: terminate, drain, OR rely on patched-version compat
- Tested locally with a workflow started under old code + replayed under new code, if the change is non-additive

Worked example: PR #628 (paginate `plane_sync.fetch_changed_tasks`) renamed activities and rewrote workflow logic without `workflow.patched()`. In-flight workflows hit `NonDeterministicError` post-deploy on David + Rapali, stalled for 12+ minutes, and required manual termination.

### Adding NEW activity calls is just as load-bearing as renames

Adding a new `workflow.execute_activity()` inside an existing `@workflow.run` is the SAME class of non-additive change as renaming — replay of pre-deploy history will diverge (old history has no record of the new activity, new code expects it). Use `workflow.patched()` even when the change "feels" additive:

```python
if workflow.patched("signal_extract_obs_v1"):
    await workflow.execute_activity(extract_observation_from_signal, ...)
```

Near-miss example: commit `289d6e2` (OBS-2) added `extract_observation_from_signal` to `SignalExtractWorkflow.run` unconditionally. No production incident because the schedule uses `overlap=SKIP` and each run completes in seconds, so no in-flight workflow spanned the deploy boundary — but the contract was violated. Future modifications to `signals.py:SignalExtractWorkflow.run` must use `workflow.patched()` for any new activity calls. See the in-file warning comment near the OBS-2 hook.

### Retroactively wrapping deployed unconditional code is unsafe

Once a non-gated change ships, adding a `workflow.patched("foo")` around it in a later commit *also* breaks replay: old history has the unconditional activity call but no patch marker, and the new code will skip the call on replay because `patched()` returns `False` for histories without the marker. The only safe options after the fact are (a) leave the contract violation in place and document it, or (b) terminate-and-restart all in-flight runs of the affected workflow before deploy. Never silently re-wrap.
