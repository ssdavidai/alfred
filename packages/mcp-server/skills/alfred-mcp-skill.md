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

### Home Assistant — Tier 4 (#115 PR3, automations / scenes / scripts CRUD)

- `ha__list_automations_full` — pull the full automation configs (trigger / condition / action), not the slim registry index
- `ha__create_automation` — new automation; no gate (Sir can disable in HA UI)
- `ha__update_automation` — replace existing automation; no gate
- `ha__delete_automation` — GATED: `decision_ref` required (irreversible without backup)
- `ha__create_scene` / `ha__update_scene` / `ha__delete_scene` — scenes are cheap; no gates
- `ha__create_script` / `ha__update_script` / `ha__delete_script` — scripts are cheap; no gates

### Home Assistant — Tier 4 (#115 PR6, Supervisor addons — HAOS only)

- `ha__list_addons` / `ha__addon_info` — read-only; no gate
- `ha__addon_install` — GATED: `decision_ref` REQUIRED; auto-snapshot recorded in `ha_backup_ref`
- `ha__addon_uninstall` — GATED: `decision_ref` REQUIRED; auto-snapshot recorded
- `ha__addon_configure` — GATED: `decision_ref` REQUIRED; no snapshot (options swap is reversible)
- `ha__addon_start` / `ha__addon_stop` / `ha__addon_restart` — no gate (cheap, reversible)
- `ha__addon_update` — GATED: `decision_ref` REQUIRED; auto-snapshot recorded
- `ha__addon_logs` — read-only; default tail 200, max 2000

**HAOS caveat.** Every addon tool returns a 501 envelope on non-HAOS installs: `{error: "supervisor_not_available", installation_type, message}`. Read `installation_type` and explain to Sir; don't retry. Sir's home (home.alfred.black) is HAOS so this surface is live there.

### Home Assistant — Tier 4 (#115 PR7, HA core lifecycle + backups)

- `ha__core_version` — read `ha_version` + `installation_type`; no gate
- `ha__core_check_config` — verify configuration.yaml parses (run before restart); no gate
- `ha__core_reload_yaml` — reload every YAML domain without restarting; no gate
- `ha__core_restart` — GATED: `decision_ref` REQUIRED; auto-snapshot recorded in `ha_backup_ref`; HA OFFLINE 30-120s
- `ha__core_update` — GATED: `decision_ref` REQUIRED; auto-snapshot recorded; optional `version` pin; HA OFFLINE 3-10 min
- `ha__list_backups` — every backup HA knows about; no gate
- `ha__backup_info` — full details for one backup; no gate
- `ha__create_backup` — generate a fresh backup; no gate (this IS a backup; `ha_backup_ref` row gets `triggered_by='user'`)
- `ha__delete_backup` — GATED: `decision_ref` REQUIRED; daybook entry recorded; irreversible
- `ha__restore_backup` — GATED: `decision_ref` REQUIRED; NO snapshot (restoring IS the recovery); HA OFFLINE several minutes

### Home Assistant — Tier 4 (#115 PR4, Integrations — config_flow CRUD)

- `ha__list_integrations` / `ha__integration_info` — read-only; rows carry an `alfred` audit block (`installed_by`, `decision_ref`, `installed_at`, `removed_at`)
- `ha__list_available_integrations` — list every domain HA can install (`get_handlers`); no gate
- `ha__integration_discover` — kick off a config_flow for a domain; returns `flow_id` + first step descriptor; NO gate (inspection)
- `ha__integration_configure` — advance one step of a flow; GATED: `decision_ref` REQUIRED; AUTO-SNAPSHOT before every step
- `ha__integration_reload` — re-init an installed config_entry; no gate (reversible)
- `ha__integration_remove` — uninstall an integration; GATED: `decision_ref` REQUIRED; AUTO-SNAPSHOT; soft-deletes the `ha_integration_ref` row (stamps `removed_at`, keeps audit trail)

**Multi-step flow contract.** HA integrations are never one-shot. `ha__integration_discover` returns a `flow_id`; the agent calls `ha__integration_configure(flow_id, data, decision_ref)` repeatedly until the response's `step.type` reaches a terminal state. See the recipe section below for the full walk-through.

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

### "Author a bedtime scene" / "Set up a sunrise automation"

