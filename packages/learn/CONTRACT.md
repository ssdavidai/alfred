# CONTRACT.md — alfred-learn

> Frozen cross-lane interface for `packages/learn/**` (Lane II). Read this
> before coding against or inside alfred-learn. Regenerated 2026-07-15 from
> `main`; every claim below was verified against code, with
> `src/worker.py` (workflow/activity registration) and
> `scripts/register_schedules.py` (schedules) as the authorities.

alfred-learn is the Temporal intelligence layer: a single Python 3.12
worker container (`ssdavidai00/alfred-learn:latest`) that runs every
scheduled workflow in the stack — stream ingest, signal extraction and
routing, decision routing, reflection, chores, narratives, briefings —
plus a Composio HTTP sidecar. It holds **no store of its own**: all
persistence goes through ctrl-api HTTP, and all LLM calls go through the
Hermes gateway profiles.

---

## Provides

### 1. Temporal worker (task queue `alfred-learn`)

One worker process (`src/worker.py:run_worker`) registers all workflows
in `ALL_WORKFLOWS` (static list + dynamically loaded chore templates)
and ~280 activities in `ALL_ACTIVITIES`. Boot sequence
(`entrypoint.sh`): wait for Temporal → `scripts/init_vault` →
`scripts/register_schedules` → start Composio sidecar → `exec python -m
src.worker`.

Schedules below are created by `scripts/register_schedules.py` at
container boot. Interval schedules run continuously; calendar schedules
run in the **tenant's timezone** (`TENANT_TIMEZONE`) unless marked UTC.
Registration-time gates only take effect on the next container restart
(the registrar deletes the schedule when a gate is off).

#### Ingest (streams → ingest.db events)

