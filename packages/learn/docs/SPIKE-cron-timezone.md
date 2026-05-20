# SPIKE — Hermes cron per-job timezone support

**Issue:** #57 (`spike(hermes): confirm Hermes cron per-job timezone support`)
**Precondition for:** #48. Part of #37. Resolves the `[UNVERIFIED]` flag in
`SPIKE-cron-migration.md` §Timezone (lines 124–129).

**Hermes version studied:** `v2026.5.16` (release v0.14.0), pinned in
`packages/hermes/VERSION` (`HERMES_REF=v2026.5.16`) and
`packages/hermes/Dockerfile:95`. Cloned upstream from
`github.com/NousResearch/hermes-agent` at tag `v2026.5.16`
(commit `a91a57fa5a13d516c38b07a141a9ce8a3daabeb0`, dated 2026-05-16).

**Method:** Unlike #51, this spike is grounded in the **actual Hermes source**,
not the upstream docs. Every claim below cites a file and line in the
`v2026.5.16` tree.

---

## The one-line answer

**Hermes cron is GLOBAL-TIMEZONE-ONLY.** A cron job record carries **no
`timezone` / `tz` field**; every cron expression is evaluated against a single
process-wide clock (`hermes_time.now()`) resolved from one `HERMES_TIMEZONE`
env var / `config.yaml timezone` key. There is no per-job override anywhere —
not in the storage schema, not in `create_job()`, not in `POST /api/jobs`, not
in the `hermes cron` CLI, not in the `cronjob` tool schema.

→ **#48 must render each tenant-local cron expression into a UTC expression at
registration time.** See §Consequence for #48.

---

## Evidence

### 1. The cron job record has no timezone field

`create_job()` is the sole constructor of a cron job record
(`cron/jobs.py:482–637`). Its full signature —

```python
def create_job(
    prompt, schedule, name=None, repeat=None, deliver=None, origin=None,
    skill=None, skills=None, model=None, provider=None, base_url=None,
    script=None, context_from=None, enabled_toolsets=None, workdir=None,
    no_agent=False,
) -> Dict[str, Any]:
```

— has **no `timezone` / `tz` parameter**. The job dict it persists
(`cron/jobs.py:597–630`) contains exactly these keys:

```
id, name, prompt, skills, skill, model, provider, base_url, script,
no_agent, context_from, schedule, schedule_display, repeat, enabled,
state, paused_at, paused_reason, created_at, next_run_at, last_run_at,
last_status, last_error, last_delivery_error, deliver, origin,
enabled_toolsets, workdir
```

No `timezone`. The nested `schedule` dict for a cron job is produced by
`parse_schedule()` (`cron/jobs.py:184–268`) and for `kind == "cron"` it is
exactly:

```python
return {"kind": "cron", "expr": schedule, "display": schedule}
```

— again, no timezone. `update_job()` cannot add one either: the `cronjob` tool
update path only re-runs `parse_schedule()` for the `schedule` field
(`tools/cronjob_tools.py:526–529`), which yields the same three-key dict.

### 2. Next-fire-time is computed against the single global clock

`compute_next_run()` (`cron/jobs.py:351–392`), `kind == "cron"` branch:

```python
base_time = now                       # now = _hermes_now()  (line 357)
if last_run_at:
    base_time = _ensure_aware(datetime.fromisoformat(last_run_at))
cron = croniter(schedule["expr"], base_time)
next_run = cron.get_next(datetime)
```

`croniter` evaluates the expression in whatever timezone `base_time` carries.
`base_time` is **always** either:

- `_hermes_now()` directly (line 357) — the global clock; or
- `last_run_at` coerced by `_ensure_aware()` (`cron/jobs.py:273–289`), which
  ends with `return dt.astimezone(target_tz)` where
  `target_tz = _hermes_now().tzinfo` (line 285) — i.e. forced back into the
  *same* global zone.

So the zone the cron expression fires in is the global zone, full stop. The
same is true of `_compute_grace_seconds()` (`cron/jobs.py:319–349`, uses
`croniter(schedule["expr"], _hermes_now())`) and of the due-check
`_get_due_jobs_locked()` (`cron/jobs.py:927`, `now = _hermes_now()`).

### 3. `_hermes_now()` resolves ONE process-wide timezone

`_hermes_now` is `hermes_time.now` (imported `cron/jobs.py:24`,
`cron/scheduler.py:40`). `hermes_time.py` (full file, 104 lines):

- `now()` (lines 91–102) → `datetime.now(get_timezone())`.
- `get_timezone()` (lines 78–88) resolves **once** and **caches** for the
  process lifetime (`_cache_resolved` global, lines 32–34, 84–87).
- `_resolve_timezone_name()` (lines 37–61) resolution order:
  1. `HERMES_TIMEZONE` env var (line 44),
  2. `timezone` key in `~/.hermes/config.yaml` (lines 49–57),
  3. else server-local time.

This is a singleton. There is no parameter, no per-call override, no per-job
path into it. The module docstring states it plainly: *"a single `now()`
helper ... based on the user's configured IANA timezone."*