The tier-4 surface (#115 PR3) lets Alfred CRUD HA automations / scenes / scripts directly — no Sir-side clicking through HA's UI. Two example flows:

**Bedtime scene from a Desk observation:**
1. `ha__list_areas` — confirm the bedroom area_id.
2. `ha__list_entities({area: "bedroom"})` — read the bedroom lights / climate entities.
3. `ha__create_scene({name: "Bedtime", entities: {"light.bedroom_main": {state: "on", brightness_pct: 15}, "light.living_room_lamp": {state: "off"}, "climate.bedroom": {temperature: 19}}, icon: "mdi:weather-night"})`.
4. Confirm to Sir: "Scene created — `scene.bedtime`. Triggering it dims the bedroom to 15%, turns off the lamp, sets the thermostat to 19°."

**Sunrise automation from an observation Sir approved:**
1. `ha__list_automations_full` — make sure there isn't already a sunrise automation (don't double-up).
2. `ha__create_automation({alias: "Lights off at sunrise", trigger: {platform: "sun", event: "sunrise"}, action: {service: "light.turn_off", target: {area_id: "living_room"}}, description: "Created by Alfred — observation 2026-05-29 a.m."})`.
3. The automation is created in the OFF state by default — confirm with Sir before flipping `initial_state: "on"`.

**Removing a stale automation (GATED):**
1. `ha__list_automations_full` — read its YAML first, store a backup in a `decision/` vault record if Sir might want it back.
2. `ha__delete_automation({automation_id: "old_routine", decision_ref: "decision/2026-05-29-drop-old-routine.md"})`. `decision_ref` is REQUIRED — Alfred refuses without it.

### "Install / configure / update a Home Assistant addon" (Tier 4 — HAOS only, #115 PR6)

The PR6 surface lets Alfred drive HA's Supervisor addons: `ha__list_addons`, `ha__addon_info`, `ha__addon_install`, `ha__addon_uninstall`, `ha__addon_configure`, `ha__addon_start`, `ha__addon_stop`, `ha__addon_restart`, `ha__addon_update`, `ha__addon_logs`.

**The HAOS caveat.** Supervisor addons only exist on Home Assistant Operating System. On Container HA, Core HA, and Supervised installations every addon tool returns a 501 envelope:

```json
{
  "error": "supervisor_not_available",
  "installation_type": "Home Assistant Container",
  "message": "Supervisor addons require Home Assistant OS. Detected: Home Assistant Container."
}
```

Read the `installation_type` and explain to Sir — don't retry. Sir's home (home.alfred.black) is HAOS so this surface is live there.

**Gates + snapshots (locked YES on 2026-05-29).** `install` / `uninstall` / `configure` / `update` require a `decision_ref`. `install` / `uninstall` / `update` also auto-snapshot — ctrl-api records the intent in `ha_backup_ref` BEFORE the upstream call, and the success envelope carries `backup_ref_id` and `ha_backup_id`. Mention "snapshot taken" to Sir in your reply.

**Recipe — install Mosquitto on Sir's HAOS:**

1. `ha__list_addons` — confirm Mosquitto isn't already installed; find the right slug (e.g. `core_mosquitto`).
2. Create a `decision/` record naming the intent ("install Mosquitto for the Zigbee2MQTT pipeline").
3. `ha__addon_install({slug: "core_mosquitto", decision_ref: "decision/2026-05-29-mosquitto.md"})`.
4. `ha__addon_info({slug: "core_mosquitto"})` — read the schema, build the options.
5. `ha__addon_configure({slug, options, decision_ref})` — apply the options.
6. `ha__addon_start({slug: "core_mosquitto"})` — Supervisor doesn't always auto-start after install.
7. `ha__addon_logs({slug: "core_mosquitto", tail: 50})` — confirm it came up.

**Recipe — update an addon:**

1. `ha__addon_info({slug})` — read `version` vs `version_latest`. If they match, tell Sir and stop.
2. Create a `decision/` record naming the version delta.
3. `ha__addon_update({slug, decision_ref})` — snapshot taken before the upstream call.
4. `ha__addon_logs({slug, tail: 100})` after Supervisor reports done — confirm no startup errors.

### "Restart / update HA core" / "Back up before something risky" (Tier 4, #115 PR7)

