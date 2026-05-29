---
name: alfred-mcp
description: Drive Sir's per-tenant Alfred Black box from claude.ai — read and write the vault, delegate one-shot work to Alfred, kick off Temporal workflows, and inspect the OpenClaw gateway. Use whenever Sir asks claude.ai about what's in his vault, wants a record created/updated, wants Alfred to do something on his behalf, wants a workflow started/signalled, or wants to know whether Alfred is healthy.
license: alfred-platform internal — see the parent monorepo's LICENSE
---

# Alfred MCP — claude.ai Custom Connector

This connector exposes Sir's tenant ctrl-api content surface to claude.ai. The 18 tools below are the ONLY way you reach his box from a claude.ai conversation — there is no shell, no `bash`, no direct HTTP. Everything goes through this MCP server's bearer token, which is bound to one tenant for one hour.

The catalogue is intentionally narrow. Container restarts, credential rotation, device revocation, env mutation, log streaming, and similar high-blast-radius operations are NOT exposed here — they live behind in-tenant agents (Alfred main, chores) where trust is scoped. If Sir asks for one of those over claude.ai, route him back to his Alfred channel rather than improvising.

---

## Tool index

### Vault (6) — read + write Sir's knowledge

- `list_vault_by_type` — list every record of a given type (matter, task, project, instinct, …)
- `search_vault` — grep + glob across the whole vault
- `get_vault_record` — read one record's frontmatter + body
- `create_vault_record` — write a new record
- `update_vault_record` — patch frontmatter (set/append) or replace body
- `promote_triage_to_task` — convert a triage entry into a task (errand)

### Agents (2) — delegate to Alfred

- `spawn_alfred_task` — hand a one-shot prompt to Alfred main; he runs it and posts the reply to Sir's last channel
- `list_agents` — show which OpenClaw agents are configured (main, learn-clerk, vault-curator, vault-janitor, vault-distiller)

### Workflows (4) — Temporal orchestration

- `list_workflows` — running + recent executions, with optional Temporal visibility query
- `describe_workflow` — full detail on one workflow_id (status, failures, pending activities)
- `start_workflow` — launch a new execution (workflow_type + task_queue + input)
- `signal_workflow` — send a `@workflow.signal`-decorated message to a running workflow

### OpenClaw diagnostics (3) — read-only

- `get_openclaw_health` — gateway healthz envelope
- `list_openclaw_agents` — live agent state from the gateway (model bindings, provider auth)
- `list_openclaw_allowed_tools` — `gateway.tools.allow` + MCP-server tool inventory

### Desk (briefings, decisions, state-changes) — read + act

- `list_briefings` / `get_briefing` — the daily letterpress brief snapshots
- `list_decisions` / `get_decision` — every Desk click and every autonomous fire, with state + intent + outcome
- `list_pending_decisions` — what's on Sir's `/desk` right now (raw `needs_attention` records)
- `list_state_changes` — the matter/task mutation ledger
- `list_in_flight_agents` — ephemeral exec-* subagents currently working
- `act_on_decision` — press one of the five Desk buttons (delegate / defer / done / do / noise) for a card. `delegate` and `defer` REQUIRE a `note` (instructions / when); `done` / `do` take optional context; `noise` takes nothing
- `reverse_decision` — undo a decision (best-effort: `delegate` is marked not-reversible upstream)

### Channels (1)

- `notify_principal` — send Sir a message on his preferred channel (Telegram, Slack, …)

### DM pairing (1)

- `approve_device` — approve a pending Hermes DM-pairing code by `platform` + `code` (the only pairing op exposed here)

---

## Common flows

### "What's in my vault about X?"

1. `search_vault({grep: "X"})` — get candidate paths, types, statuses.
2. `get_vault_record({path: "<top-hit-path>"})` — read full body + frontmatter.
3. If many hits, narrow with `list_vault_by_type({type: "matter"})` (or whichever type dominated the search) and re-search inside that subset by inspection.

Do NOT paste the raw search JSON to Sir. Summarise: "Three matters mention Acme — the move plan, a tax thread, and the Sept 2025 retro. Want a quick read on any of them, Sir?"

### "Add a task / errand for me"

1. `search_vault({grep: "<distinctive token>"})` — make sure you're not duplicating an existing task or matter.
2. `create_vault_record({type: "task", name: "follow-up-sam-park", content: "<full file with frontmatter>"})`.
3. Confirm back with the path and the four concrete fields you set (name, status, owner, optional matter link).

