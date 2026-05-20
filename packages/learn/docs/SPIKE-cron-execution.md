# SPIKE — How a Hermes cron job actually executes alfred-learn's work

**Issue:** #48 (`[opt3] Move stateless periodic cleanup jobs to Hermes cron`)
**Part of:** #37 / Option 3. Consumes #47 (`WORKFLOW-DURABILITY.md`),
#51 (`SPIKE-cron-migration.md`), #57 (`SPIKE-cron-timezone.md`).
**Date:** 2026-05-19
**Status:** spike / decision doc — decision-first, no production code.

**Hermes version studied:** `v2026.5.16` (release v0.14.0), pinned in
`packages/hermes/VERSION` (`HERMES_REF=v2026.5.16`). Cloned from
`github.com/NousResearch/hermes-agent` at that tag. Every Hermes claim
below cites a file and line in that tree (`cron/scheduler.py`,
`cron/jobs.py`, `hermes_constants.py`).

---

## Why this spike exists — the cross-container execution problem, stated plainly

#48's premise: "move cron-eligible `learn` workflows from Temporal schedules
to Hermes `cron`." #51 already narrowed the *which*; #56 set
`HERMES_CRON_TIMEOUT=1800`; #57 settled the *timezone* (global-only → translate
tenant-local cron expressions to UTC at registration). On paper #48 is
unblocked. But none of those three docs answered the **mechanical** question,
and it is the load-bearing one:

> A Hermes cron job runs **inside the `hermes` container**, under the Hermes
> process. The cron-eligible workflows are **alfred-learn Python Temporal
> activities**, running in the **separate `alfred-learn` container**, against
> the Temporal server. How does a job in container A run logic that lives in
> container B?

This is not a hypothetical. It is grounded in the actual deployment:

### Fact 1 — three separate containers, one docker socket

From `docker-compose.yaml`:

| Service | Image | Docker socket? | Network reach |
|---|---|---|---|
| `alfred-learn` | `alfred-learn:latest` | **no** | compose default net |
| `hermes` | `alfred-black-hermes:latest` | **no** (`cap_drop: ALL`, `no-new-privileges`) | compose default net |
| `ctrl-api` | `alfred-ctrl-api:latest` | **YES** — `/var/run/docker.sock` mounted (line 346) | compose default net |
| `temporal` | `temporalio/temporal:latest` | n/a | compose default net |

Only `ctrl-api` holds the docker socket. `hermes` explicitly drops every
capability (`cap_drop: ALL`, only `DAC_OVERRIDE` added) and runs
`no-new-privileges:true`. **A Hermes cron job therefore cannot
`docker exec alfred-learn …`.** That door is closed by design.

### Fact 2 — `alfred-learn` exposes no HTTP surface today

`packages/learn/entrypoint.sh` is `init_vault → register_schedules → exec
python -m src.worker`. `src/worker.py` (1139 lines) is a pure Temporal worker —
it constructs a `Worker` bound to task queue `alfred-learn` and runs it. There
is **no** `aiohttp` / `fastapi` / `http.server` import anywhere in `worker.py`,
no port published in the compose service. `alfred-learn` is reachable by
**nothing** — it is a Temporal *client of* `temporal:7233`, not a server.

### Fact 3 — the workflow bodies are thin; the real work is in activities

The cron-eligible cleanup workflows are deliberately thin Temporal
orchestration wrappers. `NightlyMaintenanceWorkflow` is ~30 lines: it
`execute_activity(run_janitor_scan_and_fix)` then
`execute_activity(run_distiller_batch)`. `StreamEventPurgeWorkflow` is one
`execute_activity(purge_old_stream_events)`. `ComposioReconnectCleanupWorkflow`
loops a ledger and calls four activities.

The activity bodies (`src/activities/maintenance.py`,
`composio_reconnect.py`, `archival_sweep.py`) are plain `async def` functions.
They are **mostly** Temporal-agnostic — `run_janitor_scan_and_fix` just
`httpx.post`s ctrl-api endpoints. **But** they are not *cleanly* callable
outside a Temporal worker:

- They are decorated `@activity.defn` and call `activity.logger` /
  `activity.info()` (`grep` confirms `activity.logger` usage across
  `maintenance.py`, `composio_reconnect.py`, and 8 other activity modules).
  `activity.logger` outside an activity context raises / degrades.
- `ComposioReconnectCleanupWorkflow` uses `workflow.now()` for deterministic
  time — that is workflow-runtime-only.