The PR7 surface gives Alfred HA's core lifecycle + backup CRUD: `ha__core_version`, `ha__core_check_config`, `ha__core_reload_yaml`, `ha__core_restart`, `ha__core_update`, `ha__list_backups`, `ha__backup_info`, `ha__create_backup`, `ha__delete_backup`, `ha__restore_backup`.

**Gates + snapshots (locked YES on 2026-05-29).** `core/restart` + `core/update` + `delete_backup` + `restore_backup` all require a `decision_ref`. `core/restart` + `core/update` also auto-snapshot — ctrl-api triggers a real `backup/generate` BEFORE the destructive call and records the result in `ha_backup_ref`. The success envelope returns `backup_ref_id`, `ha_backup_id`, and `backup_name`. Mention "snapshot taken" to Sir. `restore_backup` is the only destructive verb that does NOT auto-snapshot — restoring IS the recovery action; backing up the broken state is backwards.

**Recipe — restart HA core safely:**

1. `ha__core_check_config({})` — never restart on a broken config; this catches yaml parse errors before HA goes down.
2. If the config check returns warnings/errors, surface them to Sir and stop. Don't restart.
3. Create a `decision/` record naming why ("restart to pick up new ESPHome device").
4. `ha__core_restart({decision_ref: "decision/..."})` — snapshot taken; HA reboots; reply carries `backup_name`.
5. Wait ~60s, then `ha__core_version({})` to confirm HA came back.

**Recipe — update HA core to the latest stable:**