`gateway/run.py:556–559` bridges `config.yaml`'s `timezone` key into the
`HERMES_TIMEZONE` env var at gateway boot — confirming the gateway has exactly
one timezone for its whole process (and therefore for its whole cron).

### 4. No timezone on the `POST /api/jobs` body schema

`_handle_create_job()` in `gateway/platforms/api_server.py:2415–2462`. The
handler reads **only** these fields from the request body:

```python
name     = body.get("name")
schedule = body.get("schedule")
prompt   = body.get("prompt", "")
deliver  = body.get("deliver", "local")
skills   = body.get("skills")
repeat   = body.get("repeat")
```

and passes them straight to `_cron_create(**kwargs)`. A `timezone` key in the
body is **silently ignored** — it is never read.

`PATCH /api/jobs/{job_id}` (`api_server.py:2483–2508`) is the only other
mutation route and it forwards a sanitized body to `update_job()`, which (per
§1) has no timezone path either.

### 5. No timezone on the `cronjob` tool or the `hermes cron` CLI

- **`cronjob` tool** — the tool's parameter schema (`tools/cronjob_tools.py:564–668`)
  declares: `action, job_id, prompt, schedule, name, repeat, deliver, skills,
  model, provider, base_url, script, context_from, enabled_toolsets, workdir,
  no_agent`. No `timezone`.
- **`hermes cron` CLI** — `cron_create()` (`hermes_cli/cron.py:166–179`) passes
  `schedule, prompt, name, deliver, repeat, skill, skills, script, workdir,
  no_agent` to the cron API. No timezone argument.

### 6. The upstream tests confirm the model

`tests/cron/test_compute_next_run_last_run_at.py` is the upstream regression
test for cron next-fire computation. To exercise a non-UTC zone it does **not**
set a per-job timezone — there is no such thing — it monkeypatches the global
clock:

```python
morocco = ZoneInfo("Africa/Casablanca")
now = datetime(2026, 4, 10, 22, 0, 0, tzinfo=morocco)
monkeypatch.setattr("cron.jobs._hermes_now", lambda: now)
schedule = {"kind": "cron", "expr": "0 */6 * * *"}   # no timezone key
```

The only knob for timezone in the entire cron subsystem is the global
`_hermes_now()`.

---

## Consequence for #48 — global-only path

Per the issue's stated branch: *if global-only, #48 must translate each
tenant-local cron expression into a UTC expression at registration time.*
That is the path. Concretely:

### The fixed split #48 must preserve

| Workflow | Tenant-local schedule | Zone today |
|---|---|---|
| `ReflectionWorkflow` | daily 02:00 | `TENANT_TIMEZONE` |
| `NightlyMaintenanceWorkflow` | daily 03:00 | `TENANT_TIMEZONE` |
| `ChorePromotionReflectionWorkflow` | Sunday 03:00 | `TENANT_TIMEZONE` |
| `DecisionPatternsWorkflow` | daily 03:00 | `TENANT_TIMEZONE` |
| `al-fleet-audit`, `al-stream-event-purge` | (sweeps) | UTC-pinned |

Today `learn` keeps this split via `time_zone_name` on the Temporal
`ScheduleSpec` per schedule. Hermes cron has no equivalent. Both groups live in
the **same** profile cron (`workers`, per `SPIKE-cron-migration.md` §"Two
profiles"), which runs in **one** zone.

### Why "set `HERMES_TIMEZONE` to the tenant zone" does NOT solve it

`HERMES_TIMEZONE` is profile-wide. Note it is **not currently set anywhere** in
`alfred-black`'s Hermes deploy config (`hermes-config.yaml.njk`,
`hermes-profile.env.njk`, `config.yaml.tpl` contain no `timezone` /
`HERMES_TIMEZONE` key) — so the `workers` gateway runs on **server-local =
UTC** today. If #48 set `HERMES_TIMEZONE = TENANT_TIMEZONE` to make the daily
jobs fire correctly, the UTC-pinned audit/retention sweeps would silently shift
to tenant-local — breaking fleet-wide audit math. The two groups cannot share
one zone. **Do not set `HERMES_TIMEZONE`; leave the `workers` gateway on UTC.**

### The instruction for #48

**Register every `learn` cron job with a cron expression already expressed in
UTC.** The `workers` gateway stays on its implicit UTC clock.

1. **Audit/retention sweeps** (`al-fleet-audit`, `al-stream-event-purge`) —
   their expressions are already UTC-intended. Register the cron expression
   verbatim. No translation. (`learn` already passes `time_zone_name="UTC"`
   for these — same intent.)