- They load config via `load_config()` and read `os.environ` — fine outside
  Temporal, but the point stands: **today there is no `learn` CLI entrypoint
  that runs a cleanup job's logic as a plain process.** The logic is reachable
  *only* by starting the workflow on the Temporal worker.

### The consequence

There is **no zero-cost way** for a Hermes cron tick to run alfred-learn's
Python. Every realistic mechanism requires *new plumbing somewhere*. The rest
of this doc evaluates the four candidates honestly and picks one — including
the honest possibility that the right pick is "don't".

---

## What Hermes cron can actually do — grounded in the v2026.5.16 source

#51 and #57 sourced this from docs / the timezone subsystem. This spike read
the **cron executor** (`cron/scheduler.py`) directly. Three facts decide #48:

### 3.1 — A `no_agent` cron job runs a script, and *only* a script

`run_job()` (`cron/scheduler.py:1024`) has a `no_agent` short-circuit
(line 1052): `if job.get("no_agent"):` → it runs `_run_job_script(script_path)`
and returns, **before** `run_agent` / `AIAgent` / `SessionDB` are even
imported (the import is deferred to line 120, *after* the short-circuit). The
in-code comment is explicit: *"the script IS the job, no LLM involvement …
no AIAgent, no prompt, no tool loop, no token spend."* This is the substrate
#51 correctly identified as the right one for zero-LLM sweeps.

### 3.2 — The script MUST live inside `HERMES_HOME/scripts/` — this is enforced

`_run_job_script()` (`cron/scheduler.py:708-820`) resolves `script_path`
against `_get_hermes_home() / "scripts"` and then does
`path.relative_to(scripts_dir_resolved)` — any path that escapes the scripts
dir returns `False, "Blocked: script path resolves outside the scripts
directory …"` (line 750-755). A cron `no_agent` job **cannot** point at an
arbitrary absolute path; the executable body must be a file *physically inside*
`HERMES_HOME/scripts/`. It may be `.py` (run as `sys.executable script.py`) or
`.sh/.bash` (run via `bash`, line 766-789). It runs as a `subprocess.run` with
`cwd=script.parent`, inheriting the Hermes process environment.

**Implication:** the script is a Python/bash process *inside the `hermes`
container*. It has the `hermes` container's network identity — so it **can**
make an outbound HTTP call on the compose network (`curl http://ctrl-api:3100`,
`curl http://temporal:7233`, etc.). It does **not** have `alfred-learn`'s
Python environment, its `src/` tree, or its dependencies.

### 3.3 — `HERMES_CRON_TIMEOUT=1800` does NOT apply to `no_agent` script jobs

