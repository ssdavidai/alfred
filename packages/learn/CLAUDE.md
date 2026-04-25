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
3. DailyDigestWorkflow — schedule: daily 6pm
4. LearningWorkflow — schedule: every 5 min
5. ReflectionWorkflow — schedule: daily 2am
6. JudgmentWorkflow — schedule: every 2 min

## Build Order (phases in SPEC.md)
Phase 1: Core infrastructure (config, clients, validators, worker, Dockerfile)
Phase 2: Processor layer (event processor, session tracker, daily digest)
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