2. **The four tenant-local daily jobs** — translate the local-time expression
   to UTC at registration time, in `learn`'s schedule registrar
   (`packages/learn/scripts/register_schedules.py`), using the IANA zone
   already on `config.tenant_timezone` (`config.py:50`, env `TENANT_TIMEZONE`,
   default `UTC`). Compute the next local fire instant in `TENANT_TIMEZONE`,
   convert it to UTC with `zoneinfo`, and emit `minute` + `hour` (and `weekday`
   for `ChorePromotion`) from the UTC instant. Example: `Reflection` at local
   `02:00` for `America/New_York` (UTC−4 in summer) → register `0 6 * * *`;
   `ChorePromotion` Sunday `03:00` local → if the +offset rolls the wall clock
   past midnight, the weekday field must roll too (e.g. `America/Los_Angeles`
   Sunday 03:00 → `0 10 * * 0`, still Sunday; but a large positive offset can
   push it to the next day — compute, don't hand-write).

   Build the UTC expression by **converting a concrete datetime**, never by
   string-patching the cron fields, so day-of-week rollover is handled
   correctly.

### The DST caveat — and why it is acceptable here

A fixed-offset translation done once at registration time **drifts across
DST**: a job translated during summer (UTC−4 for US-Eastern) will, after the
autumn transition (UTC−5), fire one hour off local wall time — `02:00` local
becomes `01:00` or `03:00` local depending on direction.

Assessment for these four jobs:

- All four are **low-traffic overnight maintenance** jobs (`Reflection` 02:00,
  the three at 03:00 / Sunday 03:00). They are **idempotent fixed-cadence
  sweeps** — the entire premise of #51's migration. A one-hour drift twice a
  year means a sweep runs at 01:00 or 03:00 instead of 02:00. Nothing the
  principal sees depends on the exact minute; no overlap risk (they are hours
  apart); no correctness impact. The DST drift is **cosmetically wrong for a
  few weeks per transition, functionally harmless.**
- It would only matter if a job were anchored to a human-facing event (a 09:00
  "good morning" brief) — none of these four are. The #45 principal-notification
  path (which *is* human-facing) is explicitly out of scope here and stays on
  Temporal.

**Recommended mitigation (cheap, removes the drift entirely):** do the
local→UTC translation **at every (re)registration**, and have `learn`
re-register its cron jobs on each `register_schedules.py` run (gateway/learn
boot, deploy). Because the offset is recomputed against the *current* date each
time, a job is at most ~half a deploy-cycle stale — in practice corrected
within a day of any DST transition, since `learn` redeploys/restarts far more
often than twice a year. This needs **no Hermes change** and no extra
machinery: it is just "recompute the UTC expression each time you register."

If a future requirement needs zero drift, the only zero-drift options are
(a) keep the four daily jobs on Temporal (where `time_zone_name` is DST-correct
natively), or (b) a tiny self-rescheduling cron job that recomputes its own UTC
expression daily. Both are heavier than the harmless-drift acceptance above;
recommend **accept the drift + re-register on deploy** unless #48 surfaces a
hard requirement otherwise.

---

## Report summary

- **Answer:** GLOBAL-ONLY. Hermes `v2026.5.16` cron has no per-job timezone.
  One process-wide `HERMES_TIMEZONE` (`hermes_time.py`), cached as a singleton,
  drives every cron evaluation.
- **Source evidence:** `cron/jobs.py` — `parse_schedule()` cron branch returns
  `{kind, expr, display}` only (l.229–233); `create_job()` has no `timezone`
  param and stores no `timezone` key (l.482–630); `compute_next_run()` cron
  branch anchors `croniter` on `_hermes_now()` / `_ensure_aware()` → global
  zone (l.373–392). `hermes_time.py` — `now()`/`get_timezone()` resolve one
  cached `HERMES_TIMEZONE` (l.78–102). `gateway/platforms/api_server.py:2415–2462`
  — `POST /api/jobs` reads only `name/schedule/prompt/deliver/skills/repeat`.
  `tools/cronjob_tools.py:564–668` and `hermes_cli/cron.py:166–179` — no
  timezone arg. `tests/cron/test_compute_next_run_last_run_at.py` — upstream
  test sets zone by monkeypatching the global `_hermes_now`, not a job field.
- **Instruction for #48:** Leave the `workers` Hermes gateway on UTC (do **not**
  set `HERMES_TIMEZONE`). Register audit/retention sweep cron expressions
  verbatim (already UTC). For the four tenant-local daily jobs, translate the
  local-time schedule to a UTC cron expression in
  `packages/learn/scripts/register_schedules.py` using `config.tenant_timezone`
  — convert a concrete datetime via `zoneinfo` and emit UTC `minute/hour/weekday`
  (never string-patch fields; day-of-week can roll). Re-run that translation on
  every registration so DST drift self-corrects within a deploy cycle; the
  residual twice-a-year ≤1h drift on overnight idempotent sweeps is harmless.
- **`POST /api/jobs` accepted body (for #48):** `name` (required, ≤ max len),
  `schedule` (required — `parse_schedule` string: `"30m"`, `"every 2h"`, a
  5/6-field cron expr, or an ISO timestamp), `prompt` (≤ max len), `deliver`
  (default `"local"`), `skills` (array), `repeat` (positive int). Any other
  key, including `timezone`, is ignored.
- **Unverifiable / flag:** Nothing material is unverifiable — the cron engine
  source was read directly at the pinned tag. One operational note: this spike
  confirms the `workers` gateway's *effective* cron zone is server-local, and
  the alfred-black Hermes templates set no `timezone`; #48 should treat
  "server-local == UTC in the tenant container" as a deploy assumption to
  assert (e.g. `TZ=UTC` in the container) rather than inherit silently.