This is a material finding that contradicts a stated #48 precondition.
`HERMES_CRON_TIMEOUT` is read at `cron/scheduler.py:1478` — inside the
**agent** code path (line 1470+: *"Run the agent with an inactivity-based
timeout … override via HERMES_CRON_TIMEOUT"*). The `no_agent` short-circuit at
line 1052 runs `_run_job_script()`, which is bounded by
`_get_script_timeout()` (line 675) → the `cron.script_timeout_seconds` config
key → **`_DEFAULT_SCRIPT_TIMEOUT = 120` seconds** (line 670). It does **not**
read `HERMES_CRON_TIMEOUT`.

`packages/hermes/hermes-config.yaml.njk` and the other Hermes config templates
set **no `cron.script_timeout_seconds`** (grep confirms — the only `cron`
match in the template is an unrelated comment). So a `no_agent` script cron job
in the current deploy gets **120 seconds**, full stop.

> **#56's audit is therefore incomplete.** #56 sized `HERMES_CRON_TIMEOUT=1800`
> against the longest Temporal `execution_timeout` (SignalExtract 25 min,
> StreamEventPurge 10 min). That number governs *agent* jobs. The moment #48
> ships any cleanup job as a `no_agent` script — which #51 explicitly
> recommends for the zero-LLM sweeps — that job is silently capped at 120 s.
> `purge_old_stream_events` on david's ~10K-event vault has a deliberate 5-min
> (300 s) Temporal envelope; as a 120-s `no_agent` script it would be **killed
> mid-purge**. Either `cron.script_timeout_seconds` must be added to the Hermes
> config (a new precondition #48 must satisfy), or the script must not be
> `no_agent`. This is a real, previously-unrecorded blocker.

---

## The four mechanisms — evidence-based cost/benefit

### (a) HTTP trigger — Hermes `no_agent` cron script → `curl` → an endpoint that runs the job

Two sub-variants, because the endpoint can live in two places:

**(a1) → a NEW HTTP endpoint on `alfred-learn`.**
Cost: `alfred-learn` must grow an HTTP server (it has none — Fact 2). That
means adding `aiohttp`/`fastapi` to a package whose CLAUDE.md explicitly says
*"temporalio SDK, httpx, pyyaml — no other dependencies without
justification."* And the endpoint must run the job logic *outside* a Temporal
activity — so each migrated job's activity body must be refactored to be
cleanly callable without `activity.logger` / `activity.info()` /
`workflow.now()` (Fact 3). That is a real per-job refactor, not a wrapper.
Net: a new long-lived HTTP server + a new dependency + N endpoint handlers + N
activity-body de-Temporalisations. Verdict: **high cost, and it half-rebuilds
a job runner next to the one being removed.**

**(a2) → the EXISTING `ctrl-api` workflow-start endpoint.**
This spike found the key fact #51 did not surface: **ctrl-api already exposes
`POST /api/v1/workflows`** (`packages/ctrl/src/api/routes/workflows.ts:40`),
which does `docker exec temporal temporal workflow start --type <X>
--task-queue <Q>`. ctrl-api holds the docker socket (Fact 1); it is the one
container that *can* talk to `temporal`.

So a Hermes `no_agent` cron script of the form —

```python
# HERMES_HOME/scripts/learn_cron_stream_event_purge.py
import os, urllib.request, json
req = urllib.request.Request(
    "http://ctrl-api:3100/api/v1/workflows",
    data=json.dumps({"workflow_type": "StreamEventPurgeWorkflow",
                     "task_queue": "alfred-learn"}).encode(),
    headers={"Authorization": f"Bearer {os.environ['AAS_API_KEY']}",
             "Content-Type": "application/json"}, method="POST")
urllib.request.urlopen(req, timeout=30).read()
```

— would, in well under the 120-s script budget, ask ctrl-api to start the
workflow on the **alfred-learn Temporal worker**. The 120-s timeout problem
(Fact 3.3) **evaporates**, because the script only *fires* the workflow; the
workflow itself still runs to completion on the Temporal worker with its
existing `execution_timeout`. No `alfred-learn` HTTP server, no new dependency,
no activity-body refactor — the workflow runs exactly as it does today.

**But read what (a2) actually is.** It does **not remove Temporal**. The
workflow still runs on the Temporal worker, still uses activity `RetryPolicy`,
still appears in Temporal history. All #48 would have done is **replace the
Temporal *Schedule* with a Hermes cron job that pokes the workflow into
existence.** The execution substrate is unchanged. You have swapped a
first-class, server-side, observable Temporal Schedule object for: a flat-file
cron entry + a hand-written script-in-a-volume + a `docker exec` shell-out + a
loss of `ScheduleOverlapPolicy` / backfill / `list_schedules`. That is **strictly
more moving parts for strictly less capability**, and it does not advance
Option 3's actual goal (fewer things depending on Temporal) by one inch —
because the workflow still depends on Temporal.

Verdict on (a): **(a1) is expensive and rebuilds a runner. (a2) is cheap but
pointless — it keeps Temporal and adds a worse scheduler in front of it.**

### (b) Agent run — the cron job is an LLM agent session using MCP tools

The cron job wakes a Hermes agent (the default, non-`no_agent` path) that
calls MCP tools to do the cleanup. Cost: this turns deterministic, zero-LLM,
zero-cost Python sweeps (`EventProcessor` is explicitly zero-LLM;
`purge_old_stream_events` is a `for`-loop of idempotent deletes;
`PatternDetection` is deterministic clustering) into **non-deterministic LLM
runs that cost tokens on every tick** — `EventProcessor` fires every 15 min,
forever. #51 already named this anti-pattern (§`cron.wakeAgent`: *"keeps cron
migration from silently adding an LLM call per tick to a loop that had none"*).
There is also no MCP tool today for "purge old stream events" or "run the
janitor batch" — they would have to be built.

Verdict on (b): **rejected outright.** It is the most expensive possible way
to run a `rm`-loop, and #51 already warned against it. Not considered further.

### (c) alfred-learn keeps its OWN scheduler — drop Temporal *schedules*, not Temporal

Instead of Hermes cron, `alfred-learn` runs an in-container scheduler
(APScheduler, or a plain `asyncio` loop alongside the worker) that triggers the
cleanup workflows on cadence. This removes the dependency on Temporal
*Schedules* (the `register_schedules.py` machinery) **without** the
cross-container problem — the scheduler and the worker are the same process,
same container.

Cost: a new scheduling component inside `learn`. Benefit: it is the same
container, so no `docker exec`, no script-in-a-volume, no HTTP hop, no
120-s-vs-1800-s timeout mismatch. But: the workflows still run on the Temporal
worker (so Temporal is still there); and you have hand-rolled a scheduler to
replace a mature one. APScheduler is *another dependency*; an `asyncio` loop is
*another thing to get right* (missed-tick handling, overlap, restart
semantics — exactly what Temporal Schedules already give you for free).

Verdict on (c): **technically sound, strictly better than (a) and (b) for the
cross-container problem — but it solves a problem #48 does not actually have.**
`register_schedules.py` is not a pain point. It is ~1300 lines of
*already-written, already-working* code that runs once on boot. Replacing it
with a hand-rolled scheduler is lateral motion: you remove Temporal Schedules
and add APScheduler. Net dependency count and net complexity are unchanged or
worse.

### (d) Descope — keep the cleanup workflows on Temporal

Do nothing. The cleanup workflows stay as Temporal schedules + workflows on the
alfred-learn worker.

Cost: zero — it is the status quo. Benefit: the honest one #51's Option-3
framing itself conceded —

> the Temporal worker + Python runtime **exist anyway** for the
> durability-critical set (`OnboardingPipeline`, `TaskRunner`, `DecisionRouter`,
> `BriefingWorkflow`, the two Plane sync workflows — #47's verdict, *unchanged
> by any spike*). The `alfred-learn` container, the `temporal` container, the
> worker process, `register_schedules.py` — **all of it stays regardless of
> #48.** #48 cannot delete a single container, a single image, or the
> `register_schedules.py` file.

So the *only* thing #48 (a) or (c) could ever remove is **a handful of
`INTERVAL_SCHEDULES` / `CALENDAR_SCHEDULES` dict entries** — `NightlyMaintenance`,
`StreamEventPurge`, `ComposioReconnectCleanup`, `FleetAudit` are 4 small dicts
in `register_schedules.py`. Each is ~5 lines. Registering them costs one
Temporal API call per boot. That is the entire footprint #48 proposes to
eliminate.

---

## The rigorous (d) accounting — what #48 removes vs. what it adds

#48's acceptance criteria: *"Cleanup jobs run on cron, not Temporal; their
Temporal schedules are removed; no replay errors."* Take the best available
mechanism (a2) and tally it honestly.

**What #48 REMOVES:**

- 4–6 dict entries from `register_schedules.py`'s `INTERVAL_SCHEDULES` /
  `CALENDAR_SCHEDULES` (`NightlyMaintenance`, `StreamEventPurge`,
  `ComposioReconnectCleanup`, `FleetAudit`, and per #51 `ScheduledDispatch` +
  `SignalExtract`). ~30 lines total.
- The corresponding Temporal Schedule objects (one `create_schedule` call each
  on boot).
- **Nothing else.** The workflow `.py` files stay (the workflow still runs).
  The activity `.py` files stay. `worker.py` still registers them
  (`_STATIC_WORKFLOWS`). The `alfred-learn`, `temporal` containers stay. The
  Temporal worker process stays. `register_schedules.py` stays (it still
  registers the ~25 durability-critical + still-on-Temporal schedules + the
  per-matter Steward registrar).

**What #48 ADDS:**

1. A **cron-job registrar** — something must `cronjob add` the new Hermes cron
   entries. Hermes cron is per-profile flat-file (`~/.hermes/cron/jobs.json`,
   #57). There is **no repo code today that adds or removes Hermes cron jobs**
   (#51 §scope-note — the only cron surface is a *read-only* `GET
   /api/v1/hermes/cron` passthrough). #48 must build this from scratch, on the
   `workers` profile.
2. **N trigger scripts physically deployed into `HERMES_HOME/scripts/`** — the
   path-containment enforcement (Fact 3.2) means each script is a real file
   the `init` container (or `learn`, which mounts `hermes_data`) must write
   into the Hermes volume. New deploy-time plumbing crossing a package
   boundary.
3. The **local→UTC cron-expression translation** (#57) for the tenant-local
   daily jobs (`NightlyMaintenance` 03:00 is in scope) — recomputed on every
   registration to bound DST drift.
4. A **`cron.script_timeout_seconds` config addition** to
   `hermes-config.yaml.njk` (Fact 3.3) — the 120-s default would kill
   `purge_old_stream_events`. #56's `HERMES_CRON_TIMEOUT=1800` does not cover
   `no_agent` jobs.
5. A **`docker exec` shell-out per tick** (`ctrl-api` → `temporal`), replacing
   a Temporal-server-internal schedule fire. More fragile, more surfaces.
6. **Loss of observability:** Temporal Schedules are first-class objects with
   `describe` / `list` / run history / `ScheduleOverlapPolicy` / backfill.
   Hermes cron is a flat file with `last_status` / `last_error` strings. The
   `/chores` UI and any operator inspecting "did the purge run?" lose the
   Temporal UI.

**The net.** #48 removes ~30 lines of dict literals and a few boot-time API
calls. It adds a registrar, a script-deployment path, a UTC translator, a
Hermes config change, a per-tick shell-out, and an observability regression —
and, with mechanism (a2), **the workflows still run on Temporal anyway**. With
(a1) or (c) the cost is higher still (HTTP server / new dependency) and
Temporal *still* does not leave the stack.

This is not a simplification. It is a **complexity transfer** — from a small,
mature, observable, already-working Temporal-schedule registration into a new,
hand-built, flat-file, cross-container cron-trigger mechanism — for a saving
(#48's actual deletable surface) that is marginal because, as #51's own
Option-3 comparison conceded, **the Temporal worker exists anyway for the
durability-critical set.**

---

## Recommendation — DESCOPE #48

**#48 should be descoped.** Do not migrate the stateless cleanup workflows to
Hermes cron. The honest evidence — not a reluctance to do work — says so:

1. **The cross-container problem has no clean solution.** Hermes cron runs a
   script inside the `hermes` container; the cleanup logic is alfred-learn
   Python in a different container; only `ctrl-api` can bridge to Temporal.
   Every mechanism (a)/(b)/(c) is either expensive (new HTTP server / new
   dependency / hand-rolled scheduler) or, in the cheap case (a2), **does not
   remove Temporal at all** — it keeps the workflow on the Temporal worker and
   merely puts a worse scheduler in front of it.

2. **#48 cannot deliver Option-3's actual goal.** Option 3 wants *fewer things
   depending on Temporal*. But the durability-critical set (#47, unchanged) —
   `OnboardingPipeline`, `TaskRunner`, `DecisionRouter`, `BriefingWorkflow`,
   the two Plane sync workflows — keeps the Temporal worker, the `temporal`
   container, and `register_schedules.py` in the stack **no matter what #48
   does**. #48's reachable saving is ~30 lines of schedule-dict literals. The
   "the runtime exists anyway" point the original Option-3 comparison raised
   is correct and is fatal to #48: running the cleanup *schedules* on the
   already-present worker is nearly free; the cron migration adds real
   machinery for a near-zero saving.

3. **#48's stated preconditions are not actually satisfied.** This spike found
   that #56's `HERMES_CRON_TIMEOUT=1800` audit governs *agent* cron jobs only;
   `no_agent` script jobs — the substrate #51 recommends for these zero-LLM
   sweeps — are capped at the 120-s `cron.script_timeout_seconds` default,
   which would kill `purge_old_stream_events` mid-run. #48 was approved on a
   precondition that does not hold for the job shape #48 would use.

**Why this is the honest call and not a cop-out.** A cop-out would be "too
hard, skip it." This is the opposite: the spike traced every mechanism to
ground in the v2026.5.16 cron source and the actual compose topology, and
found that the cheapest workable mechanism (a2) **demonstrably does not achieve
the issue's own acceptance criterion** — "run on cron, *not Temporal*" — because
the workflow still executes on the Temporal worker. The expensive mechanisms
((a1), (c)) achieve a *different* goal (de-Temporalising the workflow bodies)
at a cost #48 never scoped, and still cannot remove the Temporal container.
#48 as written asks for a migration whose best case is "more parts, same
Temporal" and whose honest case is "more parts, new dependencies, same
Temporal." That migration should not be forced.

### What happens to the issue

- **Close #48 as `wontfix` / descoped**, citing this doc. The "stateless
  cleanup jobs do not need durability" premise (#47) remains *true* — but "does
  not *need* Temporal's durability" is not the same as "is *cheaper* off
  Temporal." Given the worker exists regardless, it is not.
- **#51's per-item verdicts that are NOT cron-migrations still stand and
  should be re-homed** onto their own issues, because they are genuine wins
  independent of #48:
  - `PlaneSyncNudgeWorkflow` → **delete the workflow**, inline a direct
    ctrl-api call (#51 §7). This is a real simplification — it removes a
    Temporal workflow *and* a `docker exec temporal workflow start` shell-out,
    and replaces them with an in-process function call. It needs no cron. File
    as its own `refactor` issue (#51 follow-up 7 already drafts it).
  - The two **dispatch-idempotency bug fixes** (`route_signal_action`,
    `route_decision` — #51 §3/§4, follow-ups 3 & 4) are real latent bugs and
    must be fixed regardless of #37. They have nothing to do with cron.
  - The **"collapse the per-entity registrars"** refactors (Steward,
    StreamPuller — #51 follow-ups 1 & 2) are genuine simplifications of
    `register_schedules.py` and stand on their own.

### The one smaller win still worth taking

If the team still wants *something* from the #48 line of work, there is
exactly one clean, cron-free win and it is **(c)-adjacent, not cron**:

> **Collapse `register_schedules.py`'s static `INTERVAL_SCHEDULES` /
> `CALENDAR_SCHEDULES` into the worker's own boot path** — i.e. keep the
> schedules on Temporal (they are nearly free) but stop treating their
> registration as a separate concern worth a migration. This is a no-op for
> behaviour and removes the *perception* that these schedules are a burden.

But to be plain: even that is cosmetic. The substantive, evidence-backed
recommendation is **descope #48, harvest the non-cron #51 follow-ups (PlaneSync
nudge deletion, the two dispatch-idempotency fixes, the registrar collapses) as
their own issues, and leave the stateless cleanup workflows on the Temporal
worker that #37 keeps running anyway.**

---

## Appendix — evidence index

| Claim | Source |
|---|---|
| Only `ctrl-api` has the docker socket | `docker-compose.yaml:346`; `hermes` `cap_drop: ALL` line 285-288 |
| `alfred-learn` exposes no HTTP server | `packages/learn/src/worker.py` (no http import); `entrypoint.sh` (`exec python -m src.worker`); no port in compose service `alfred-learn` |
| Cleanup workflows are thin Temporal wrappers | `src/workflows/nightly_maintenance.py`, `stream_event_purge.py`, `composio_reconnect_cleanup.py` |
| Activity bodies use `activity.logger` / `activity.info` / `workflow.now()` | `grep activity.logger src/activities/` (10 modules); `composio_reconnect_cleanup.py` `workflow.now()` |
| `no_agent` cron job runs script only, no LLM | `cron/scheduler.py:1024` `run_job`, `:1052` `no_agent` short-circuit (before the `run_agent` import at `:120`) |
| Cron script must live in `HERMES_HOME/scripts/` | `cron/scheduler.py:708-755` `_run_job_script` — `path.relative_to(scripts_dir_resolved)` or "Blocked" |
| Cron script runs as a subprocess in the `hermes` container | `cron/scheduler.py:789-793` `subprocess.run([sys.executable, script], cwd=script.parent)` |
| `HERMES_CRON_TIMEOUT` applies to agent jobs only | `cron/scheduler.py:1470-1490` (agent path); `no_agent` path uses `_get_script_timeout` `cron/scheduler.py:675` |
| `no_agent` script timeout default is 120 s | `cron/scheduler.py:670` `_DEFAULT_SCRIPT_TIMEOUT = 120` |
| No `cron.script_timeout_seconds` in the Hermes config templates | `packages/hermes/hermes-config.yaml.njk` (grep: no cron timeout key) |
| ctrl-api already has `POST /api/v1/workflows` (start a workflow) | `packages/ctrl/src/api/routes/workflows.ts:40-58` — `docker exec temporal temporal workflow start` |
| Hermes cron is per-profile flat-file; no repo code adds cron jobs | `SPIKE-cron-migration.md` §scope-note; `SPIKE-cron-timezone.md` §evidence; `cron/jobs.py` `jobs.json` |
| Hermes cron is global-timezone-only | `SPIKE-cron-timezone.md` (read `cron/jobs.py`, `hermes_time.py` at the tag) |
| The durability-critical set keeps Temporal regardless | `WORKFLOW-DURABILITY.md` summary table — 6 durability-critical workflows |
