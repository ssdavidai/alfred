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

Both layers must stay in sync. Use the `ctrl` tool to query both sides.

## Endpoints for chore management

### Read

- **`ctrl endpoint="/api/v1/chores"`** — list all chore records, with frontmatter (name, schedule, status, template, quarantine, last_run).
- **`ctrl endpoint="/api/v1/chores/{slug}"`** — read the full chore body, including run log and generated description.
- **`ctrl endpoint="/api/v1/chores/{slug}/source"`** — full generated Python source + dependency audit.
- **`ctrl endpoint="/api/v1/schedules"`** — list all Temporal schedules. Cross-reference with vault records to spot orphans.

### Act

- **`ctrl endpoint="/api/v1/chores/{slug}/trigger" method="POST"`** — manually fire a chore once, out of cycle. Use when Sir says "run the cashflow forecast now".
- **`ctrl endpoint="/api/v1/chores/{slug}/pause" method="POST"`** — pause a chore (both vault record and Temporal schedule).
- **`ctrl endpoint="/api/v1/chores/{slug}/resume" method="POST"`** — resume a paused chore.
- **`ctrl endpoint="/api/v1/chores/{slug}" method="DELETE"`** — remove a chore and its schedule.

### Related

- **`ctrl endpoint="/api/v1/workflows"`** — find recently executed workflow runs, including chore runs.
- **`ctrl endpoint="/api/v1/workflows/{wfId}"`** — inspect a specific workflow execution.

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

1. **Always cross-reference chore record and schedule.** Before reporting a chore's status, check both `ctrl endpoint="/api/v1/chores"` (vault) AND `ctrl endpoint="/api/v1/schedules"` (Temporal). Divergence means a bug.
2. **Manual triggers are non-destructive** if the chore is in dry-run mode; noisy if live. Confirm with Sir before triggering a live chore.
3. **Use the chore API for delete** — `ctrl endpoint="/api/v1/chores/{slug}" method="DELETE"` handles both vault record and Temporal schedule cleanup.
4. **Pause > delete.** If Sir wants a chore "off", prefer pausing. It preserves run history.

## Examples

**Sir: "What chores do I have?"**
→ `ctrl endpoint="/api/v1/chores"` → group by status, show name + schedule + last_run for each.

**Sir: "Run the weekly matter digest for NeoTerra now."**
→ `ctrl endpoint="/api/v1/vault/search" query={"grep": "NeoTerra", "type": "chore"}` → confirm slug → `ctrl endpoint="/api/v1/chores/{slug}/trigger" method="POST"`.

**Sir: "Pause the gym nudge until next month."**
→ `ctrl endpoint="/api/v1/chores/gym-and-health-check-in/pause" method="POST"`.

**Sir: "Did the Monday digest fire this week?"**
→ `ctrl endpoint="/api/v1/workflows"` → filter by type → or read the chore record's run log section.
