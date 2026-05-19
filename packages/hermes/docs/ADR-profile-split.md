# ADR — The two-profile Hermes split (`main` + `workers`)

- **Status:** Accepted — **keep two profiles** (with one cleanup follow-up).
- **Date:** 2026-05-19
- **Issue:** [#50](https://github.com/ssdavidai/alfred-black/issues/50) — *Evaluate
  collapsing the two-profile split into one profile + native delegation.*
- **Depends-on / blocks:** [#45](https://github.com/ssdavidai/alfred-black/issues/45)
  (notify_principal bridge). Part of [#37](https://github.com/ssdavidai/alfred-black/issues/37).
- **Hermes version studied:** `v2026.5.16` (release v0.14.0), pinned in
  `packages/hermes/VERSION`.

---

## Context

`alfred-black` runs **one `hermes` container** that hosts **two Hermes
profiles**, each its own `hermes -p <profile> gateway run` process, supervised by
`packages/hermes/docker/supervisor.sh`:

| Profile   | Role | Hermes API | Shim (legacy) port | Model | Memory | Channels |
|-----------|------|-----------|--------------------|-------|--------|----------|
| `main`    | user-facing chat | `:18799` | `:18789` | `x-ai/grok-4.3` | on (`memory_enabled: true`, user profile, nudges) | all six toolsets (cli/telegram/slack/discord/whatsapp/signal) |
| `workers` | background agents only | `:18800` | `:18790` | `openai/gpt-4.1-nano` | off (`memory_enabled: false`) | none — `cli: [terminal, file, web, vision, skills, todo]` |

The split is inherited from OpenClaw's two-*container* split (`openclaw` +
`openclaw-workers`), originally a resource-contention workaround. Every
`{% if is_main %}` divergence in `hermes-config.yaml.njk` is one of:

| Knob | `main` | `workers` | Why it diverges |
|------|--------|-----------|-----------------|
| `model.default` | `grok-4.3` | `gpt-4.1-nano` | background traffic is high-volume + cheap-tolerant |
| `agent.max_turns` | 80 | 50 | live chat needs more headroom |
| `memory.*` | enabled | disabled | stateless classifiers; avoids the QMD compaction death-loop |
| `session_reset` | `both`, idle 1440m, daily 04:00 | `idle`, 30m | workers run one-shot, must not linger |
| `delegation.max_concurrent_children` | 3 | **1** | serialise LLM calls → stay under provider TPM |
| `tool_loop_guardrails.hard_stop` | off | on | nobody is watching a background run |
| `platform_toolsets` | 6 messaging toolsets | none | workers must not message a channel |
| `display.*` | verbose/interim | quiet | cosmetic |
| MCP servers (6) | identical | identical | — not a divergence |

**What actually consumes the `workers` profile** (grounded in code):

- `learn/src/config.py` — `openclaw_workers_gateway_url` / `execution_gateway_url`
  default to `http://hermes:18790`. The docstring explicitly notes the `main`
  profile *rejects* `agentId=main`-less traffic differently and that autonomous
  traffic "deliberately never touches" `:18789`.
- `learn/src/activities/clerk.py::_call_clerk` — the **single** Hermes entry
  point for autonomous LLM work. Posts `POST /v1/runs` to `:18790`,
  `session_id = learn-clerk` (or `exec-<hash>`).
- `learn/src/activities/ephemeral_agent.py` — an ephemeral executor is *just*
  one `/v1/runs` call to `:18790` with `session_id = exec-<hash>`. No config
  mutation, no agent registry.
- `learn/src/activities/tasks.py::execute_task`, `chore_actions.py::_workers_spawn_subagent`
  — chore/task LLM calls pinned to `:18790`; rely on `max_concurrent_children: 1`
  for natural serialisation.
- `learn/src/activities/signal_actions.py::dispatch_action_to_agent` — delegated
  signal actions, `exec-<hash>` sessions on `:18790`.
- `hermes/openclaw-wrapper` (the vault-worker `alfred` container) — calls
  `/v1/runs` against `hermes:18790` for curator/janitor/distiller.
- `ctrl/src/api/routes/integrations.ts` — Composio tool-enable edits **both**
  profile `config.yaml` files.
- `ctrl/src/api/routes/crossTenant.ts`, `notifications.ts`, `channelsEmail.ts`,
  `phone.ts` — all target **`:18789` (`main`)**, never `workers`, because they
  need the messaging surface or user-facing memory.

**Crucial observation:** *none of this code uses Hermes' native `delegate_task`
tool.* The "delegation" today is a process boundary — a separate gateway on a
separate port — driven over `POST /v1/runs`. The `workers` profile *is* the
isolation mechanism. The question of #50 is whether `delegate_task` can replace
that process boundary.

---

## What the Hermes docs actually say (v2026.5.16)

Researched against `hermes-agent.nousresearch.com/docs` and the upstream repo:

1. **Profiles** (`/docs/user-guide/profiles`) are *separate Hermes home
   directories* — each isolates config, sessions, **memory**, `.env`/auth,
   **and runs its own gateway process** on its own port. Two gateways can run
   simultaneously; a token-lock prevents accidental sharing. Profiles are the
   supported mechanism for "running multiple agents" with different personas,
   models, and **memory on/off**.

2. **`delegate_task`** (`/docs/user-guide/features/delegation`) spawns a
   subagent with a **completely fresh conversation** (zero parent history) and
   **synchronously within the parent turn**. For leaf subagents Hermes
   *unconditionally blocks* the `memory`, `send_message`, `clarify`,
   `code_execution`, and `delegation` toolsets. Concurrency is bounded by
   `delegation.max_concurrent_children` (default 3, floor 1) and nesting by
   `max_spawn_depth` (1–3). A subagent's model can be overridden via
   `delegation.model`.

3. **`delegate_task` is explicitly NOT durable.** From the delegation-patterns
   guide: *"delegate_task is synchronous: if the parent turn is interrupted,
   active children are cancelled and their work is discarded… For work that
   must outlive the current turn, use `cronjob` or
   `terminal(background=True, notify_on_complete=True)`."*

4. **Cron jobs** (`/docs/user-guide/features/cron`) "run each job in a **fresh
   agent session with no chat platform attached**", inherit the global model
   when `model` is null, and — critically for #45 — support a **`deliver`**
   parameter, including **`deliver=all`**, which ships output to every
   configured messaging channel.

5. The docs do **not** confirm that `delegate_task` is invokable from inside a
   `/v1/runs` API run, nor that API-server runs and channel sessions are
   isolated within a single gateway. This is an unverified gap and weighs
   against collapsing.

---

## Decision

**Keep the two-profile split.** Do **not** collapse to one profile + native
`delegate_task`.

The motivating premise of #50 — "native `delegate_task` gives the same
isolation" — does not hold against the v2026.5.16 docs. `delegate_task` is the
wrong primitive for what the `workers` profile does, on four independent counts.

### Why `delegate_task` cannot replace the `workers` profile

1. **It is synchronous and non-durable.** Alfred's autonomous work is driven by
   **Temporal workflows** that call `POST /v1/runs` and poll
   `GET /v1/runs/{id}` (`clerk.py`, `openclaw-wrapper`). These runs must survive
   the lifetime of a Temporal activity (up to `_BRIEFING_ACTIVITY_TIMEOUT_S =
   1800s`), independent of any interactive chat turn. `delegate_task` children
   are *cancelled and discarded if the parent turn is interrupted* — and there
   is no long-lived parent turn at all in the background path. Hermes' own docs
   say durable background work must use `cronjob`, **not** `delegate_task`.
   Collapsing would mean either (a) keeping a permanently-running "parent"
   chat turn to host delegations — fragile and unspecified — or (b) rewriting
   the entire Temporal→Hermes contract onto `cronjob`, which is a far larger
   change than #50's "no code unless small" scope.

2. **The concurrency cap is per-batch, not global.** `workers` enforces
   `max_concurrent_children: 1` *as a profile-wide TPM ceiling* — every
   autonomous LLM call across all chores/clerks/executors serialises through one
   gateway. `delegate_task`'s `max_concurrent_children` bounds *one parent's
   batch*. Two Temporal activities each issuing `/v1/runs` are two independent
   entry points; nothing makes them serialise. Collapsing loses the
   single global throttle that today prevents a burst of parallel chores
   blowing the provider TPM limit (the documented reason the cap exists, and
   the OpenClaw `agents.defaults.maxConcurrent: 1` it inherited).

3. **Memory isolation is structural, not per-call.** `workers` sets
   `memory_enabled: false` — the documented fix for the "QMD compaction death
   loop" from unbounded memory growth. `delegate_task` blocks the `memory`
   *toolset* for leaf subagents, but that is a property of *being a delegated
   subagent*, not of an API run. A `POST /v1/runs` against a single collapsed
   `main` profile is a **top-level run on a memory-enabled gateway** — it would
   read/write `main`'s curated memory and user profile. Background classifiers
   writing into Sir's memory store is exactly the regression `workers` exists
   to prevent. There is no per-run "memory off" switch on `/v1/runs` in the
   v2026.5.16 docs.

4. **Per-profile model choice would be lost.** `workers` runs
   `gpt-4.1-nano`; `main` runs `grok-4.3`. `delegation.model` overrides the
   model *for delegated subagents* — again only reachable on the delegation
   path, not on a top-level `/v1/runs`. A collapsed single profile serves every
   API run on `main`'s `grok-4.3`, a real and ongoing cost regression on
   high-volume clerk/classification traffic.

### What collapsing *would* genuinely save (and why it is not worth it)

- One fewer gateway process (~one Python runtime's RAM).
- ~110 lines of `supervisor.sh` shrink to two processes instead of four.
- One `config.yaml` + one `.env` instead of two (the `{% if is_main %}`
  branches disappear).
- One API/shim port pair instead of two.

These are real but **modest** simplifications. Against them sit four behaviour
regressions (durability, global throttle, memory isolation, model split), each
of which would need a *new* compensating mechanism that does not exist
out-of-the-box in Hermes v2026.5.16. The two-profile split is not accidental
complexity inherited from OpenClaw — it is, under Hermes, the *idiomatic* way to
get exactly these four properties. Hermes' own profiles doc lists "different
models" and "memory on/off" as the canonical reason profiles exist.

### What is genuinely wrong today (the cleanup follow-up)

The split is correct; the *naming and dead weight* around it are not. A small
follow-up issue should:

- Rename `openclaw_*` config keys / env vars to `hermes_*`
  (`openclaw_workers_gateway_url` → `hermes_workers_gateway_url`, etc.) — kept
  only for Temporal-determinism inertia, no longer load-bearing.
- Drop `delete_ephemeral_agent` once no in-flight workflow references it
  (`ephemeral_agent.py` already flags this as removable).
- Delete the stale `OPENCLAW_*` comments in `learning.ts:725-726` and the
  `openclaw-workers` skill paths in `skills.ts` that point at the retired
  two-container layout.

That is housekeeping, not an architecture change, and it should not block #45.

---

## Consequences

**Positive (of keeping):**

- No migration risk; the autonomous path keeps its durability, global TPM
  throttle, memory isolation, and cheap-model routing for free.
- `#45` is unblocked immediately with a *better* answer than collapsing would
  give (see below).

**Negative (of keeping):**

- The four-process `supervisor.sh` and the per-profile config/`.env`
  duplication stay. Accepted: it is the cost of the four properties above.
- Two API ports + two shim ports stay. Accepted: localhost-only, in-container.
- The `{% if is_main %}` template branching stays — but it now has *this ADR*
  as its rationale, so a future reader does not re-litigate it.

---

## Consequence for #45 — native channel delivery

**#45 does NOT need the profile split to collapse.** The decision here changes
#45's answer for the better.

The `notify_principal` → `ctrl-api` (`routes/notifications.ts`) → `main`
profile's `message` tool bridge exists because the **`workers` profile has no
messaging toolset** — a background run on `:18790` genuinely cannot reach a
channel. That stays true with two profiles.

But the right native replacement was never "give the `workers` profile a
messaging toolset." It is **Hermes `cronjob` with `deliver`**:

- Cron jobs run in a **fresh, isolated session with no chat platform attached**
  — exactly the `workers`-style isolation — *and* the `deliver` parameter
  (including `deliver=all`) ships the result to every configured channel.
- This is a **single-gateway, no-bridge** delivery path that works **regardless
  of the profile split**. A background job that needs to notify the principal
  becomes a cron job (or a one-shot run) on the **`main`** profile with
  `deliver` set — `main` already has the six messaging toolsets and the channel
  bindings.

So #45's recommended path: route principal-notification through a Hermes
`main`-profile run/cron with `deliver`, and reduce `routes/notifications.ts` to
a thin shim (or remove it). The dependency note in #45 — *"if the split
collapses, agents deliver natively; if it stays, give the delivery path a
native route"* — resolves to the **second branch**: the split stays, and the
native route is `main`-profile `cronjob`/run `deliver`, not the `ctrl-api`
message-tool bridge.

One open item to verify before #45 implementation: confirm that a Hermes
`main`-profile **`POST /v1/runs`** (not just an in-chat cron) can invoke the
delivery path, since `send_message` is blocked for *delegated subagents* but a
top-level API run on a channel-enabled profile should retain it. The cron route
is the safe fallback if the direct `/v1/runs` route cannot deliver.

---

## Options considered

| Option | Verdict |
|--------|---------|
| **A. Keep two profiles** (chosen) | Preserves durability, global TPM throttle, memory isolation, per-profile model. Modest complexity cost, now documented. |
| B. Collapse to one profile + `delegate_task` | Rejected — `delegate_task` is synchronous/non-durable, its concurrency cap is per-batch not global, memory-off is not reachable on `/v1/runs`, model override is delegation-only. Would require rebuilding four properties by hand. |
| C. Collapse to one profile, route background work via `cronjob` | Rejected for *now* — closer to viable (cron is durable + isolated + has `deliver`), but rewriting the entire Temporal→`/v1/runs` contract onto cron is far beyond #50's "small change" scope and loses the global TPM throttle and the cheap-model split. Revisit only if Hermes adds a global concurrency ceiling and per-run model/memory overrides. |
