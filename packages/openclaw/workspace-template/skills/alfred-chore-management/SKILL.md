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

Both layers must stay in sync. Use the `self` MCP tool to query both sides.

## Endpoints for chore management

### Read

- **`self endpoint="/api/v1/chores"`** — list all chore records, with frontmatter (name, schedule, status, template, quarantine, last_run).
- **`self endpoint="/api/v1/chores/{slug}"`** — read the full chore body, including run log and generated description.
- **`self endpoint="/api/v1/chores/{slug}/source"`** — full generated Python source + dependency audit.
- **`self endpoint="/api/v1/schedules"`** — list all Temporal schedules. Cross-reference with vault records to spot orphans.

### Act

- **`self endpoint="/api/v1/chores" method="POST"`** — create a new chore from scratch. See "Creating a chore" below.
- **`self endpoint="/api/v1/chores/{slug}/trigger" method="POST"`** — manually fire a chore once, out of cycle. Use when Sir says "run the cashflow forecast now".
- **`self endpoint="/api/v1/chores/{slug}/pause" method="POST"`** — pause a chore (both vault record and Temporal schedule).
- **`self endpoint="/api/v1/chores/{slug}/resume" method="POST"`** — resume a paused chore.
- **`self endpoint="/api/v1/chores/{slug}" method="DELETE"`** — remove a chore and its schedule.

## Creating a chore

When Sir asks for a new recurring job ("every morning, tell me what happened overnight", "every Friday summarize the week"), you are expected to design and install it yourself via `POST /api/v1/chores`.

### Body shape

```
{
  "slug": "daily-morning-briefing",            // kebab-case, unique
  "workflow_class_name": "DailyBriefingWorkflow",
  "python_source": "<full .py file>",
  "schedule": "30 4 * * *",                     // 5-field cron
  "name": "Daily morning briefing",            // optional
  "user_facing_description": "...",            // optional, shown in dashboard
  "params": { "preview_only": false },         // optional; chore_slug is auto-added
  "tags": ["morning", "digest"],                // optional
  "overlap_policy": "Skip",                    // optional, default "Skip"
  "restart_worker": true                       // optional, default true
}
```

The endpoint writes three things atomically: the `.py` file under `/alfred-data/user-chores/`, the `chore/<slug>.md` vault record, and the Temporal schedule `chore-<slug>`. On failure it rolls back so you never end up with partial state.

### The decision: which activities to compose

A chore's workflow is a sequence of `workflow.execute_activity(<name>, ...)` calls. The dynamic-loader validator REQUIRES that every `<name>` was imported from `src.activities.chore_actions` (or `src.workflows.chores._base`). You cannot call arbitrary Python, and you cannot inline HTTP calls, LLM calls, or filesystem reads at workflow scope — all that work happens inside activities.

**Activities split into three families:**

1. **Data activities** (`llm: false`) — read/write vault, fetch events, diff snapshots, filter, save. Fast, deterministic. Use these for everything whose output is a pure function of its input.
2. **LLM-bearing activities** (`llm: true`) — internally spawn an openclaw-workers subagent on `grok-4.1-fast` to produce prose or judgement. Examples: `write_matter_digest_via_llm`, `ask_alfred_to_judge_anomalies`, `build_daily_briefing_v2`. Use these for anything that needs "decide what matters" or "write this as a paragraph".
3. **Notification activities** — `send_chore_notification` delivers a formatted message to Sir's main session.

**Rule of thumb:** if the step's output can be described as "return this structured data", compose from data activities. If it's "return some prose", use an LLM-bearing activity. If the LLM-bearing activity you need doesn't exist yet, that's platform work — tell Sir "I can sketch this chore, but the step that needs reasoning requires a new `chore_actions` activity. Want me to open an issue for it?"

Fetch the full list with `self endpoint="/api/v1/chore-actions"` before writing Python — it returns every allowed activity plus its `reads`/`writes`/`llm`/`required_data` metadata. If you reference an activity not in the manifest, validation will reject the source.

### Writing the Python source

The validator enforces:
1. Size < 100KB, valid Python syntax.
2. Only imports from: `__future__`, `dataclasses`, `datetime`, `typing`, `json`, `temporalio.workflow`, `temporalio.common`, `src.workflows.chores._base`, `src.activities.chore_actions`.
3. Module scope: only class defs, function defs, imports, one docstring, `with workflow.unsafe.imports_passed_through():`, and literal constants.
4. Exactly one `@workflow.defn` class with exactly one `@workflow.run` method.
5. No forbidden names: `eval`, `exec`, `open`, `compile`, `__import__`, `getattr`/`setattr`/`delattr`, `globals`/`locals`, `vars`, `dir`, `breakpoint`.
6. No non-deterministic calls at workflow scope: `datetime.now`, `random.*`, `uuid.*`, `time.time`.
7. Every `workflow.execute_activity(<name>, ...)` must reference a name imported from the two allowed modules.

Before submitting, sanity-check the `chore_actions` manifest: `self endpoint="/api/v1/chore-actions"` returns every activity name you're allowed to import plus its `reads`/`writes`/`llm` metadata. If the activity you need isn't in the manifest, you can't use it — fall back to a subagent step or propose a new activity to Sir for platform work.

### After creation

- `restart_worker: true` (the default) triggers an alfred-learn restart so the dynamic loader picks up the new template. The first scheduled run then fires normally. If the restart is rate-limited (429), the response includes a `restart_error` and you must call `self endpoint="/api/v1/admin/restart-learn" method="POST"` manually before the first cron tick.
- New chores start with `quarantine: false` — they run live from the first tick. (Onboarding-generated chores go through 3 dry-runs because they're bulk-generated; chores you create on request have been consciously authored, so we skip quarantine.)
- Fire one real run via `self endpoint="/api/v1/chores/{slug}/trigger" method="POST"` to verify before the first scheduled tick.

### Related

- **`self endpoint="/api/v1/workflows"`** — find recently executed workflow runs, including chore runs.
- **`self endpoint="/api/v1/workflows/{wfId}"`** — inspect a specific workflow execution.

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
- If Sir wants to shorten or skip quarantine for a known-good chore, update `quarantine_remaining` via `self endpoint="/api/v1/vault/records/chore/<slug>.md" method="PATCH" body={"set":{"quarantine_remaining":0}}`.

## Good behavior

1. **Always cross-reference chore record and schedule.** Before reporting a chore's status, check both `self endpoint="/api/v1/chores"` (vault) AND `self endpoint="/api/v1/schedules"` (Temporal). Divergence means a bug.
2. **Manual triggers are non-destructive** if the chore is in dry-run mode; noisy if live. Confirm with Sir before triggering a live chore.
3. **Use the chore API for delete** — `self endpoint="/api/v1/chores/{slug}" method="DELETE"` handles both vault record and Temporal schedule cleanup.
4. **Pause > delete.** If Sir wants a chore "off", prefer pausing. It preserves run history.

## Examples

**Sir: "What chores do I have?"**
→ `self endpoint="/api/v1/chores"` → group by status, show name + schedule + last_run for each.

**Sir: "Run the weekly matter digest for NeoTerra now."**
→ `self endpoint="/api/v1/vault/search" query={"grep": "NeoTerra", "type": "chore"}` → confirm slug → `self endpoint="/api/v1/chores/{slug}/trigger" method="POST"`.

**Sir: "Pause the gym nudge until next month."**
→ `self endpoint="/api/v1/chores/gym-and-health-check-in/pause" method="POST"`.

**Sir: "Did the Monday digest fire this week?"**
→ `self endpoint="/api/v1/workflows"` → filter by type → or read the chore record's run log section.