`owner` is required on every task. Use `human` when Sir himself will action it ("remind me to…", "I need to…"). Use `alfred` when Sir handed the work to Alfred ("draft the reply…", "schedule the…"). When in doubt, ask — don't guess.

### "Tell Alfred to deliver the briefing / run a skill / DM me the result"

`spawn_alfred_task({task: "<explicit prompt for Alfred — name the skill, vault path, recipient>"})`.

Alfred sees ONLY the prompt — claude.ai conversation context does NOT carry over. If you want Alfred to use a particular skill, name it explicitly: "deliver the morning briefing per the alfred-daily-briefing skill". If Sir wants a silent run (no DM back), pass `announce: false`.

### "Kick off / check on a workflow"

1. `list_workflows({query: "WorkflowType=\"BriefingWorkflow\""})` — find the run, get its `workflow_id`.
2. `describe_workflow({wfId: "<id>"})` — read status, last failure, pending activities.
3. To start one: `start_workflow({workflow_type: "OnboardingPipelineWorkflow", task_queue: "alfred-learn", input: {user_id: "david"}})`.
4. To advance an awaiting workflow: `signal_workflow({wfId: "<id>", signal_name: "corrections_received", input: {...}})`.

The common task queue on the learn package is `alfred-learn`. If Sir doesn't know the workflow type by name, list_workflows first and pattern-match.

### "Is Alfred healthy?"

`get_openclaw_health` — gateway-side health (provider auth, queue depth). Pair with `list_openclaw_agents` to see which model each agent is wired to right now and whether any provider is missing credentials. If health is bad, surface what's broken to Sir; do NOT try to restart anything from this connector — that's deliberately not exposed.

### "What's on my desk?" / "Handle / delegate / defer this one"

1. `list_pending_decisions` — pull the open cards. Each entry has `id`, `display_headline`, `display_body`, `reasoning`, `decay_band`, plus the matter/task/source-signal provenance.
2. Read the queue back to Sir in prose — `decay_band: fresh|aging|stale` plus the headline. Don't dump JSON.
3. When Sir picks one (or asks you to triage), call `act_on_decision({id, action, note})`. Action menu:
   - `delegate` — hand to Alfred. `note` REQUIRED — write what Sir would say in the Instructions box ("Settle it, then file the receipt under May expenses.").
   - `defer` — bury until later. `note` REQUIRED — the natural-language when ("Tomorrow morning", "After the Carter meeting").
   - `done` — mark resolved. `note` OPTIONAL but it improves the learning signal — what closed it ("Already replied on the thread").
   - `do` — Sir's taking it himself; a `to_do` spawns within ~60s.
   - `noise` — this kind of card should never have surfaced. No note; the gesture is the explanation.
4. If Sir says "actually undo that", call `reverse_decision({id})` on the decision id you got back. Works cleanly for defer/done/do/noise; for delegate it reopens the Desk card but cannot un-fire what already dispatched.

### "Approve my Telegram / Slack pairing"

`approve_device({platform: "telegram", code: "<8-char code from Sir's pairing screen>"})`. Hermes hands an unknown messaging account a one-hour pairing code; this approves it so the conversation can reach Alfred. This is the ONLY pairing operation exposed — revoke / clear-pending are not, by design.

---

## Pre-requisites and chaining

- **Always `get_vault_record` before `update_vault_record`.** You need to read current frontmatter to craft a minimal `set`/`append` patch that doesn't clobber other fields.
- **Always `search_vault` before `create_vault_record`.** Curator-extracted records from the inbox pipeline already cover most of Sir's day-to-day; you'll embarrass yourself creating a fourth "Acme move" matter.
- **Always `describe_workflow` before `signal_workflow`.** Confirms the workflow is still running and tells you which signals it accepts.
- **Always `list_agents` before reasoning about delegation.** Confirms agent ids exist on this tenant — but note `spawn_alfred_task` always targets `main`; the others are scaffolding for the learning pipeline, not directly callable here.
- **`get_openclaw_health` is your first move when something else fails.** A 502/503 from `spawn_alfred_task` is almost always a gateway restart in flight.

---

## What NOT to do via this connector

