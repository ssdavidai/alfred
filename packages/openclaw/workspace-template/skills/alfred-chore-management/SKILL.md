---
name: alfred-chore-management
description: Inspect, trigger, pause, and reason about Sir's scheduled chores. Chores are recurring Temporal workflows with bespoke Python code generated during onboarding. Use whenever Sir asks about what's running on a schedule, wants to manually trigger a chore, pause/unpause one, or check why a chore hasn't produced results.
version: "1.0"
metadata:
  openclaw:
    emoji: "⏰"
---

# Alfred — Chore Management

Chores are Sir's recurring background workflows. Each one is a bespoke Python Temporal workflow generated during onboarding based on Sir's goals, matters, and data sources. They live in the vault as `chore/` records with `generated: true` and a corresponding `.py` file in `/alfred-data/user-chores/`.

## Two layers to a chore

1. **Vault record** (`chore/<slug>.md`) — the user-facing configuration: name, schedule, status, description, run log, quarantine state.
2. **Temporal schedule** — the actual recurring invocation, registered with Temporal. Its ID is `chore-<slug>`.

Both layers must stay in sync. The `ctrl_schedules_*` tools manipulate the Temporal side; the `ctrl_vault_*` tools read the vault side.

## Tools available to you

### Read

- **`ctrl_vault_list`** `type=chore` — list all chore records, with frontmatter (name, schedule, status, template, quarantine, last_run).
- **`ctrl_vault_read`** `{path}` — read the full chore body, which includes the run log and generated description.
- **`ctrl_schedules_list`** — list all Temporal schedules on the tenant. Cross-reference with vault records to spot orphans.

### Act

- **`ctrl_schedules_trigger`** `{schId}` — manually fire a chore once, out of cycle. Returns a workflow execution id. Use when Sir says "run the cashflow forecast now".
- **`ctrl_schedules_pause`** `{schId}` — pause a schedule. Its vault record's status should also be flipped to `paused` — use `ctrl_vault_update` afterwards.
- **`ctrl_schedules_unpause`** `{schId}` — resume a paused schedule. Also flip the vault status back to `active`.

### Related tools

- **`ctrl_workflows_list`** — find recently executed workflow runs, including chore runs. Use to answer "did the Monday digest run?".
- **`ctrl_workflows_get`** `{wfId}` — inspect a specific workflow execution. Shows activities, results, failures.

## Chore anatomy (what to tell Sir if he asks)

Each chore record frontmatter has:
- `name` — human-readable label
- `template` — the generated Python module name (e.g. `tuesday_cash_flow_forecast`)
- `workflow_class_name` — the Python class (e.g. `TuesdayCashFlowForecastWorkflow`)
- `schedule` — cron expression (e.g. `0 18 * * 2` = every Tuesday 18:00)
- `schedule_id` — Temporal schedule id, prefixed `chore-`
- `status` — `active` | `paused` | `completed`
- `generated: true` — every chore on a user tenant is generated; no stock templates
- `quarantine: true, quarantine_remaining: N` — new chores run in dry-run mode for 3 cycles before going live
- `last_run` — ISO timestamp of most recent successful run
- `user_facing_description` — a plain-English paragraph describing what it does

The body of the record has a `## Run log` section with entries like `- 2026-04-09T18:00:00.000Z: [dry-run] 0 anomalies`.

## Quarantine explained

When onboarding generates a new chore template, the first 3 scheduled runs are marked `[dry-run]`:
- Dry-run: the workflow executes the detection phase but skips notifications + vault writes.
- If all 3 dry-runs complete without error, quarantine clears automatically and the chore goes live.
- If any dry-run errors, the chore is paused pending review.
- If Sir wants to shorten or skip quarantine for a known-good chore, update `quarantine_remaining` via `ctrl_vault_update`.

## Good behavior

1. **Always cross-reference vault and Temporal.** Before reporting a chore's status, check both `ctrl_vault_list type=chore` (for the frontmatter) AND `ctrl_schedules_list` (for the Temporal reality). Divergence means a bug.
2. **Manual triggers are non-destructive** if the chore is in dry-run mode; noisy if live. Confirm with Sir before triggering a live chore if it sends notifications.
3. **Never delete a chore file without also removing its Temporal schedule.** The `delete_chore` API handles both; doing it piecemeal via `ctrl_vault_delete` leaves an orphaned schedule that fires forever.
4. **Pause > delete.** If Sir wants a chore "off", prefer pausing. It preserves run history and lets him turn it back on later.

## Examples

**Sir: "What chores do I have?"**
→ `ctrl_vault_list type=chore` → group by status, show name + schedule + last_run for each.

**Sir: "Run the weekly matter digest for NeoTerra now."**
→ `ctrl_vault_search query="NeoTerra" type=chore` → confirm schedule_id → `ctrl_schedules_trigger` → report the workflow execution id and expected completion window.

**Sir: "Pause the gym nudge until next month."**
→ `ctrl_schedules_pause schId=chore-gym-and-health-check-in` → `ctrl_vault_update path=chore/gym-and-health-check-in.md set={status: paused, paused_until: "2026-05-01"}`.

**Sir: "Did the Monday digest fire this week?"**
→ `ctrl_workflows_list` filter by type `WeeklyMatterDigestWorkflow` → or read the chore record's run log section.