| Workflow | Schedule | Purpose |
|---|---|---|
| `StreamSweepWorkflow` | `al-stream-sweep` every 2 min (SKIP, 110 s cap) | Pull every enabled stream that is due (`schedule_interval_seconds` vs `last_pull_at`); Composio/HTTP pull → `POST /api/v1/streams/ingest`. Replaced per-stream schedules (#53). |
| `StreamPullerWorkflow` | none — **tombstone** (#53) | Ad-hoc single-stream pull; kept registered, never scheduled. |
| `EventProcessorWorkflow` | `al-event-processor` every 15 min | Zero-LLM stream-event processing: stream-log line + vault event record + mark processed. No classification LLM. |
| `HourlyEnrichmentWorkflow` | `al-hourly-enrichment` hourly | Batched LLM enrichment (entities/tags) of pending records. |
| `OmiAudioProcessorWorkflow` | `al-omi-processor` every 10 min | OMI wearable audio → Groq Whisper transcription → stream ingest. |
| `MediaIngestionWorkflow` | none — triggered | Spawned as a child workflow by `EventProcessorWorkflow` when it sees a `stream_type: "media"` event (emitted by ctrl-api, `packages/ctrl/src/api/routes/channelsAttachment.ts`); ctrl-api does not start it directly. |
| `FileExtractionWorkflow` | none — triggered | Fire-and-forget from ctrl-api `POST /api/v1/files/upload` (#114 Lane B): per-mime extract → workers-gateway summary → stamp row. |
| `StreamEventPurgeWorkflow` | `al-stream-event-purge` daily 03:00 **UTC** — gate `STEWARD_STREAM_EVENT_PURGE_ENABLED` (**default OFF**) | Delete stream events >7 d old whose `signal_extracted_at` is set. |

#### Extract (events → signals)

| Workflow | Schedule | Purpose |
|---|---|---|
| `SignalExtractWorkflow` | `al-signal-extract` every 5 min (25 min cap) — gate `STEWARD_SIGNAL_EXTRACT_ENABLED` (**default ON**; disable with `false`/`0`/`no`/`off`) | Chunked clerk extraction over unprocessed ingest events (`GET /api/v1/ingest/events/pending`, #78 Design-B) → `POST /api/v1/state/signals` (status `unrouted`) + `extract_observation_from_signal` (OBS-2) + auto-task-create hook (`create_task_from_signal`, mode-gated §Invariants). |

#### Route (signals → dispatch / Desk cards)

| Workflow | Schedule | Purpose |
|---|---|---|
| `SignalRouterWorkflow` | `al-signal-router` every 2 min — gate `STEWARD_SIGNAL_ROUTER_ENABLED` (**default ON**) | Route unrouted signals: `effect=mutation` → `apply_signal_mutation`; `effect=action` → `route_signal_action` (instinct match + discretion gate → autonomous dispatch, needs_attention card, or suppression). |
| `StewardSweepWorkflow` | `al-steward-sweep` every 30 min (SKIP, 25 min cap) | Per-matter perception loop over matters whose `next_check_after` elapsed (#52 collapsed per-matter schedules). |
| `StewardWorkflow` | none — **tombstone** (#52) | Ad-hoc single-matter run; kept registered. |
| `TaskClosureWatcherWorkflow` | `al-task-closure-watcher` every 5 min | Match inbound signals against open tasks' `closure_predicate`; deterministic predicates or LLM `assess_closure` — auto-close when confidence ≥ `HIGH_CONFIDENCE_THRESHOLD` = 0.80 (`src/activities/task_closure.py:61`) by writing a `decision(intent=done)`. |
| `DecayWatcherWorkflow` | `al-decay-watcher` every 6 h | Stamp `decay_band` on pending needs_attention cards; auto-flip deeply stale to `status=stale`; adjust matter `surface_class` via state-mutator (SM-D-W8). |
| `DeferResurfaceWorkflow` | `al-defer-resurface` every 15 min | Re-flip skipped needs_attention back to pending when `resurface_at` falls due. |
| `ScheduledDispatchWorkflow` | `al-scheduled-dispatch` every 15 min | Fire delegate-with-when decisions (`state=scheduled`) whose `execute_at` fell due. |
| `ReversalCalibrationWorkflow` | `al-reversal-calibration` every 10 min — gate `STEWARD_REVERSAL_CALIBRATION_ENABLED` (**default OFF**; also re-checked at invocation) | −0.1 confidence per reversal to contributing source-types; state at `/alfred-data/state/steward/reversal-calibration.json`. |

#### Decide (Desk clicks → side effects → observations)

| Workflow | Schedule | Purpose |
|---|---|---|
| `DecisionRouterWorkflow` | `al-decision-router` every 60 s | Read `state=open` decisions, run side effects (source flips, delegate dispatch, to_do spawns, outcome polling), flip decision state; **always** extracts a `kind=decision` observation (§Invariants). Includes `recover_stuck_dispatching` sweep for >10-min-stuck `state=dispatching` decisions. |
| `DecisionPatternsWorkflow` | `al-decision-patterns` daily 03:00 local | Clerk extracts recurring rules from recent decisions → proposed `decision_pattern` records for /study. |
| `PatternDetectionWorkflow` | `al-pattern-detection` hourly | Deterministic (sender, intent) clustering over the observation pool → `pattern_proposal` records (OBS-4). |

#### Reflect / learn

| Workflow | Schedule | Purpose |
|---|---|---|
| `ReflectionWorkflow` | `al-reflection` daily 02:00 local | Feed accumulated observations to the clerk; proposes `apply_instinct_change` calls (sole writer of `observation_count` / `confidence_score` / `tier`). |
| `LearningWorkflow` | `al-learning` every 15 min | Process the observation queue (chat-hook entries) + `alfred_instructions` watcher into observation records (`src/workflows/learning.py`). |
| `JudgmentWorkflow` | `al-judgment` every 15 min | Route unrouted inputs using the intuition index + discretion. |
| `SessionTrackerWorkflow` | `al-session-tracker` every 15 min | Group records into principal sessions (boundary detection). |

#### Chores

| Workflow | Schedule | Purpose |
|---|---|---|
| dynamic chore templates (`ALL_CHORE_TEMPLATES` + `/alfred-data/user-chores/*.py` via `_dynamic_loader`) | one `chore-<slug>` cron schedule per chore record | The principal's recurring work. First 3 runs are quarantine dry-runs (§Invariants). |
| `ChorePromotionReflectionWorkflow` | `al-chore-promotion` Sunday 03:00 local | Draft a GitHub PR for generated chores with enough successful live runs. |

Boot-time chore hygiene (registrar): `delete_duplicate_briefing_chore`
(F33c), `reconcile_chore_schedules` (F34 — deletes `chore-*` schedules
with no backing record, ONLY when the authoritative vault read
succeeded), `recreate_missing_chore_schedules` (F34b).

#### Narrative / briefings

| Workflow | Schedule | Purpose |
|---|---|---|
| `NightlyNarrativeWorkflow` | `al-nightly-narrative` daily 02:00 local | RFC #884: one clerk call per active matter with activity in the last 24 h → refresh `current_state` + `as_of`. |
| `BriefingWorkflow` | `al-briefing-morning` 05:00 local (args `["morning"]`); `al-briefing-evening` 17:00 local (args `["evening"]`) | Visit active matters through the state-mutator, compose + write `briefing/<date>-<slot>.md` (F33 built-in — never a chore). |

#### Onboarding / task running

| Workflow | Schedule | Purpose |
|---|---|---|
| `OnboardingPipelineWorkflow` | none — started by ctrl-api (`packages/ctrl/src/api/routes/workflows.ts` via `temporal workflow start`) | Full onboarding ritual: Gmail backfill → `extract_facts_opus` → `discover_patterns_opus` → `personalize_opus` → packs → day-one Desk seed → first brief (heavy gateway). |
| `TaskRunnerWorkflow` | `al-task-runner` every 15 min | Execute queued tasks via ephemeral Hermes executors. |

#### Meetings / channels

| Workflow | Schedule | Purpose |
|---|---|---|
| `RecallDispatcherWorkflow` | `al-recall-dispatcher` every 5 min | Recall.ai meeting-bot dispatch per calendar policy (#113); no-op when `auto_join_policy=off`. |
| `MeetingCaptureWorkflow` | `al-meeting-capture` every 60 s — gate `VEXA_ENABLED` (**default OFF**) | Dispatch the Vexa bot for upcoming Meet events. |
| `TranscriptIntakeWorkflow` | `al-transcript-intake` every 60 s — gate `VEXA_ENABLED` | Vexa transcripts → `transcript:action_candidate` Steward signals. |
| `HaBootstrapWorkflow` | `al-ha-bootstrap` every 6 h (+ on-demand via ctrl-api `/api/v1/channels/ha/registry/refresh`) | Home Assistant registry pull → `POST /api/v1/channels/ha/registry/bulk`; then gap detection → `/ha/gaps/bulk` + `/ha/proposal` (#110). No-op when HA not connected. |

#### Ops / maintenance

| Workflow | Schedule | Purpose |
|---|---|---|
| `NightlyMaintenanceWorkflow` | `al-nightly-maintenance` daily 03:00 local | Janitor scan-and-fix + distiller batch. |
| `FilesColdArchiveWorkflow` | `al-files-cold-archive` daily 03:00 local | Promote ≥90 d-unaccessed file blobs via ctrl-api `POST /api/v1/files/cold-promote/:file_id`. |
| `ComposioReconnectCleanupWorkflow` | `al-composio-reconnect-cleanup` every 15 min | Safety-net reaper for ctrl-api's persistent reconnect ledger (#645). |
| `FleetAuditWorkflow` | `al-fleet-audit` daily 02:00 **UTC** — gate `FLEET_AUDIT_ENABLED` (**default ON**) | Wrong-tenant stream contamination check. |

#### DORMANT — Plane (not deployed since PR #279)

Plane was removed from the deployed compose stack fleet-wide (PR #279).
The workflows below remain registered in `worker.py` and their
registrars remain in `register_schedules.py`, but all three schedules
are gated on `PLANE_SYNC_ENABLED=true` (**default OFF**) and the
registrar actively **deletes** them when the flag is off. Treat this
surface as dormant code, not a live interface; deletion is an open
follow-up.

| Workflow | Schedule (if flag on) | Purpose |
|---|---|---|
| `PlaneSyncWorkflow` | `al-plane-sync` every 15 s | vault → Plane one-way sync. |
| `PlaneReverseSyncWorkflow` | `al-plane-reverse-sync` every 10 s | Plane webhook events → vault. |
| `PlaneReconciliationWorkflow` | `al-plane-reconciliation` hourly | Mirror Plane REST-deletes into vault archives. |

### 2. Composio HTTP sidecar (`:8788`)

`src/composio_server.py`, started by `entrypoint.sh` alongside the
worker. Surface: `GET /health`, `POST /composio/execute`
(`{action, arguments, user_id, connected_account_id}` → raw
`execute_action` dict; transport errors → HTTP 500 envelope).
**Consumer**: ctrl-api (`packages/ctrl/src/api/routes/integrations.ts`
— `COMPOSIO_EXECUTOR` defaults to `http`, sidecar URL
`http://alfred-learn:8788`; `COMPOSIO_EXECUTOR=docker` is the rollback
knob). The sidecar also merges cached primary-entity defaults fetched
from ctrl-api under LLM-supplied args (Phase C).

### 3. Backfill / migration scripts

One-shot operator scripts under `packages/learn/scripts/` (e.g.
`backfill_decision_observations.py`, `init_vault.py`). Run via
`python -m scripts.<name>` inside the container; not part of the
steady-state surface.

### 4. Clerk gateway circuit breaker

Every call through the shared clerk gateway path is protected by a persistent,
per-tenant circuit breaker. `CLERK_BREAKER_ENABLED` defaults **ON** (the normal
`false`/`0`/`no`/`off` spellings disable it). Its rolling outcome window opens
only when all three conditions hold: samples span at least one hour, a
non-zero fixed/test-pinned minimum call floor has been reached, and at least
**95%** of outcomes are `max_retries_exhausted`. This is a sustained
gateway-failure guard, not a trigger on a single failed workflow.

Opening the breaker short-circuits ordinary clerk dispatch and creates exactly
one `needs_attention` card for that incident through ctrl-api (never a direct
vault write). Retries/restarts use the persisted incident identity and must not
create duplicate cards. The breaker is **close-on-first-success**: an admitted
recovery probe's first successful clerk completion closes it immediately; a
later open state is a new incident and may create one new card.

Breaker state is internal bookkeeping under
`/alfred-data/state/steward/clerk-breaker.json`, alongside
`reversal-calibration.json`, and is written with the same atomic replacement
pattern. It is not vault knowledge and must not be stored in SQLite or a new
vault record type.

---

## Requires

### External services

| Service | Address (compose) | Protocol | Notes |
|---|---|---|---|
| Temporal | `temporal:7233` | gRPC | Worker + schedule registration. |
| ctrl-api | `http://ctrl-api:3100` | HTTP + `Authorization: Bearer $AAS_API_KEY` | The ONLY persistence path (vault, state.db, ingest.db — all via HTTP). |
| Hermes main profile | `http://hermes:18789` | HTTP + `Bearer` gateway token | Principal-facing sessions only: `notify.py` (`POST /v1/sessions/message`), plane triggers (dormant). |
| Hermes workers profile | `http://hermes:18790` | HTTP + `Bearer` gateway token | All clerk + ephemeral-executor calls: `POST /v1/responses` with `X-Hermes-Session-Key` (`learn-clerk` or `exec-<hash>`). The `/v1/runs` poll loop is GONE (#46) — mentions in comments are historical. |
| Hermes heavy profile | `http://hermes:18791` | HTTP + `Bearer` gateway token | `POST /v1/responses`, no `model` in body (profile-pinned). Consumers: `onboarding_v3._call_llm`, and via it `packs_opus` + `chore_generation`. |
| Groq API | hosted | HTTPS | Whisper transcription (`omi_audio.py`, `transcript.py`) — the one direct external LLM-ish call; needs `GROQ_API_KEY`. |
| Composio API | hosted | SDK | `src/integrations/composio_client.py` + sidecar; needs `COMPOSIO_API_KEY`. |

### ctrl-api endpoints consumed (verified by grep over `src/`)

| Area | Endpoints | Used by (examples) |
|---|---|---|
| Vault CRUD | `POST /api/v1/vault/records`; `GET`/`PATCH`/`DELETE /api/v1/vault/records/{path}`; `GET /api/v1/vault/list/{type}`; `GET /api/v1/vault/search`; `POST /api/v1/vault/inbox` | `src/utils/vault_client.py` (the shared client), most activities |
| State store (alfred-state.db) | `POST`/`GET /api/v1/state/signals[/{id}]`; `POST /api/v1/state/observations[/{id}]`; `POST /api/v1/state/audit`; `/api/v1/state/routing-decisions`; `/api/v1/state/links`; `/api/v1/state/embeddings` | `signals.py`, `signal_observations.py`, `decision_router.py`, `steward.py`, `src/utils/state_client.py` |
| Decisions | `POST /api/v1/decisions`; `PATCH /api/v1/decisions/{id}`; `GET /api/v1/decisions/in-flight` | `decision_router.py`, `signal_actions.py`, `task_closure.py`, `scheduled_dispatch.py` |
| Streams / ingest | `POST /api/v1/streams/ingest`; `GET /api/v1/streams/events` (+ `/{id}/processed`, `/{id}/quarantine`); `GET /api/v1/streams/{stream_id}`; `GET /api/v1/ingest/events/pending` | `pull.py`, `streams.py`, `omi_audio.py`, `signals.py:791` |
| Integrations | `POST /api/v1/integrations/execute`; `/api/v1/integrations/:id/reconnect`; `/api/v1/integrations/reconnect-cleanup` | `composio_tools.py`, `composio_reconnect.py` |
| Todos | `POST`/`PATCH /api/v1/todos[/{id}]` | decision router take_mine path |
| Notifications / email | `POST /api/v1/notifications`; `POST /api/v1/email/send` | `vault_client.py`, `chore_actions.py`, `first_brief_email.py` |
| Files | `GET /api/v1/files/cold-candidates`; `POST /api/v1/files/cold-promote/:file_id` | `files_cold_archive.py` |
| Home Assistant | `GET /api/v1/channels/ha/{status,llat,ws/registries,registry}`; `POST /api/v1/channels/ha/{registry/bulk,gaps/bulk,proposal}` | `ha_bootstrap.py`, `ha_gap_detection.py` |
| Misc | `GET /api/v1/sure/transactions` (chore finance); `/api/v1/admin/workspace/SOUL.md`; `/api/v1/curator/route-and-process`; `/api/v1/credentials/groq-api-key` | `chore_actions.py`, onboarding, `omi_audio.py` |

### Environment variables

Defaults are code defaults from `src/config.py` unless noted; the
compose file (`docker-compose.yaml`, `alfred-learn` service) is what a
deployed tenant actually sees.

| Variable | Default | Purpose |
|---|---|---|
| `TEMPORAL_HOST` | `temporal:7233` | Temporal gRPC. |
| `TASK_QUEUE` | `alfred-learn` | Worker task queue. |
| `OPENCLAW_GATEWAY_URL` | `http://hermes:18789` | Hermes MAIN profile. **Var name is legacy-OPENCLAW on purpose** (Temporal determinism — only the value moved to Hermes). |
| `OPENCLAW_WORKERS_GATEWAY_URL` | `http://hermes:18790` | Hermes WORKERS profile (clerk + executors). |
| `HERMES_HEAVY_GATEWAY_URL` | `http://hermes:18791` | Hermes HEAVY profile (Opus-class). |
| `EXECUTION_GATEWAY_URL` | `http://hermes:18790` | Same endpoint as workers; kept for name stability. |
| `OPENCLAW_GATEWAY_TOKEN_FILE` | `/alfred-data/.gateway-token` | Bearer token for all three profiles, read per call. |
| `ALFRED_CTRL_URL` | code: `http://host.docker.internal:3100`; compose sets `http://ctrl-api:3100` | ctrl-api base URL. |
| `AAS_API_KEY` | (from `.env`) | Bearer auth on every ctrl-api call (`vault_client.py:33` et al.). |
| `VAULT_PATH` | `/vault` | Read-only path math; writes still via ctrl-api. |
| `ALFRED_DATA_DIR` | `/alfred-data` | Shared scratch (settings.json, steward state, user-chores). |
| `ALFRED_LEARN_ENABLED` | `true` | Kill switch — worker exits if false. |
| `TENANT_TIMEZONE` | `UTC` | IANA tz for calendar schedules. |
| `CLERK_AGENT_ID` | `learn-clerk` | Default `X-Hermes-Session-Key`. |
| `WORKERS_OPENCLAW_CONFIG` | code: `/hermes-state/workers/config.yaml`; compose sets `/hermes-state/profiles/workers/config.yaml` | Workers profile config path. |
| `OWNER_EMAIL` / `ALFRED_OWNER_EMAIL` | (from `.env`; compose sets both from `OWNER_EMAIL`, C9) | Cross-tenant ingest guard, first-brief allowlist, meeting-bot attendee match. |
| `GROQ_API_KEY` | (from `.env`) | Whisper transcription; without it OMI audio is silently dead. |
| `COMPOSIO_API_KEY` | (from `.env`) | Composio SDK (sidecar + composio_tools). |
| `DISPATCH_USE_EPHEMERAL_EXECUTOR` | compose: `1` | Delegate dispatch uses per-task `exec-<hash>` Hermes sessions. |
| `CLERK_BREAKER_ENABLED` | **ON** | Invocation-time gate for the persistent clerk gateway circuit breaker; `false`/`0`/`no`/`off` disables it. |
| `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | **blanked in compose** | Hermes is the sole provider-key holder; learn makes no direct provider calls. |

**Feature gates (registration-time — changing them requires a container
restart to re-run `register_schedules`)**:

| Variable | Default | Gates |
|---|---|---|
| `STEWARD_SIGNAL_EXTRACT_ENABLED` | ON (any value except `false`/`0`/`no`/`off`) | `al-signal-extract` |
| `STEWARD_SIGNAL_ROUTER_ENABLED` | ON (same falsy rule) | `al-signal-router` |
| `STEWARD_STREAM_EVENT_PURGE_ENABLED` | OFF (`true`/`1`/`yes` to enable) | `al-stream-event-purge` (+ invocation-time re-check) |
| `STEWARD_REVERSAL_CALIBRATION_ENABLED` | OFF | `al-reversal-calibration` (+ invocation-time re-check) |
| `VEXA_ENABLED` | OFF | `al-meeting-capture`, `al-transcript-intake` |
| `PLANE_SYNC_ENABLED` | OFF — **dormant, not deployed (PR #279)** | the three `al-plane-*` schedules |
| `FLEET_AUDIT_ENABLED` | ON | `al-fleet-audit` |

**Mode overrides (invocation-time emergency env — see Invariants for
precedence)**: `STEWARD_SIGNAL_ACTION_LIVE_MODE`, `STEWARD_LIVE_MODE`,
`STEWARD_SIGNAL_AUTOCREATE_TASKS`, `STEWARD_SIGNAL_ROUTER_LIVE_MODE`
(mutations branch only; env-only, no settings key —
`src/activities/signal_mutations.py`).

### Files / volumes

| Path | Access | Purpose |
|---|---|---|
| `/vault` (`vault_data`) | read | Vault markdown (writes go through ctrl-api). |
| `/alfred-data` (`alfred_data`) | read/write | `.gateway-token` (read), `settings.json` (read — ctrl-api is the writer), `user-chores/` (dynamic templates), `chore-run-history.jsonl`, `state/steward/*` caches including `reversal-calibration.json` and `clerk-breaker.json`. |
| `/hermes-state` (`hermes_data`) | read/write | Hermes profile configs; onboarding writes `memories/MEMORY.md` etc. |

### Runtime

Python 3.12-slim; `temporalio==1.9.0`, `httpx`, `pyyaml`, `composio`,
`fastapi`+`uvicorn` (sidecar), pandas/sklearn/tsfresh/hdbscan (profiler),
pypdf/python-docx/openpyxl (file extraction). Runs as uid 1000; 4 GB mem
limit in compose. No local Whisper model — Groq-hosted.

---

## Invariants (other lanes rely on these)

1. **Single-writer discipline.** alfred-learn NEVER writes the vault
   filesystem, `alfred-state.db`, or `ingest.db` directly — every
   persistence op is a ctrl-api HTTP call authenticated with
   `AAS_API_KEY` (`src/utils/vault_client.py`: "NEVER direct filesystem
   writes"). Adding a direct write handle in Lane II is a contract
   violation, full stop.

2. **All LLM traffic goes through Hermes.** Clerk/executor →
   workers `:18790`; onboarding/pack/chore-generation heavy reasoning →
   heavy `:18791`; principal-facing session messages → main `:18789`.
   The main profile is reserved for the principal's chat — autonomous
   traffic must never target it (`clerk.py:_call_clerk` docstring). The
   only non-Hermes model call is Groq Whisper transcription. Provider
   keys are blanked in compose — do not add direct Anthropic/OpenAI
   calls.

3. **Mode-flag resolution precedence** (all three resolvers, verified):
   (1) env override → (2) `/alfred-data/settings.json` key → (3)
   **default `"live"`**. ctrl-api owns the settings writer; learn only
   reads. Fail-safe on any read error is the default, and a missing
   settings file is the steady state (no warning).

   | Settings key | Env override | Resolver |
   |---|---|---|
   | `signal_action_mode` | `STEWARD_SIGNAL_ACTION_LIVE_MODE` | `signal_actions.py:116` |
   | `state_mutator_mode` | `STEWARD_LIVE_MODE` | `state_mutator.py:214` |
   | `auto_task_create_mode` | `STEWARD_SIGNAL_AUTOCREATE_TASKS` (legacy `true`/`false` accepted) | `task_creation.py:143` |

4. **DecisionRouter `synchronous_flip` guards.** When ctrl-api already
   flipped the source record synchronously (`side_effects.synchronous_flip`),
   `route_decision` skips the source-flip side-effect branches
   (`decision_router.py` — guards at 389, 502, 621, 824, 831, 908, 931;
   read at 326) **but `extract_observation_from_decision` has NO guard
   and always runs** (`decision_router.py:~986-996`, best-effort). That
   unconditional call is the learning-loop closer — never gate it on
   `synchronous_flip`.

5. **Delegate dispatch is non-idempotent** (`POST /v1/responses` fires a
   real agent). Idempotency layers protecting it: decision state guard +
   `dispatching` mark + `side_effects.agent_dispatched`
   (`decision_router.py`, `signal_actions.py`); dispatched signals are
   minted terminal (`status=routed_agent`) so SignalRouter can't
   re-dispatch (#216).

6. **Chore quarantine.** New chores are written with
   `quarantine: true, quarantine_remaining: 3`
   (`assign_chores.py:428-448`); `is_quarantined` +
   `decrement_quarantine_remaining` (`workflows/chores/_base.py`)
   enforce 3 dry-runs before live side effects. A chore's
   `workflow_class_name` frontmatter MUST match the deployed class's
   `@workflow.defn(name=...)` exactly (dynamic loader matches by name;
   capitalization-sensitive).

7. **Temporal determinism.** Renaming activities, reordering workflow
   logic, or adding an unconditional `execute_activity` to a deployed
   workflow breaks replay. Every non-additive change needs
   `workflow.patched(...)` or a compat shim — the full rules, with
   worked incidents, are in `packages/learn/CLAUDE.md` ("Temporal
   workflow rewrites"). The legacy `OPENCLAW_*` env names are kept
   deliberately for the same reason.

8. **Registration-time vs invocation-time gates.** Schedule-existence
   flags (`*_ENABLED`) only apply when `register_schedules` runs (boot);
   mode envs are read per invocation. Don't "fix" a gate by making a
   workflow read env at runtime — that breaks determinism (see
   `_signal_extract_enabled` docstring).

9. **Plane is dormant.** All `plane_*` workflows/activities and the
   `al-plane-*` registrars are dead code paths on deployed tenants
   (PR #279 removed Plane from the stack; `PLANE_SYNC_ENABLED` unset →
   registrar deletes the schedules). Do not build against them; removal
   is an open follow-up.

10. **Terminology** is a hard constraint, not style: observation (not
    cognition), instinct (not skill), intuition (not skill-graph),
    reflection (not synthesis), judgment (not router), discretion (not
    confidence gate), clerk (not subken). Source:
    `packages/learn/CLAUDE.md` §Key Constraints.

11. **Clerk outages are incident-deduped.** With
    `CLERK_BREAKER_ENABLED` on, only a >=95% `max_retries_exhausted` rate over
    a sample spanning >=1 h and clearing the fixed minimum-call floor opens the
    breaker. One open incident produces at most one ctrl-api needs-attention
    card, persisted state survives worker restarts, and the first successful
    recovery completion closes it.

---

## Consumed by

- **ctrl-api** — calls the Composio sidecar (`http://alfred-learn:8788`)
  and starts `OnboardingPipelineWorkflow` / one-shot `HaBootstrapWorkflow`
  runs via the Temporal CLI.
- **web / dashboard** — reads what learn writes (briefings, decisions,
  needs_attention, narratives) through ctrl-api; no direct dependency on
  this package.

---

## Change protocol

This CONTRACT.md is **forbidden-zone** (`scripts/hooks/check_lane.py`
rejects `**/CONTRACT.md` inside any lane). Changes are
orchestrator/phase0-only, made centrally when the interface itself
changes — never as part of a lane's feature commit. If a lane discovers
this contract is wrong (an endpoint moved, a schedule changed, a default
flipped), the lane **STOPs and reports** to the orchestrator; it never
improvises across the boundary or edits this file to match its code.