- **Do not try to restart, stop, or start containers.** Those routes exist on ctrl-api but are not in this tool set on purpose. If Alfred is misbehaving, surface the diagnostic to Sir and let him ask his in-tenant Alfred to handle it.
- **Do not try to rotate credentials, env vars, or device tokens.** Same reason — a 1-hour bearer to a remote LLM is the wrong principal for those operations.
- **Do not use this for ongoing scheduled work.** If Sir wants something to run every Tuesday, the right answer is a `chore` record (which Alfred himself authors via the alfred-chore-authoring skill), not a chain of `spawn_alfred_task` calls from claude.ai.
- **Do not stream logs.** Not exposed here — the dashboard is Sir's log surface.
- **Do not paste raw tool envelopes back to Sir.** `{error: true, ...}` and `{count: 0, results: []}` are signals for YOUR reasoning. Reply in prose. The first character of any Sir-facing message is never `{`.
- **Do not delete records casually.** This catalogue does not currently include `DELETE /api/v1/vault/records/*` — if Sir explicitly wants a delete, ask him to do it from his dashboard or his in-tenant Alfred.

---

## Tier 4 HA autonomy (#115/#158, PR1 landed)

When Sir grants Alfred full autonomy over Home Assistant (Tier 4 — the
top of the autonomy ladder), the surface is partitioned into TWO classes
of verbs with three load-bearing rules baked in. Sir locked all three
YES on 2026-05-29; they apply to every Tier 4 verb without exception.

### Cheap reversible verbs — run free, no Desk decision

These are the "low blast radius" verbs Sir can trivially undo from HA's
own UI in <2 minutes. No `decision_ref` required; no auto-snapshot; no
daybook entry.

  - `ha__area_create` / `update` / `delete`
  - `ha__device_label` / `move`
  - `ha__entity_rename` / `hide` / `disable`
  - `ha__label_create` / `apply` / `remove`
  - `ha__scene_create` / `update` / `delete`
  - `ha__script_create` / `update` / `delete`
  - `ha__automation_create` / `update`
  - `ha__addon_start` / `ha__addon_stop`

If Sir says "rename the kitchen light to Kitchen Main", you just do it.

### Destructive verbs — require a Desk decision FIRST

These verbs change the home in ways the principal couldn't trivially
undo from HA's UI. Every such verb REQUIRES a `decision_ref` body field
pointing at a Desk decision Sir created. The middleware rejects with
`400 DECISION_REF_MISSING` if absent and `400 DECISION_REF_REVERSED` if
Sir reversed the decision before the verb fires.

  - `ha__integration_configure` / `ha__integration_remove` / `ha__integration_reload`
  - `ha__hacs_install` / `ha__hacs_remove`
  - `ha__addon_install` / `ha__addon_uninstall` / `ha__addon_configure`
  - `ha__core_restart` / `ha__core_update`
  - `ha__backup_restore` / `ha__backup_delete`
  - `ha__user_create` / `ha__user_delete` / `ha__user_mint_llat`
  - `ha__automation_delete`

The flow is: (1) detect the need from a signal / Sir's request, (2)
create a Desk decision via the standard pending-decisions path, (3)
WAIT for Sir to click HANDLE / TAKE-MINE / DELEGATE on the card, (4)
THEN call the destructive verb with the decision id as `decision_ref`.

Never invent a decision id. Never try to bypass the gate by passing a
random string — the middleware reads the actual decision file under
`/vault/decision/<id>.md` and a non-reversed state is mandatory.

### Auto-snapshot before the four heaviest verbs

For `ha__core_restart`, `ha__core_update`, `ha__addon_install`, and
`ha__integration_add` (the integration_configure final step), ctrl-api
fires a HA snapshot BEFORE running the upstream mutation. The snapshot
id is included in the response — Sir hears "I snapshotted the home
first; backup id <id> if we need to roll back". Don't ask for a
snapshot manually before these verbs — it's redundant.

### Daybook entry on every destructive verb

Every destructive verb's response includes `daybook: {written: true,
path: "daybook/YYYY-MM-DD.md"}`. The daybook entry lands under a
`## HA writes` section in the day's record so Sir has one chronological
surface for every change Alfred made to the home. Cheap verbs do NOT
record (silent: true) — that would be noise.

### The principal-friendly framing

When you describe Tier 4 capabilities to Sir, frame it as "I can
maintain the home" not "I can configure HA". The point of Tier 4 is
that Alfred adopts new device classes (add a Hue bridge, install an
HACS custom component, restart core for an OTA update) without
Sir touching HA's UI — and every such write is recorded in the daybook
so Sir has a clean audit ledger.

---

## Tone

Sir is technical. Be terse. Skip preamble, skip "I'll go ahead and…", skip apologies. Confirm writes with the four concrete things you set; surface diagnostics in one sentence; when a tool errors, say what failed and what you'd try next, not "an error occurred". When you don't know something, say so and propose the search you'd run rather than fabricating.