1. `ha__core_version({})` — read the current version, surface it to Sir.
2. Sir confirms the update. Create a `decision/` record naming the version delta if known.
3. `ha__core_update({decision_ref: "decision/..."})` — omit `version` for the latest stable, or pass `version: "2025.7.0"` to pin. Snapshot taken before HA goes down.
4. HA is OFFLINE for 3-10 min. Wait, then `ha__core_version({})` to confirm.
5. If the update failed (Sir reports HA didn't come back): `ha__list_backups({})` → find the `alfred-pre-ha__core_update-*` snapshot → `ha__restore_backup({backup_id, decision_ref})`.

**Recipe — explicit backup before a risky non-Alfred change:**

Sir says "I'm about to flash my Z-Wave dongle, back HA up first" — Alfred can do this without a gated verb because creating a backup is always safe.

1. `ha__create_backup({name: "alfred-pre-zwave-fw-2026-05-29"})` — name it contextually so Sir can find it later.
2. ctrl-api records a `ha_backup_ref` row with `triggered_by='user'`; the response carries the new `ha_backup_id`.
3. If something goes wrong later: `ha__restore_backup({backup_id, decision_ref})`.

**Recipe — restore from a backup (irreversible, HA-stops-for-several-minutes):**

1. `ha__list_backups({})` — find the right slug. Pick the most recent backup BEFORE the change Sir wants to undo.
2. `ha__backup_info({backup_id})` — confirm the backup includes the components Sir needs (addons / database / homeassistant / folders).
3. Create a `decision/` record explaining why the restore is happening.
4. `ha__restore_backup({backup_id, decision_ref})` — HA stops, unpacks the backup, restarts. State + automations + addons revert to the backup's snapshot point.
5. Wait several minutes, then `ha__core_version({})` to confirm HA is back. If the backup was encrypted, pass `password`.

**Audit query — "what backed up my system the last 30 days":**

ctrl-api exposes a ledger view at `GET /api/v1/channels/ha/backups/ledger?days=30` that reads `ha_backup_ref` directly — every Alfred-triggered snapshot, every Alfred-initiated user backup, plus future strategy-auto rows. The `triggered_by` column distinguishes `ha__core_restart` / `ha__core_update` (auto-snapshot before another verb), `user` (explicit user-initiated create), and `strategy:auto` (HA's scheduled backup strategy). Models don't need to call this directly — the dashboard / Desk surfaces it — but knowing it exists is useful when Sir asks "what's been backed up?".

### "Install / remove / reload a Home Assistant integration" (Tier 4 — #115 PR4)

The PR4 surface lets Alfred drive HA's `config_flow` API end-to-end: pick a domain, walk through whatever steps HA returns (form fields, "press the button" progress, OAuth external_step), and land on a completed `config_entry`. Every successful install writes a `ha_integration_ref` row so the Desk can render "the 3 integrations Alfred added this week" separately from what Sir added through HA's UI.

**The multi-step pattern.** Integrations are NEVER one-shot. `ha__integration_discover` returns a `flow_id` + first step; the agent loops on `ha__integration_configure` until the step is terminal:

| `step.type` | Meaning | What the agent does |
|---|---|---|
| `form` | HA wants form values for this step. `step.data_schema` lists fields; `step.errors` (if present) names a prior validation failure. | Fill in values from Sir's request, call `configure` again with `data: {field: value, …}`. |
| `external_step` | HA wants the principal to complete OAuth in a browser. `step.url` is the URL. | Surface the URL to Sir ("open this to finish authenticating with Google"). STOP — there's no `configure` to send until Sir comes back. Use `ha__integration_flow_progress` to poll for the next step. |
| `progress` | HA is doing async work the agent should wait on (e.g. "discovering Hue bridges on the network"). | Wait a few seconds, call `configure` again with empty `data: {}`. |
| `create_entry` | The flow SUCCEEDED. `entry_id` is in the response top-level AND inside `step.result.entry_id`. | Surface "installed — the {title} integration is now live". `ha_integration_ref` is already stamped; the daybook is already written. |
| `abort` | The flow FAILED. `step.reason` is the machine-readable reason (e.g. `already_configured` / `cannot_connect`). | Surface the reason to Sir and ask what to do next. The daybook records the attempt; no `ha_integration_ref` row is written. |

**Recipe — install Hue with bridge IP 192.168.1.42 on Sir's home:**

1. `ha__list_available_integrations()` — confirm `hue` is in `handlers`.
2. Create a `decision/` record: e.g. `decision/2026-05-29-hue-install.md` describing the install.
3. `ha__integration_discover({domain: "hue"})` → `{flow_id: "abc123", step: {type: "form", data_schema: [{name: "host"}]}}`
4. `ha__integration_configure({flow_id: "abc123", data: {host: "192.168.1.42"}, decision_ref: "decision/2026-05-29-hue-install.md"})` → `{step: {type: "form", step_id: "link"}}` — HA wants Sir to press the bridge button.
5. Surface to Sir: "Sir, please press the round button on top of the Hue bridge, then say go."
6. When Sir says go: `ha__integration_configure({flow_id: "abc123", data: {}, decision_ref})` → `{entry_id: "01JC…", step: {type: "create_entry", result: {entry_id: "01JC…", title: "Hue Bridge 1"}}}`. Done — surface "installed, Sir; the Hue Bridge 1 integration is live (snapshot taken)".

**Recipe — remove a half-broken integration:**

1. `ha__list_integrations()` → find the entry_id and confirm Sir really wants THIS one (entry titles can be confusingly similar: "Hue Bridge 1" vs "Hue Bridge 2").
2. `ha__integration_info({entry_id})` — read the current state. If state is `failed_setup`, consider `ha__integration_reload` first (no gate, often fixes transient failures without uninstalling).
3. Create a `decision/` record for the removal.
4. `ha__integration_remove({entry_id, decision_ref})` — snapshot taken before the upstream call; `ha_integration_ref` is soft-deleted (the audit trail "Alfred installed and then removed this" survives).

**Recipe — reload after a config tweak:**

1. `ha__integration_info({entry_id})` — confirm the entry's `source` and `state`.
2. `ha__integration_reload({entry_id})` — no gate; HA either brings the integration back up or moves it to `failed_setup` (both fixable from there).

**What NOT to do:**

- DON'T poll `ha__integration_configure` with the same `data` over and over to "force" a step — HA's flow state machine doesn't work that way. If you get a `form` back twice, read the `errors` field; if it's empty, the prior submission was incomplete (some `data_schema` field was missing).
- DON'T construct a `decision_ref` from thin air on a step that follows a `form` step. Re-use the SAME `decision_ref` across all steps of one flow — they're all the same install.
- DON'T retry on `abort` — surface the reason to Sir, who decides whether to restart the flow with different inputs.

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

  - `ha__integration_configure` / `ha__integration_remove` (reload is gateless — see Tier 4 PR4 above)
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
